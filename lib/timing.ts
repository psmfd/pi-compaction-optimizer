/**
 * When-policy for compaction timing (#677, ADR-0109): pure decision
 * functions consumed by the dispatcher. No I/O, no phase-state access —
 * the caller supplies a snapshot, so both functions are table-testable.
 *
 * Safety posture: cancelling a compaction is the dangerous direction (a
 * wrongly-cancelled overflow compaction wedges the session; a
 * wrongly-cancelled threshold compaction near the window edge risks an
 * overflow abort). Every gate below is therefore an AND-chained early
 * return whose only path to "defer" requires EVERY precondition to hold;
 * any unknown or failed check resolves to "do not defer". Future edits
 * must add preconditions as new early returns, never widen an existing
 * branch.
 */

export interface TimingSettings {
	enabled: boolean;
	providers: string[];
	deferCeilingFraction: number;
	proactiveAtFraction: number;
	maxDeferrals: number;
	boundaryWindowTurns: number;
}

export interface PhaseSnapshot {
	subagentInFlight: boolean;
	/** Turns since the task-type label changed; undefined = no signal. */
	turnsSinceTaskTypeChange: number | undefined;
	taskTypeChangedSinceCompaction: boolean;
	deferrals: number;
}

export interface DeferInput {
	settings: TimingSettings;
	/** `event.reason` from `session_before_compact` (pi ≥0.80: top-level). */
	reason: unknown;
	/** Active provider id (`ctx.model?.provider`), if known. */
	provider: string | undefined;
	/** `ctx.model?.contextWindow`; non-positive/unknown → never defer. */
	contextWindow: number;
	/** `event.preparation.tokensBefore`. */
	tokensBefore: number;
	phase: PhaseSnapshot;
}

export type DeferDecision =
	| { defer: false; reason:
		| "disabled"
		| "not-threshold"
		| "provider-not-listed"
		| "window-unknown"
		| "ceiling-reached"
		| "max-deferrals"
		| "at-boundary" }
	| { defer: true; reason: "fanout-in-flight" | "mid-phase" };

/**
 * Decide whether to veto (`{cancel:true}`) a compaction fire.
 *
 * Only `reason === "threshold"` is ever deferrable: `"overflow"` must never
 * be cancelled (pi strips the failed turn's error message before the hook
 * fires; cancelling leaves the session wedged — ADR-0109 contract note),
 * and `"manual"` is an explicit operator/extension request. The strict
 * equality check fails toward not deferring for unknown reason values.
 */
export function decideDefer(input: DeferInput): DeferDecision {
	const { settings, phase } = input;
	if (!settings.enabled) return { defer: false, reason: "disabled" };
	if (input.reason !== "threshold") return { defer: false, reason: "not-threshold" };
	if (input.provider === undefined || !settings.providers.includes(input.provider)) {
		return { defer: false, reason: "provider-not-listed" };
	}
	// No absolute-token fallback here, deliberately unlike ADR-0107's input
	// gate: an unknown window makes the ceiling uncomputable, and the safe
	// resolution for a cancel decision is to not cancel.
	if (!(typeof input.contextWindow === "number" && input.contextWindow > 0)) {
		return { defer: false, reason: "window-unknown" };
	}
	const ceiling = settings.deferCeilingFraction * input.contextWindow;
	if (input.tokensBefore >= ceiling) return { defer: false, reason: "ceiling-reached" };
	if (phase.deferrals >= settings.maxDeferrals) return { defer: false, reason: "max-deferrals" };
	if (phase.subagentInFlight) return { defer: true, reason: "fanout-in-flight" };
	// Mid-phase = the task-type label exists and did NOT change within the
	// boundary window. A fresh transition (or no label signal at all) means
	// we cannot claim mid-phase — compact now.
	if (
		phase.turnsSinceTaskTypeChange !== undefined &&
		phase.turnsSinceTaskTypeChange > settings.boundaryWindowTurns
	) {
		return { defer: true, reason: "mid-phase" };
	}
	return { defer: false, reason: "at-boundary" };
}

export interface ProactiveInput {
	settings: TimingSettings;
	provider: string | undefined;
	contextWindow: number;
	/** Estimated tokens currently in context (`ctx.getContextUsage()?.tokens`). */
	usageTokens: number;
	phase: PhaseSnapshot;
}

/**
 * Decide whether to fire a proactive phase-boundary `ctx.compact()` from
 * `agent_settled`. Fires only when a compaction is imminent anyway
 * (usage ≥ proactiveAtFraction × window), the session sits at a fresh
 * task-type boundary with no fan-out in flight, and that boundary has not
 * already been compacted — so a mis-detected boundary costs at most an
 * early compaction that the threshold trigger would have forced shortly
 * after, never a novel compaction.
 */
export function decideProactive(input: ProactiveInput): boolean {
	const { settings, phase } = input;
	if (!settings.enabled) return false;
	if (input.provider === undefined || !settings.providers.includes(input.provider)) return false;
	if (!(typeof input.contextWindow === "number" && input.contextWindow > 0)) return false;
	if (!(typeof input.usageTokens === "number" && input.usageTokens > 0)) return false;
	if (input.usageTokens < settings.proactiveAtFraction * input.contextWindow) return false;
	if (phase.subagentInFlight) return false;
	if (!phase.taskTypeChangedSinceCompaction) return false;
	if (
		phase.turnsSinceTaskTypeChange === undefined ||
		phase.turnsSinceTaskTypeChange > settings.boundaryWindowTurns
	) {
		return false;
	}
	return true;
}
