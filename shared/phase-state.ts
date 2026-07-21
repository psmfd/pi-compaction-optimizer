/**
 * shared/phase-state.ts — in-memory, session-keyed phase signals for the
 * optimization suite (#677, ADR-0109).
 *
 * One pi process hosts one live session's extensions; modules under
 * `shared/` are singletons within that process, so a plain module-level Map
 * gives every extension the same view with zero I/O and zero
 * cross-extension imports (the `shared/` path is the sanctioned exception).
 *
 * Producers:
 *   - auto-router publishes its per-turn task-type label (`publishTaskType`).
 *   - compaction-optimizer wires the generic tool-execution lifecycle for
 *     `subagent` in-flight tracking and `turn_end` for the turn counter.
 * Consumers:
 *   - compaction-optimizer's when-policy (defer / proactive trigger).
 *   - future: the #772 unified optimization-layer state is expected to build
 *     on or beside this module rather than introduce a second store.
 *
 * All functions are total and side-effect-free beyond the store itself; a
 * session with no recorded state behaves as "no signal" (undefined), never
 * as an error. Callers must treat "no signal" as unknown, not as a phase
 * judgment.
 */

interface SessionPhaseState {
	/** Last turn index seen via `turn_end` (0 until first wired event). */
	turnIndex: number;
	/** Current task-type label published by auto-router, if any. */
	taskType?: string;
	/** Turn index at which `taskType` last changed value. */
	taskTypeChangedTurn?: number;
	/** Turn index of the last committed compaction. */
	lastCompactionTurn?: number;
	/** Unresolved `subagent` tool executions by tool-call id. */
	inFlightSubagent: Set<string>;
	/** Threshold compactions deferred since the last committed compaction. */
	deferrals: number;
	/** Self-flag: the next `reason:"manual"` compaction is policy-triggered. */
	pendingSelfCompact: boolean;
}

const sessions = new Map<string, SessionPhaseState>();

function stateOf(sessionId: string): SessionPhaseState {
	let s = sessions.get(sessionId);
	if (!s) {
		s = { turnIndex: 0, inFlightSubagent: new Set(), deferrals: 0, pendingSelfCompact: false };
		sessions.set(sessionId, s);
	}
	return s;
}

/** Record a completed turn. Monotonic; ignores regressions. */
export function noteTurnEnd(sessionId: string, turnIndex: number): void {
	const s = stateOf(sessionId);
	if (Number.isFinite(turnIndex) && turnIndex > s.turnIndex) s.turnIndex = turnIndex;
}

/**
 * Publish the active task-type label (auto-router). Stamps the change turn
 * only when the label actually changes value — republishing the same label
 * every turn does not reset the boundary clock.
 */
export function publishTaskType(sessionId: string, taskType: string): void {
	const s = stateOf(sessionId);
	if (s.taskType !== taskType) {
		s.taskType = taskType;
		s.taskTypeChangedTurn = s.turnIndex;
	}
}

/** Turns elapsed since the task-type label last changed; undefined = no signal. */
export function turnsSinceTaskTypeChange(sessionId: string): number | undefined {
	const s = sessions.get(sessionId);
	if (!s || s.taskTypeChangedTurn === undefined) return undefined;
	return s.turnIndex - s.taskTypeChangedTurn;
}

/** True when the task type changed after the last committed compaction. */
export function taskTypeChangedSinceCompaction(sessionId: string): boolean {
	const s = sessions.get(sessionId);
	if (!s || s.taskTypeChangedTurn === undefined) return false;
	return s.taskTypeChangedTurn > (s.lastCompactionTurn ?? -1);
}

export function subagentStarted(sessionId: string, toolCallId: string): void {
	stateOf(sessionId).inFlightSubagent.add(toolCallId);
}

export function subagentEnded(sessionId: string, toolCallId: string): void {
	sessions.get(sessionId)?.inFlightSubagent.delete(toolCallId);
}

export function subagentInFlight(sessionId: string): boolean {
	return (sessions.get(sessionId)?.inFlightSubagent.size ?? 0) > 0;
}

/** Record a committed compaction; resets the deferral counter. */
export function noteCompaction(sessionId: string): void {
	const s = stateOf(sessionId);
	s.lastCompactionTurn = s.turnIndex;
	s.deferrals = 0;
}

/** Count a deferred threshold compaction; returns the new total. */
export function noteDeferral(sessionId: string): number {
	const s = stateOf(sessionId);
	s.deferrals += 1;
	return s.deferrals;
}

export function deferralCount(sessionId: string): number {
	return sessions.get(sessionId)?.deferrals ?? 0;
}

/** Arm the self-flag immediately before a policy-triggered `ctx.compact()`. */
export function armSelfCompact(sessionId: string): void {
	stateOf(sessionId).pendingSelfCompact = true;
}

/**
 * Check-and-clear the self-flag. Safe against interleaving: pi's
 * `SessionManager.compact()` emits `session_before_compact` synchronously in
 * the same call chain that armed the flag (ADR-0109 contract note).
 */
export function consumeSelfCompact(sessionId: string): boolean {
	const s = sessions.get(sessionId);
	if (!s || !s.pendingSelfCompact) return false;
	s.pendingSelfCompact = false;
	return true;
}

/** Disarm without consuming (e.g. `ctx.compact()` onError). */
export function disarmSelfCompact(sessionId: string): void {
	const s = sessions.get(sessionId);
	if (s) s.pendingSelfCompact = false;
}

/** Drop all state for a session (shutdown). */
export function clearSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test-only: reset the whole store. */
export function __clearAll(): void {
	sessions.clear();
}
