/**
 * Tests for the per-compaction metrics ledger (#838, ADR-0117).
 *
 * Unit level: buildEventRecord cost math (zero/derived bases, counterfactual),
 * policy-tag normalization, appendEvent JSONL round-trip against an injected
 * agentDir. Integration level: the index.ts hand-off — session_before_compact
 * stashes, session_compact appends — exercised through the extension factory
 * with HOME pointed at a temp dir (POSIX os.homedir() honors $HOME), so the
 * real operator ledger is never touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__internal,
	appendEvent,
	buildEventRecord,
	eventsLogPath,
	policyTag,
	type CompactionEventRecord,
	type PendingEvent,
} from "../lib/events.ts";
import factory from "../index.ts";

function pending(over: Partial<PendingEvent> = {}): PendingEvent {
	return {
		sessionId: "sess-1",
		mode: "hybrid",
		path: "fallthrough",
		tokensBefore: 100_000,
		model: "coding-workhorse",
		provider: "omlx",
		rates: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
		t0: 1_000,
		...over,
	};
}

test("events: policyTag normalizes empty/missing to 'untagged' and caches per process", () => {
	__internal.resetPolicyTagCache();
	assert.equal(policyTag({}), "untagged");
	// Cached: a later env change must not fork the label mid-process.
	assert.equal(policyTag({ TOKEN_METER_POLICY_TAG: "late" }), "untagged");
	__internal.resetPolicyTagCache();
	assert.equal(policyTag({ TOKEN_METER_POLICY_TAG: "  compact-a/b  " }), "compact-a/b");
	__internal.resetPolicyTagCache();
});

test("events: eventsLogPath lands in the extension namespace", () => {
	assert.equal(
		eventsLogPath("/tmp/agent"),
		join("/tmp/agent", "extensions", "compaction-optimizer", "events.jsonl"),
	);
});

test("events: deterministic record — costBasis zero, counterfactual from own summary size", () => {
	const rec = buildEventRecord({
		pending: pending({
			path: "deterministic",
			mode: "deterministic",
			rung: "full",
			summaryTokens: 4_000,
		}),
		now: 1_250,
		ts: "2026-07-21T00:00:00.000Z",
		policy: "untagged",
	});
	assert.equal(rec.costBasis, "zero");
	assert.equal(rec.costUSD, 0);
	// 100K in × $1/MTok + 4K out × $5/MTok = 0.10 + 0.02 = 0.12
	assert.equal(rec.counterfactualDefaultCostUSD, 0.12);
	assert.equal(rec.latencyMs, 250);
	assert.equal(rec.rung, "full");
	assert.equal(rec.summaryTokens, 4_000);
	assert.deepEqual(rec.components, {
		summaryTokensEst: 4_000,
		inputPerMTok: 1.0,
		outputPerMTok: 5.0,
	});
});

test("events: fallthrough record — derived cost from committed summary, no counterfactual", () => {
	const rec = buildEventRecord({
		pending: pending({ reason: "tool-call-ratio-low" }),
		committedSummaryTokens: 2_000,
		now: 61_000,
		ts: "2026-07-21T00:00:00.000Z",
		policy: "compact-default",
	});
	assert.equal(rec.costBasis, "derived");
	// 100K × $1/MTok + 2K × $5/MTok = 0.10 + 0.01 = 0.11 — the derived figure
	// IS the default path's (upper-bound) actual; no separate counterfactual.
	assert.equal(rec.costUSD, 0.11);
	assert.equal(rec.counterfactualDefaultCostUSD, undefined);
	assert.equal(rec.reason, "tool-call-ratio-low");
	assert.equal(rec.summaryTokens, 2_000);
	assert.equal(rec.latencyMs, 60_000);
});

test("events: deterministic summaryTokens takes precedence over committed estimate", () => {
	const rec = buildEventRecord({
		pending: pending({ path: "deterministic", summaryTokens: 3_000 }),
		committedSummaryTokens: 9_999,
		now: 1_001,
		ts: "t",
		policy: "p",
	});
	assert.equal(rec.summaryTokens, 3_000);
});

test("events: missing rates — no cost fields on derived paths, costUSD 0 on deterministic", () => {
	const noRates = buildEventRecord({
		pending: pending({ rates: undefined }),
		committedSummaryTokens: 2_000,
		now: 1_001,
		ts: "t",
		policy: "p",
	});
	assert.equal(noRates.costUSD, undefined);
	assert.equal(noRates.components, undefined);
	const det = buildEventRecord({
		pending: pending({ path: "deterministic", rates: undefined, summaryTokens: 10 }),
		now: 1_001,
		ts: "t",
		policy: "p",
	});
	assert.equal(det.costUSD, 0);
});

test("events: latency never negative; round6 keeps micro-dollar precision", () => {
	const rec = buildEventRecord({
		pending: pending({ t0: 5_000 }),
		committedSummaryTokens: 1,
		now: 4_000, // clock skew — clamp, don't go negative
		ts: "t",
		policy: "p",
	});
	assert.equal(rec.latencyMs, 0);
	assert.equal(__internal.round6(0.1234567891), 0.123457);
	assert.equal(__internal.usd(Number.NaN, 1), 0);
});

test("events: appendEvent JSONL round-trip against an injected agentDir", async () => {
	const dir = await fs.mkdtemp(join(tmpdir(), "compopt-events-"));
	try {
		const rec = buildEventRecord({
			pending: pending({ path: "llm-only", mode: "llm-only-with-dump" }),
			committedSummaryTokens: 500,
			now: 2_000,
			ts: "2026-07-21T01:00:00.000Z",
			policy: "untagged",
		});
		await appendEvent(rec, dir);
		await appendEvent(rec, dir);
		const lines = (await fs.readFile(eventsLogPath(dir), "utf8"))
			.trim()
			.split("\n");
		assert.equal(lines.length, 2);
		const parsed = JSON.parse(lines[0]) as CompactionEventRecord;
		assert.equal(parsed.path, "llm-only");
		assert.equal(parsed.costBasis, "derived");
		assert.equal(parsed.tokensBefore, 100_000);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Integration: factory-level hand-off (before_compact stash → compact append).
// ---------------------------------------------------------------------------

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

function asstTool(name: string, id: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		timestamp: 2,
	};
}
function toolRes(name: string, id: string): unknown {
	return { role: "toolResult", toolName: name, toolCallId: id, content: "ok", timestamp: 3 };
}

function makeEvent(messages: unknown[]): unknown {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "entry-1",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			previousSummary: undefined,
			fileOps: { read: new Set(["src/a.ts"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		branchEntries: [],
		customInstructions: undefined,
		signal: new AbortController().signal,
	};
}

function makeCtx(cwd: string, sessionId: string): unknown {
	return {
		cwd,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => false },
		model: {
			id: "test-model",
			provider: "test-prov",
			contextWindow: 131_072,
			cost: { input: 2.0, output: 10.0 },
		},
		signal: undefined,
	};
}

/**
 * Run `fn` with HOME (and the archive default root, which derives from it)
 * pointed at a temp dir so the ledger and archive writes stay isolated.
 */
async function withTempHome<T>(
	modeSettings: Record<string, unknown>,
	fn: (cwd: string, home: string) => Promise<T>,
): Promise<T> {
	const home = await fs.mkdtemp(join(tmpdir(), "compopt-events-home-"));
	const cwd = join(home, "proj");
	const piDir = join(cwd, ".pi");
	await fs.mkdir(piDir, { recursive: true });
	await fs.writeFile(
		join(piDir, "settings.json"),
		JSON.stringify({ extensionSettings: { compactionOptimizer: modeSettings } }),
	);
	const prevHome = process.env.HOME;
	process.env.HOME = home;
	try {
		return await fn(cwd, home);
	} finally {
		process.env.HOME = prevHome;
		await fs.rm(home, { recursive: true, force: true });
	}
}

function ledgerPathUnder(home: string): string {
	return eventsLogPath(join(home, ".pi", "agent"));
}

test("integration: deterministic compaction appends a zero-basis record at commit", async () => {
	await withTempHome({ mode: "deterministic" }, async (cwd, home) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const ctx = makeCtx(cwd, "evt-sess-det");
		const [result] = await pi.fire(
			"session_before_compact",
			makeEvent([asstTool("bash", "t1"), toolRes("bash", "t1")]),
			ctx,
		);
		assert.ok((result as { compaction?: unknown })?.compaction, "deterministic return");
		// No ledger line before commit.
		await assert.rejects(fs.readFile(ledgerPathUnder(home), "utf8"));
		const summary = (result as { compaction: { summary: string } }).compaction.summary;
		await pi.fire("session_compact", { compactionEntry: { summary } }, ctx);
		const lines = (await fs.readFile(ledgerPathUnder(home), "utf8")).trim().split("\n");
		assert.equal(lines.length, 1);
		const rec = JSON.parse(lines[0]) as CompactionEventRecord;
		assert.equal(rec.path, "deterministic");
		assert.equal(rec.costBasis, "zero");
		assert.equal(rec.costUSD, 0);
		assert.equal(rec.sessionId, "evt-sess-det");
		assert.equal(rec.tokensBefore, 50_000);
		assert.equal(rec.model, "test-model");
		assert.ok((rec.counterfactualDefaultCostUSD ?? 0) > 0, "counterfactual priced");
		assert.ok((rec.summaryTokens ?? 0) > 0);
	});
});

test("integration: llm-only compaction appends a derived-basis record from the committed summary", async () => {
	await withTempHome({ mode: "llm-only-with-dump" }, async (cwd, home) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const ctx = makeCtx(cwd, "evt-sess-llm");
		const [result] = await pi.fire(
			"session_before_compact",
			makeEvent([asstTool("bash", "t1"), toolRes("bash", "t1")]),
			ctx,
		);
		assert.equal(result, undefined, "llm-only falls through");
		// pi's summarizer would run here; simulate the committed entry.
		const committed = "x".repeat(8_000); // ⇒ 2000 estimated tokens
		await pi.fire("session_compact", { compactionEntry: { summary: committed } }, ctx);
		const rec = JSON.parse(
			(await fs.readFile(ledgerPathUnder(home), "utf8")).trim(),
		) as CompactionEventRecord;
		assert.equal(rec.path, "llm-only");
		assert.equal(rec.costBasis, "derived");
		assert.equal(rec.summaryTokens, 2_000);
		// 50K × $2/MTok + 2K × $10/MTok = 0.10 + 0.02 = 0.12 (upper bound).
		assert.equal(rec.costUSD, 0.12);
		assert.equal(rec.counterfactualDefaultCostUSD, undefined);
	});
});

test("integration: events.enabled=false suppresses the ledger entirely", async () => {
	await withTempHome(
		{ mode: "deterministic", events: { enabled: false } },
		async (cwd, home) => {
			const pi = makeFakePi();
			await factory(pi as never);
			const ctx = makeCtx(cwd, "evt-sess-off");
			const [result] = await pi.fire(
				"session_before_compact",
				makeEvent([asstTool("bash", "t1"), toolRes("bash", "t1")]),
				ctx,
			);
			const summary = (result as { compaction: { summary: string } }).compaction.summary;
			await pi.fire("session_compact", { compactionEntry: { summary } }, ctx);
			await assert.rejects(
				fs.readFile(ledgerPathUnder(home), "utf8"),
				/ENOENT/,
				"no ledger when disabled",
			);
		},
	);
});

test("integration: cancelled (deferred) compaction leaves no pending row on a later commit", async () => {
	await withTempHome({ mode: "deterministic" }, async (cwd, home) => {
		const pi = makeFakePi();
		await factory(pi as never);
		const ctx = makeCtx(cwd, "evt-sess-cancel");
		// A session_compact with NO prior before_compact stash: nothing appended.
		await pi.fire("session_compact", { compactionEntry: { summary: "s" } }, ctx);
		await assert.rejects(fs.readFile(ledgerPathUnder(home), "utf8"), /ENOENT/);
	});
});
