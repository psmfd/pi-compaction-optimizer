/**
 * Unit tests for the #783 handler extractions: applyWhenPolicyVeto (step 0)
 * and dispatchCompactionMode (step 3), driven directly on plain objects —
 * no fake-pi event bus. The index-dispatch suite remains the integration
 * check that the slimmed handler wires these correctly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWhenPolicyVeto, dispatchCompactionMode } from "../index.ts";
import { getDefaults } from "../lib/settings.ts";
import type { PendingEvent } from "../lib/events.ts";
import * as phaseState from "../shared/phase-state.ts";

function captureOnce() {
	const calls: Array<{ key: string; message: string; kind?: string }> = [];
	return {
		calls,
		fn: (key: string, message: string, kind?: "info" | "warning" | "error") => {
			calls.push({ key, message, kind });
		},
	};
}

function captureNotify() {
	const calls: Array<{ message: string; kind: string }> = [];
	return {
		calls,
		fn: (message: string, kind: "info" | "warning" | "error") => {
			calls.push({ message, kind });
		},
	};
}

function captureStash() {
	const calls: Array<Pick<PendingEvent, "path"> & Partial<PendingEvent>> = [];
	return { calls, fn: (p: Pick<PendingEvent, "path"> & Partial<PendingEvent>) => calls.push(p) };
}

const ENABLED_TIMING = { ...getDefaults().timing, enabled: true };

// -----------------------------------------------------------------------------
// applyWhenPolicyVeto
// -----------------------------------------------------------------------------

test("veto: an armed self-compact flag wins over any defer condition and is consumed", () => {
	const sid = "veto-self";
	try {
		phaseState.armSelfCompact(sid);
		// Conditions that would otherwise defer (fan-out in flight).
		phaseState.subagentStarted(sid, "tc1");
		const once = captureOnce();
		const out = applyWhenPolicyVeto({
			timing: ENABLED_TIMING,
			sessionId: sid,
			reason: "threshold",
			tokensBefore: 1_000,
			provider: "omlx",
			contextWindow: 100_000,
			notifyOnceFn: once.fn,
		});
		assert.equal(out, undefined);
		assert.equal(once.calls.length, 0);
		assert.equal(phaseState.consumeSelfCompact(sid), false, "flag was consumed by the veto");
	} finally {
		phaseState.clearSession(sid);
	}
});

test("veto: threshold fire with fan-out in flight cancels and counts the deferral", () => {
	const sid = "veto-defer";
	try {
		phaseState.subagentStarted(sid, "tc1");
		const once = captureOnce();
		const out = applyWhenPolicyVeto({
			timing: ENABLED_TIMING,
			sessionId: sid,
			reason: "threshold",
			tokensBefore: 1_000,
			provider: "omlx",
			contextWindow: 100_000,
			notifyOnceFn: once.fn,
		});
		assert.deepEqual(out, { cancel: true });
		assert.equal(phaseState.deferralCount(sid), 1);
		assert.equal(once.calls.length, 1);
		assert.match(once.calls[0].message, /fan-out in flight/);
		assert.equal(once.calls[0].key, `defer:${sid}:active`);
	} finally {
		phaseState.clearSession(sid);
	}
});

test("veto: non-threshold reasons are never deferred", () => {
	const sid = "veto-overflow";
	try {
		phaseState.subagentStarted(sid, "tc1");
		const once = captureOnce();
		const out = applyWhenPolicyVeto({
			timing: ENABLED_TIMING,
			sessionId: sid,
			reason: "overflow",
			tokensBefore: 1_000,
			provider: "omlx",
			contextWindow: 100_000,
			notifyOnceFn: once.fn,
		});
		assert.equal(out, undefined);
		assert.equal(phaseState.deferralCount(sid), 0);
		assert.equal(once.calls.length, 0);
	} finally {
		phaseState.clearSession(sid);
	}
});

test("veto: past the deferral ceiling compacts and toasts the ceiling notice", () => {
	const sid = "veto-ceiling";
	try {
		phaseState.subagentStarted(sid, "tc1");
		const once = captureOnce();
		const out = applyWhenPolicyVeto({
			timing: ENABLED_TIMING,
			sessionId: sid,
			reason: "threshold",
			tokensBefore: 95_000, // ≥ 0.9 × 100_000
			provider: "omlx",
			contextWindow: 100_000,
			notifyOnceFn: once.fn,
		});
		assert.equal(out, undefined);
		assert.equal(once.calls.length, 1);
		assert.equal(once.calls[0].key, `defer:${sid}:ceiling`);
		assert.match(once.calls[0].message, /deferral ceiling reached/);
	} finally {
		phaseState.clearSession(sid);
	}
});

test("veto: disabled timing is inert even mid-fan-out", () => {
	const sid = "veto-disabled";
	try {
		phaseState.subagentStarted(sid, "tc1");
		const once = captureOnce();
		const out = applyWhenPolicyVeto({
			timing: getDefaults().timing, // enabled: false
			sessionId: sid,
			reason: "threshold",
			tokensBefore: 1_000,
			provider: "omlx",
			contextWindow: 100_000,
			notifyOnceFn: once.fn,
		});
		assert.equal(out, undefined);
		assert.equal(once.calls.length, 0);
	} finally {
		phaseState.clearSession(sid);
	}
});

// -----------------------------------------------------------------------------
// dispatchCompactionMode
// -----------------------------------------------------------------------------

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

function baseInput(overrides: Record<string, unknown> = {}) {
	const once = captureOnce();
	const notify = captureNotify();
	const stash = captureStash();
	const input = {
		settings: getDefaults(),
		sessionId: "dispatch-unit",
		customInstructions: undefined as string | undefined,
		fileOps: { read: new Set(["src/a.ts"]), written: new Set<string>(), edited: new Set<string>() },
		messagesToSummarize: [user("do work"), asstTool("bash", "t1"), toolRes("bash", "t1")],
		turnPrefixMessages: [] as unknown[],
		isSplitTurn: false,
		firstKeptEntryId: "entry-42",
		tokensBefore: 1234,
		previousSummary: undefined as string | undefined,
		contextWindow: 100_000,
		notify: notify.fn,
		notifyOnceFn: once.fn,
		stashEvent: stash.fn,
		...overrides,
	};
	return { input, once, notify, stash };
}

test("dispatch: deterministic mode returns a compaction with mirrored details and stashes the event", () => {
	const { input, notify, stash } = baseInput({
		settings: { ...getDefaults(), mode: "deterministic" },
	});
	const out = dispatchCompactionMode(input);
	assert.ok(out && typeof out === "object" && "compaction" in out);
	const compaction = (out as { compaction: { summary: string; firstKeptEntryId: string; details: { generatedBy: string; readFiles: string[] } } }).compaction;
	assert.equal(compaction.firstKeptEntryId, "entry-42");
	assert.equal(compaction.details.generatedBy, "compaction-optimizer");
	assert.deepEqual(compaction.details.readFiles, ["src/a.ts"]);
	assert.ok(compaction.summary.length > 0);
	assert.equal(stash.calls.length, 1);
	assert.equal(stash.calls[0].path, "deterministic");
	assert.equal(stash.calls[0].rung, "full");
	assert.ok(notify.calls.some((c) => c.message.includes("air-gapped deterministic summary")));
});

test("dispatch: deterministic mode drops /compact instructions with a one-shot warning", () => {
	const { input, once } = baseInput({
		settings: { ...getDefaults(), mode: "deterministic" },
		customInstructions: "focus on the API changes",
	});
	const out = dispatchCompactionMode(input);
	assert.ok(out && "compaction" in (out as object));
	assert.ok(once.calls.some((c) => c.key === "mode:dispatch-unit:det-instructions" && c.kind === "warning"));
});

test("dispatch: deterministic mode with missing fileOps falls through loudly", () => {
	const { input, once, stash } = baseInput({
		settings: { ...getDefaults(), mode: "deterministic" },
		fileOps: undefined,
	});
	const out = dispatchCompactionMode(input);
	assert.equal(out, undefined);
	assert.ok(once.calls.some((c) => c.key === "mode:dispatch-unit:det-fileops-missing"));
	assert.equal(stash.calls.length, 1);
	assert.deepEqual(stash.calls[0], { path: "fallthrough", reason: "fileops-missing" });
});

test("dispatch: llm-only-with-dump defers to pi and stashes the llm-only path", () => {
	const { input, notify, stash } = baseInput({
		settings: { ...getDefaults(), mode: "llm-only-with-dump" },
	});
	const out = dispatchCompactionMode(input);
	assert.equal(out, undefined);
	assert.equal(stash.calls.length, 1);
	assert.deepEqual(stash.calls[0], { path: "llm-only" });
	assert.ok(notify.calls.some((c) => c.message.includes("deferred to pi LLM summarizer")));
});

test("dispatch: hybrid chatty cluster falls through with the gate reason recorded", () => {
	const chatty: unknown[] = [user("question")];
	for (let i = 0; i < 10; i++) chatty.push(asstText(`long analysis ${"x".repeat(200)} #${i}`));
	const { input, notify, stash } = baseInput({
		settings: { ...getDefaults(), mode: "hybrid" },
		messagesToSummarize: chatty,
	});
	const out = dispatchCompactionMode(input);
	assert.equal(out, undefined);
	assert.equal(stash.calls.length, 1);
	assert.equal(stash.calls[0].path, "fallthrough");
	assert.ok(typeof stash.calls[0].reason === "string" && stash.calls[0].reason.length > 0);
	assert.ok(stash.calls[0].metrics, "hybrid metrics recorded on the stash");
	assert.ok(notify.calls.some((c) => c.message.includes("fell through to pi LLM summarizer")));
});
