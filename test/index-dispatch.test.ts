/**
 * Thin integration test for the `session_before_compact` handler dispatch.
 *
 * Instantiates a minimal in-process `pi` event bus, registers our handler
 * via the extension factory's default export, and fires a `session_before_compact`
 * event to verify the return-shape contract:
 *
 *   - `mode: "deterministic"` → returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`
 *   - `mode: "llm-only-with-dump"` → returns `undefined` (pi default summarizer runs)
 *   - `mode: "hybrid"` + tool-dense cluster → deterministic branch
 *   - `mode: "hybrid"` + chatty cluster → fall-through
 *
 * Source: pi-mono@v0.75.5 `SessionBeforeCompactResult` shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import factory from "../index.ts";

interface FakePi {
	handlers: Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>;
	on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void;
	fire: (name: string, event: unknown, ctx: unknown) => Promise<unknown[]>;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
	return {
		handlers,
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		async fire(name, event, ctx) {
			const list = handlers.get(name) ?? [];
			const out: unknown[] = [];
			for (const h of list) out.push(await h(event, ctx));
			return out;
		},
	};
}

function user(text: string): unknown {
	return { role: "user", content: text, timestamp: 1 };
}
function asstTool(name: string, id: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		provider: "anthropic",
		model: "x",
		timestamp: 2,
	};
}
function toolRes(name: string, id: string): unknown {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 3,
	};
}
function asstText(text: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		provider: "anthropic",
		model: "x",
		timestamp: 2,
	};
}

function makeFileOps() {
	return { read: new Set<string>(["src/a.ts"]), written: new Set<string>(), edited: new Set<string>() };
}

function makeEvent(messages: unknown[], opts: { customInstructions?: string } = {}): unknown {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "entry-42",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			previousSummary: undefined,
			fileOps: makeFileOps(),
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		branchEntries: [],
		customInstructions: opts.customInstructions,
		signal: new AbortController().signal,
	};
}

async function withCwd<T>(modeSettings: Record<string, unknown>, fn: (cwd: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(join((await import("node:os")).tmpdir(), "compopt-dispatch-"));
	const piDir = join(root, ".pi");
	await fs.mkdir(piDir, { recursive: true });
	await fs.writeFile(
		join(piDir, "settings.json"),
		JSON.stringify({ extensionSettings: { compactionOptimizer: modeSettings } }),
	);
	try {
		return await fn(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function makeCtx(cwd: string): unknown {
	return {
		cwd,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => "dispatch-sess", isPersisted: () => false },
		signal: undefined,
	};
}

test("dispatch: mode=deterministic returns { compaction: ... } with mirrored details", async () => {
	await withCwd({ mode: "deterministic" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const event = makeEvent([
			user("do work"),
			asstTool("bash", "tc1"),
			toolRes("bash", "tc1"),
			asstTool("bash", "tc2"),
			toolRes("bash", "tc2"),
		]);
		const [result] = await pi.fire("session_before_compact", event, makeCtx(cwd));
		assert.ok(result, "expected a return value");
		const r = result as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: Record<string, unknown> } };
		assert.ok(r.compaction, "expected compaction key");
		assert.equal(r.compaction.firstKeptEntryId, "entry-42");
		assert.equal(r.compaction.tokensBefore, 1234);
		assert.match(r.compaction.summary, /## Goal/);
		assert.match(r.compaction.summary, /generated_by: compaction-optimizer \(deterministic\)/);
		assert.equal(r.compaction.details.generatedBy, "compaction-optimizer");
		assert.equal(r.compaction.details.mode, "deterministic");
		assert.deepEqual(r.compaction.details.readFiles, ["src/a.ts"]);
	});
});

test("dispatch: mode=llm-only-with-dump returns undefined (pi default summarizer runs)", async () => {
	await withCwd({ mode: "llm-only-with-dump" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const event = makeEvent([user("hi")]);
		const [result] = await pi.fire("session_before_compact", event, makeCtx(cwd));
		assert.equal(result, undefined);
	});
});

test("dispatch: mode=hybrid + tool-dense cluster → deterministic branch", async () => {
	await withCwd({ mode: "hybrid" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const msgs: unknown[] = [user("work")];
		for (let i = 0; i < 4; i++) {
			msgs.push(asstTool("bash", `tc${i}`));
			msgs.push(toolRes("bash", `tc${i}`));
		}
		const event = makeEvent(msgs);
		const [result] = await pi.fire("session_before_compact", event, makeCtx(cwd));
		assert.ok(result && (result as { compaction?: unknown }).compaction, "expected deterministic compaction result");
	});
});

test("dispatch: mode=hybrid + chatty cluster → fall-through (undefined)", async () => {
	await withCwd({ mode: "hybrid" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const msgs: unknown[] = [];
		for (let i = 0; i < 10; i++) {
			msgs.push(user(`q${i}`));
			msgs.push(asstText(`a${i}`));
		}
		const event = makeEvent(msgs);
		const [result] = await pi.fire("session_before_compact", event, makeCtx(cwd));
		assert.equal(result, undefined);
	});
});

test("dispatch: mode=hybrid + customInstructions → fall-through (undefined)", async () => {
	await withCwd({ mode: "hybrid" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const msgs: unknown[] = [user("work")];
		for (let i = 0; i < 4; i++) {
			msgs.push(asstTool("bash", `tc${i}`));
			msgs.push(toolRes("bash", `tc${i}`));
		}
		const event = makeEvent(msgs, { customInstructions: "focus on the error path" });
		const [result] = await pi.fire("session_before_compact", event, makeCtx(cwd));
		assert.equal(result, undefined);
	});
});

test("dispatch: mode=deterministic + customInstructions → warning notify + dropped footer", async () => {
	await withCwd({ mode: "deterministic" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const notifications: { msg: string; kind: string }[] = [];
		const ctx = {
			cwd,
			ui: { notify: (msg: string, kind = "info") => notifications.push({ msg, kind }) },
			sessionManager: { getSessionId: () => "drop-sess", isPersisted: () => false },
			signal: undefined,
		};
		const event = makeEvent([user("work"), asstTool("bash", "tc1"), toolRes("bash", "tc1")], {
			customInstructions: "focus on X",
		});
		const [result] = await pi.fire("session_before_compact", event, ctx as never);
		const r = result as { compaction: { summary: string } };
		assert.match(r.compaction.summary, /not honored in deterministic mode/);
		assert.ok(
			notifications.some(
				(n) => n.kind === "warning" && /not honored in deterministic/.test(n.msg),
			),
			`expected dropped-instructions warning notify; got ${JSON.stringify(notifications)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Path-taken notify (#242) — one info-level message per compaction stating
// which dispatch branch ran. Lets operators tell air-gapped from LLM
// fall-through at runtime without grepping the session JSONL.
// ---------------------------------------------------------------------------

function makeCapturingCtx(cwd: string, sessionId: string): {
	ctx: unknown;
	notifications: { msg: string; kind: string }[];
} {
	const notifications: { msg: string; kind: string }[] = [];
	const ctx = {
		cwd,
		ui: { notify: (msg: string, kind = "info") => notifications.push({ msg, kind }) },
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => false },
		signal: undefined,
	};
	return { ctx, notifications };
}

test("path-taken notify (#242): mode=deterministic emits air-gapped info", async () => {
	await withCwd({ mode: "deterministic" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const { ctx, notifications } = makeCapturingCtx(cwd, "notify-det");
		const event = makeEvent([
			user("do work"),
			asstTool("bash", "tc1"),
			toolRes("bash", "tc1"),
		]);
		await pi.fire("session_before_compact", event, ctx as never);
		const hit = notifications.find(
			(n) => n.kind === "info" && /air-gapped deterministic summary/.test(n.msg),
		);
		assert.ok(hit, `expected air-gapped info notify; got ${JSON.stringify(notifications)}`);
		assert.match(hit.msg, /mode=deterministic/);
		// tokensBefore=1234 from makeEvent, no `~` prefix because pi-provided.
		assert.match(hit.msg, /1234 tokens/);
		assert.ok(!/~\d+ tokens/.test(hit.msg), "should not mark tokens as estimated when pi provides them");
	});
});

test("path-taken notify (#242): mode=hybrid + tool-dense → air-gapped info", async () => {
	await withCwd({ mode: "hybrid" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const { ctx, notifications } = makeCapturingCtx(cwd, "notify-hyb-det");
		const msgs: unknown[] = [user("work")];
		for (let i = 0; i < 4; i++) {
			msgs.push(asstTool("bash", `tc${i}`));
			msgs.push(toolRes("bash", `tc${i}`));
		}
		await pi.fire("session_before_compact", makeEvent(msgs), ctx as never);
		const hit = notifications.find(
			(n) => n.kind === "info" && /air-gapped deterministic summary/.test(n.msg),
		);
		assert.ok(hit, `expected air-gapped info notify; got ${JSON.stringify(notifications)}`);
		assert.match(hit.msg, /mode=hybrid/);
	});
});

test("path-taken notify (#242): mode=hybrid + chatty → fall-through info w/ reason", async () => {
	await withCwd({ mode: "hybrid" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const { ctx, notifications } = makeCapturingCtx(cwd, "notify-hyb-ft");
		const msgs: unknown[] = [];
		for (let i = 0; i < 10; i++) {
			msgs.push(user(`q${i}`));
			msgs.push(asstText(`a${i}`));
		}
		await pi.fire("session_before_compact", makeEvent(msgs), ctx as never);
		const hit = notifications.find(
			(n) => n.kind === "info" && /fell through to pi LLM summarizer/.test(n.msg),
		);
		assert.ok(hit, `expected fall-through info notify; got ${JSON.stringify(notifications)}`);
		assert.match(hit.msg, /mode=hybrid/);
		// One of the stable HybridResult.reason keys must appear.
		assert.match(
			hit.msg,
			/reason=(custom-instructions|too-many-messages|too-many-tokens|tool-call-ratio-low|orphan-assistant-text)/,
		);
	});
});

test("path-taken notify (#242): mode=llm-only-with-dump → deferred info", async () => {
	await withCwd({ mode: "llm-only-with-dump" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const { ctx, notifications } = makeCapturingCtx(cwd, "notify-llm");
		await pi.fire("session_before_compact", makeEvent([user("hi")]), ctx as never);
		const hit = notifications.find(
			(n) => n.kind === "info" && /deferred to pi LLM summarizer/.test(n.msg),
		);
		assert.ok(hit, `expected deferred info notify; got ${JSON.stringify(notifications)}`);
		assert.match(hit.msg, /mode=llm-only-with-dump/);
		assert.match(hit.msg, /archive will capture raw payload/);
	});
});

test("path-taken notify (#242): tokens prefixed with ~ when tokensBefore=0 (estimate fallback)", async () => {
	await withCwd({ mode: "hybrid" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const { ctx, notifications } = makeCapturingCtx(cwd, "notify-est");
		const msgs: unknown[] = [user("work")];
		for (let i = 0; i < 4; i++) {
			msgs.push(asstTool("bash", `tc${i}`));
			msgs.push(toolRes("bash", `tc${i}`));
		}
		const evt = makeEvent(msgs) as { preparation: { tokensBefore: number } };
		evt.preparation.tokensBefore = 0;
		await pi.fire("session_before_compact", evt, ctx as never);
		const hit = notifications.find((n) => n.kind === "info" && /compaction-optimizer:/.test(n.msg));
		assert.ok(hit, `expected path-taken info notify; got ${JSON.stringify(notifications)}`);
		assert.match(hit.msg, /~\d+ tokens/, "tokens must be marked estimated when pi did not provide tokensBefore");
	});
});
