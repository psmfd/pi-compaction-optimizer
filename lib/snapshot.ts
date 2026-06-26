/**
 * In-memory snapshot store for the cross-handler state hand-off between
 * `session_before_compact` (pre-commit) and `session_compact` (post-commit).
 *
 * The post-commit `session_compact` event surfaces only `{compactionEntry,
 * fromExtension}` and does not carry the raw message payload the archive
 * writer needs. The pre-commit handler captures the payload here; the
 * post-commit handler consumes and clears it.
 *
 * Bounded to 1 entry per session — any stale capture from a previously
 * cancelled compaction is overwritten on the next pre-commit fire. Cleared
 * on `session_shutdown` and on process exit.
 *
 * Source rules: ADR-0019 § Decision Outcome (cross-handler state hand-off).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface MessageSnapshot {
	/** Messages that will be summarized and discarded. */
	messagesToSummarize: AgentMessage[];
	/** Turn-prefix messages (populated when isSplitTurn). */
	turnPrefixMessages: AgentMessage[];
	/** Whether the cut was mid-turn. */
	isSplitTurn: boolean;
	/** UUID of the first kept entry, echoed from preparation. */
	firstKeptEntryId: string;
	/** Tokens-before count from preparation. */
	tokensBefore: number;
	/** Previous compaction summary if any. */
	previousSummary?: string;
	/** Wallclock at capture, ISO-8601 UTC. */
	capturedAt: string;
}

const store = new Map<string, MessageSnapshot>();

export function put(sessionId: string, snapshot: MessageSnapshot): void {
	store.set(sessionId, snapshot);
}

export function take(sessionId: string): MessageSnapshot | undefined {
	const snap = store.get(sessionId);
	if (snap !== undefined) store.delete(sessionId);
	return snap;
}

export function clear(sessionId: string): void {
	store.delete(sessionId);
}

export function clearAll(): void {
	store.clear();
}

/** Test-only: report current count without mutating. */
export function size(): number {
	return store.size;
}
