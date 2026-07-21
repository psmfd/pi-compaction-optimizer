import { test } from "node:test";
import assert from "node:assert/strict";
import {
	decideDefer,
	decideProactive,
	type DeferInput,
	type PhaseSnapshot,
	type TimingSettings,
} from "../lib/timing.ts";

const SETTINGS: TimingSettings = {
	enabled: true,
	providers: ["omlx"],
	deferCeilingFraction: 0.9,
	proactiveAtFraction: 0.75,
	maxDeferrals: 10,
	boundaryWindowTurns: 1,
};

const MID_PHASE: PhaseSnapshot = {
	subagentInFlight: false,
	turnsSinceTaskTypeChange: 5,
	taskTypeChangedSinceCompaction: true,
	deferrals: 0,
};

// omlx workhorse geometry: window 131072, pi threshold fires ≈114688
// (contextWindow − reserveTokens 16384), ceiling 0.9 × window = 117965.
const BASE: DeferInput = {
	settings: SETTINGS,
	reason: "threshold",
	provider: "omlx",
	contextWindow: 131072,
	tokensBefore: 114688,
	phase: MID_PHASE,
};

test("timing: mid-phase threshold fire inside the band defers", () => {
	const d = decideDefer(BASE);
	assert.deepEqual(d, { defer: true, reason: "mid-phase" });
});

test("timing: subagent fan-out in flight defers", () => {
	const d = decideDefer({
		...BASE,
		phase: { ...MID_PHASE, subagentInFlight: true, turnsSinceTaskTypeChange: 0 },
	});
	assert.deepEqual(d, { defer: true, reason: "fanout-in-flight" });
});

test("timing: disabled policy never defers", () => {
	const d = decideDefer({ ...BASE, settings: { ...SETTINGS, enabled: false } });
	assert.deepEqual(d, { defer: false, reason: "disabled" });
});

test("timing: overflow and manual reasons are NEVER deferred", () => {
	for (const reason of ["overflow", "manual", undefined, "anything-else"]) {
		const d = decideDefer({ ...BASE, reason });
		assert.equal(d.defer, false, `reason=${String(reason)} must not defer`);
		assert.equal(d.reason, "not-threshold");
	}
});

test("timing: provider outside the allowlist never defers", () => {
	for (const provider of ["anthropic", undefined]) {
		const d = decideDefer({ ...BASE, provider });
		assert.deepEqual(d, { defer: false, reason: "provider-not-listed" });
	}
});

test("timing: unknown context window never defers (no absolute fallback)", () => {
	for (const contextWindow of [0, -1, Number.NaN]) {
		const d = decideDefer({ ...BASE, contextWindow });
		assert.deepEqual(d, { defer: false, reason: "window-unknown" });
	}
});

test("timing: ceiling forces the compaction through", () => {
	// 0.9 × 131072 = 117964.8 — at/above it, never defer.
	const d = decideDefer({ ...BASE, tokensBefore: 117965 });
	assert.deepEqual(d, { defer: false, reason: "ceiling-reached" });
});

test("timing: maxDeferrals caps a runaway episode", () => {
	const d = decideDefer({ ...BASE, phase: { ...MID_PHASE, deferrals: 10 } });
	assert.deepEqual(d, { defer: false, reason: "max-deferrals" });
});

test("timing: fresh boundary or absent task-type signal does not defer", () => {
	for (const turns of [0, 1, undefined]) {
		const d = decideDefer({
			...BASE,
			phase: { ...MID_PHASE, turnsSinceTaskTypeChange: turns },
		});
		assert.deepEqual(d, { defer: false, reason: "at-boundary" });
	}
});

test("timing: proactive fires only at a fresh, uncompacted boundary with usage past threshold", () => {
	const base = {
		settings: SETTINGS,
		provider: "omlx",
		contextWindow: 131072,
		usageTokens: 100000, // ≥ 0.75 × 131072 = 98304
		phase: {
			subagentInFlight: false,
			turnsSinceTaskTypeChange: 0,
			taskTypeChangedSinceCompaction: true,
			deferrals: 0,
		},
	};
	assert.equal(decideProactive(base), true);
	assert.equal(decideProactive({ ...base, usageTokens: 90000 }), false, "usage below threshold");
	assert.equal(
		decideProactive({ ...base, phase: { ...base.phase, subagentInFlight: true } }),
		false,
		"fan-out in flight",
	);
	assert.equal(
		decideProactive({ ...base, phase: { ...base.phase, taskTypeChangedSinceCompaction: false } }),
		false,
		"boundary already compacted",
	);
	assert.equal(
		decideProactive({ ...base, phase: { ...base.phase, turnsSinceTaskTypeChange: 5 } }),
		false,
		"stale transition is not a boundary",
	);
	assert.equal(
		decideProactive({ ...base, phase: { ...base.phase, turnsSinceTaskTypeChange: undefined } }),
		false,
		"no task-type signal",
	);
	assert.equal(decideProactive({ ...base, provider: "anthropic" }), false, "provider gate");
	assert.equal(decideProactive({ ...base, contextWindow: 0 }), false, "unknown window");
	assert.equal(
		decideProactive({ ...base, settings: { ...SETTINGS, enabled: false } }),
		false,
		"disabled",
	);
});
