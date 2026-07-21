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
		assert.match(r.compaction.summary, /## User Turns \(verbatim\)/);
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

// ---------------------------------------------------------------------------
// Output-side shrink ladder (#254, ADR-0108)
// ---------------------------------------------------------------------------

/** Tool-dense fixture whose FULL render exceeds ~2000 output tokens but whose
 *  trimmed rungs fit: 40 user turns of ~300 chars interleaved with tool pairs. */
function bigLadderMessages(): unknown[] {
	const msgs: unknown[] = [];
	for (let i = 1; i <= 40; i++) {
		msgs.push(user(`turn-${i} ${"x".repeat(290)}`));
		msgs.push(asstTool("bash", `tc${i}`));
		msgs.push(toolRes("bash", `tc${i}`));
	}
	return msgs;
}

/** Fixture whose STUB render still exceeds ~2000 output tokens: many subagent
 *  verdict rows with long agent names (stub keeps the full verdict table). */
function stubBusterMessages(): unknown[] {
	const msgs: unknown[] = [user("kick off")];
	for (let i = 1; i <= 120; i++) {
		const agent = `agent-${i}-${"n".repeat(120)}`;
		msgs.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `sub${i}`, name: "subagent", arguments: { agent } }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			provider: "anthropic",
			model: "x",
			timestamp: 2,
		});
		msgs.push({
			role: "toolResult",
			toolCallId: `sub${i}`,
			toolName: "subagent",
			content: [{ type: "text", text: "Verdict: PASS" }],
			isError: false,
			timestamp: 3,
		});
	}
	return msgs;
}

test("shrink ladder: over-budget full render shrinks to a fitting rung + rung= notify", async () => {
	await withCwd(
		{ mode: "deterministic", hybrid: { maxOutputTokens: 2000 } },
		async (cwd) => {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx, notifications } = makeCapturingCtx(cwd, "ladder-shrink");
			const [result] = await pi.fire(
				"session_before_compact",
				makeEvent(bigLadderMessages()),
				ctx as never,
			);
			assert.ok(result, "expected a compaction result");
			const r = result as { compaction: { summary: string } };
			assert.ok(
				Math.ceil(r.compaction.summary.length / 4) <= 2000,
				`summary must fit the 2000-token budget; got ~${Math.ceil(r.compaction.summary.length / 4)}`,
			);
			assert.match(r.compaction.summary, /earlier turns elided/);
			const hit = notifications.find(
				(n) => n.kind === "info" && /air-gapped deterministic summary/.test(n.msg),
			);
			assert.ok(hit, `expected deterministic notify; got ${JSON.stringify(notifications)}`);
			assert.match(hit.msg, /rung=shrunk-[a-z-]+/);
		},
	);
});

test("shrink ladder: under-budget render stays at full fidelity (no rung= in notify)", async () => {
	await withCwd({ mode: "deterministic" }, async (cwd) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const { ctx, notifications } = makeCapturingCtx(cwd, "ladder-full");
		const [result] = await pi.fire(
			"session_before_compact",
			makeEvent([user("small"), asstTool("bash", "t1"), toolRes("bash", "t1")]),
			ctx as never,
		);
		assert.ok(result, "expected a compaction result");
		const hit = notifications.find(
			(n) => n.kind === "info" && /air-gapped deterministic summary/.test(n.msg),
		);
		assert.ok(hit);
		assert.ok(!/rung=/.test(hit.msg), `full-fidelity notify must not carry rung=; got ${hit.msg}`);
	});
});

test("shrink ladder: mode=hybrid + stub over budget → undefined + ladder-exhausted notify", async () => {
	await withCwd(
		{ mode: "hybrid", hybrid: { maxOutputTokens: 2000 } },
		async (cwd) => {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx, notifications } = makeCapturingCtx(cwd, "ladder-exhaust-hyb");
			const [result] = await pi.fire(
				"session_before_compact",
				makeEvent(stubBusterMessages()),
				ctx as never,
			);
			assert.equal(result, undefined, "exhausted ladder must fall through to the LLM in hybrid mode");
			const hit = notifications.find(
				(n) => n.kind === "info" && /shrink ladder exhausted at stub rung/.test(n.msg),
			);
			assert.ok(hit, `expected ladder-exhausted notify; got ${JSON.stringify(notifications)}`);
			assert.match(hit.msg, /falling through to pi LLM summarizer/);
		},
	);
});

test("shrink ladder: mode=deterministic + stub over budget → emits stub anyway + warning (air-gap)", async () => {
	await withCwd(
		{ mode: "deterministic", hybrid: { maxOutputTokens: 2000 } },
		async (cwd) => {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx, notifications } = makeCapturingCtx(cwd, "ladder-exhaust-det");
			const [result] = await pi.fire(
				"session_before_compact",
				makeEvent(stubBusterMessages()),
				ctx as never,
			);
			assert.ok(result, "deterministic mode must NEVER fall through to the LLM on budget overrun");
			const r = result as { compaction: { summary: string } };
			assert.match(r.compaction.summary, /\| Agent \| Verdict \|/);
			const warn = notifications.find(
				(n) => n.kind === "warning" && /emitting anyway — no LLM fallback available/.test(n.msg),
			);
			assert.ok(warn, `expected emit-anyway warning; got ${JSON.stringify(notifications)}`);
		},
	);
});

// ---------------------------------------------------------------------------
// When-policy veto + proactive wiring (#677, ADR-0109)
// ---------------------------------------------------------------------------

import * as snapshotStore from "../lib/snapshot.ts";
import * as phase from "../shared/phase-state.ts";

/** Run fn with a hermetic USER-layer settings file (timing.* is user-layer
 *  only, so the project-layer withCwd helper cannot carry it). */
async function withUserTiming<T>(
	timing: Record<string, unknown>,
	fn: (cwd: string) => Promise<T>,
): Promise<T> {
	const os = await import("node:os");
	const root = await fs.mkdtemp(join(os.tmpdir(), "compopt-timing-home-"));
	const agentDir = join(root, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensionSettings: { compactionOptimizer: { mode: "deterministic", timing } },
		}),
	);
	const cwdRoot = join(root, "proj");
	await fs.mkdir(join(cwdRoot, ".pi"), { recursive: true });
	const prevHome = process.env.HOME;
	process.env.HOME = root;
	try {
		return await fn(cwdRoot);
	} finally {
		process.env.HOME = prevHome;
		await fs.rm(root, { recursive: true, force: true });
	}
}

function omlxCtx(cwd: string, sessionId: string) {
	const notifications: { msg: string; kind: string }[] = [];
	const ctx = {
		cwd,
		model: { provider: "omlx", contextWindow: 131072 },
		ui: { notify: (msg: string, kind = "info") => notifications.push({ msg, kind }) },
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => false },
		signal: undefined,
	};
	return { ctx, notifications };
}

function thresholdEvent(messages: unknown[], tokensBefore: number, reason: string): unknown {
	const evt = makeEvent(messages) as { reason?: string; preparation: { tokensBefore: number } };
	evt.reason = reason;
	evt.preparation.tokensBefore = tokensBefore;
	return evt;
}

const TIMING_ON = { enabled: true, providers: ["omlx"] };

test("when-policy: mid-phase threshold fire → {cancel:true}, no snapshot, deferral toast", async () => {
	await withUserTiming(TIMING_ON, async (cwd) => {
		const sessionId = "when-veto";
		phase.clearSession(sessionId);
		phase.subagentStarted(sessionId, "tc-fanout");
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx, notifications } = omlxCtx(cwd, sessionId);
			const [result] = await pi.fire(
				"session_before_compact",
				thresholdEvent([user("work")], 114688, "threshold"),
				ctx as never,
			);
			assert.deepEqual(result, { cancel: true });
			assert.equal(
				snapshotStore.take(sessionId),
				undefined,
				"a vetoed fire must not capture a snapshot",
			);
			const toast = notifications.find((n) => /deferred threshold compaction/.test(n.msg));
			assert.ok(toast, `expected deferral toast; got ${JSON.stringify(notifications)}`);
			assert.match(toast.msg, /fan-out in flight/);
		} finally {
			phase.clearSession(sessionId);
		}
	});
});

test("when-policy: reason=overflow is NEVER vetoed even mid-phase", async () => {
	await withUserTiming(TIMING_ON, async (cwd) => {
		const sessionId = "when-overflow";
		phase.clearSession(sessionId);
		phase.subagentStarted(sessionId, "tc-fanout");
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx } = omlxCtx(cwd, sessionId);
			const [result] = await pi.fire(
				"session_before_compact",
				thresholdEvent([user("work"), asstTool("bash", "t1"), toolRes("bash", "t1")], 114688, "overflow"),
				ctx as never,
			);
			assert.ok(
				result && (result as { compaction?: unknown }).compaction,
				"overflow fire must proceed to the deterministic builder, never cancel",
			);
		} finally {
			phase.clearSession(sessionId);
		}
	});
});

test("when-policy: deferral ceiling forces the compaction through", async () => {
	await withUserTiming(TIMING_ON, async (cwd) => {
		const sessionId = "when-ceiling";
		phase.clearSession(sessionId);
		phase.subagentStarted(sessionId, "tc-fanout");
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx, notifications } = omlxCtx(cwd, sessionId);
			const [result] = await pi.fire(
				"session_before_compact",
				// 0.9 × 131072 = 117964.8 → at 118000 the ceiling forbids deferral.
				thresholdEvent([user("work"), asstTool("bash", "t1"), toolRes("bash", "t1")], 118000, "threshold"),
				ctx as never,
			);
			assert.ok(
				result && (result as { compaction?: unknown }).compaction,
				"at the ceiling the compaction must proceed",
			);
			assert.ok(
				notifications.some((n) => /deferral ceiling reached/.test(n.msg)),
				"expected ceiling notify",
			);
		} finally {
			phase.clearSession(sessionId);
		}
	});
});

test("when-policy: off by default — threshold fire proceeds untouched", async () => {
	await withCwd({ mode: "deterministic" }, async (cwd) => {
		const sessionId = "when-off";
		phase.clearSession(sessionId);
		phase.subagentStarted(sessionId, "tc-fanout");
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx } = makeCapturingCtx(cwd, sessionId);
			const [result] = await pi.fire(
				"session_before_compact",
				thresholdEvent([user("work"), asstTool("bash", "t1"), toolRes("bash", "t1")], 114688, "threshold"),
				ctx as never,
			);
			assert.ok(
				result && (result as { compaction?: unknown }).compaction,
				"policy disabled → no veto",
			);
		} finally {
			phase.clearSession(sessionId);
		}
	});
});

test("when-policy: armed self-compact flag bypasses the veto and is consumed", async () => {
	await withUserTiming(TIMING_ON, async (cwd) => {
		const sessionId = "when-self";
		phase.clearSession(sessionId);
		phase.subagentStarted(sessionId, "tc-fanout"); // would otherwise defer
		phase.armSelfCompact(sessionId);
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx } = omlxCtx(cwd, sessionId);
			const [result] = await pi.fire(
				"session_before_compact",
				thresholdEvent([user("work"), asstTool("bash", "t1"), toolRes("bash", "t1")], 114688, "manual"),
				ctx as never,
			);
			assert.ok(
				result && (result as { compaction?: unknown }).compaction,
				"self-triggered compaction must run the builder",
			);
			assert.equal(phase.consumeSelfCompact(sessionId), false, "flag consumed exactly once");
		} finally {
			phase.clearSession(sessionId);
		}
	});
});

test("when-policy: subagent tool lifecycle wiring tracks in-flight fan-out", async () => {
	await withCwd({ mode: "deterministic" }, async (cwd) => {
		const sessionId = "when-wiring";
		phase.clearSession(sessionId);
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			const { ctx } = makeCapturingCtx(cwd, sessionId);
			await pi.fire("tool_execution_start", { toolName: "subagent", toolCallId: "tc9" }, ctx as never);
			assert.equal(phase.subagentInFlight(sessionId), true);
			await pi.fire("tool_execution_start", { toolName: "bash", toolCallId: "tc-b" }, ctx as never);
			await pi.fire("tool_execution_end", { toolName: "subagent", toolCallId: "tc9" }, ctx as never);
			assert.equal(phase.subagentInFlight(sessionId), false);
			await pi.fire("turn_end", { turnIndex: 4 }, ctx as never);
			phase.publishTaskType(sessionId, "code-edit");
			assert.equal(phase.turnsSinceTaskTypeChange(sessionId), 0);
		} finally {
			phase.clearSession(sessionId);
		}
	});
});

test("when-policy: agent_settled never arms the self-flag when ctx.compact is unavailable (#781)", async () => {
	await withUserTiming(TIMING_ON, async (cwd) => {
		const sessionId = "settled-no-compact";
		phase.clearSession(sessionId);
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			// Fresh boundary + usage past threshold: decideProactive would fire.
			await pi.fire("turn_end", { turnIndex: 5 }, {
				cwd,
				ui: { notify: () => undefined },
				sessionManager: { getSessionId: () => sessionId, isPersisted: () => false },
			} as never);
			phase.publishTaskType(sessionId, "code-edit");
			const baseCtx = {
				cwd,
				model: { provider: "omlx", contextWindow: 131072 },
				getContextUsage: () => ({ tokens: 110000 }),
				ui: { notify: () => undefined },
				sessionManager: { getSessionId: () => sessionId, isPersisted: () => false },
			};
			// No ctx.compact: the flag must never be armed.
			await pi.fire("agent_settled", {}, baseCtx as never);
			assert.equal(
				phase.consumeSelfCompact(sessionId),
				false,
				"flag must not be armed when ctx.compact is missing",
			);
			// Positive control: with ctx.compact present the flag IS armed.
			let compactCalled = false;
			await pi.fire(
				"agent_settled",
				{},
				{ ...baseCtx, compact: () => { compactCalled = true; } } as never,
			);
			assert.equal(compactCalled, true, "ctx.compact must be invoked");
			assert.equal(phase.consumeSelfCompact(sessionId), true, "flag armed on the real path");
		} finally {
			phase.clearSession(sessionId);
		}
	});
});
