/**
 * compaction-optimizer/lib/events.ts — per-compaction metrics ledger (#838).
 *
 * One JSONL record per COMMITTED compaction, appended to
 * `~/.pi/agent/extensions/compaction-optimizer/events.jsonl` (the per-extension
 * subtree, same placement rationale as cache-meter's turns.jsonl). The emit
 * site is the `session_compact` handler: `session_before_compact` stashes a
 * pending record (path, reason, rung, tokensBefore, active-model rates, t0),
 * and the commit completes it — so cancelled/deferred compactions never log,
 * and `latencyMs` spans the real compaction pause including pi's LLM
 * summarizer run on fall-through paths.
 *
 * Cost bases (ADR-0117):
 *   - "zero"     — deterministic builder: no model call.
 *   - "derived"  — pi's built-in summarizer ran on the active model. pi core
 *     discards the call's real usage before any hook fires (#840), so the cost
 *     is reconstructed: tokensBefore × input rate + estimated summary tokens ×
 *     output rate. UPPER BOUND — blind to the provider prefix-cache split.
 *     Components are logged so reports can show bounds.
 *   - "reported" — reserved for a compaction-optimizer-initiated summarizer
 *     call that sees the provider's actual usage (#839).
 *
 * Field vocabulary follows token-meter/cache-meter (ts/model/provider/policy)
 * for cross-ledger joins. The TOKEN_METER_POLICY_TAG read below is a
 * deliberate tiny duplication of token-meter's env contract (same
 * lockstep-copy posture as the secret-scan pattern set, ADR-0071) — importing
 * token-meter code would violate the cross-extension import ban (ADR-0088).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NAMESPACE = "compaction-optimizer";
const LOG_BASENAME = "events.jsonl";

/** Which dispatch branch handled the compaction. */
export type CompactionPath =
	| "deterministic"
	| "fallthrough"
	| "llm-only"
	| "ladder-exhausted";

export type CostBasis = "zero" | "derived" | "reported";

/** Per-MTok rates for the active model, when known. */
export interface ModelRates {
	inputPerMTok: number;
	outputPerMTok: number;
}

/** Pending record stashed at `session_before_compact`, completed at commit. */
export interface PendingEvent {
	sessionId: string;
	mode: string;
	path: CompactionPath;
	reason?: string;
	rung?: string;
	tokensBefore: number;
	model?: string;
	provider?: string;
	rates?: ModelRates;
	/** performance.now() at dispatch time — latency spans through the commit. */
	t0: number;
	/** Deterministic path only: rendered summary size, known pre-commit. */
	summaryTokens?: number;
	/** Hybrid dispatch metrics (decideHybrid), when mode=hybrid. */
	metrics?: {
		messageCount: number;
		tokenEstimate: number;
		toolCallCount: number;
		toolCallRatio: number;
		orphanAssistantTokens: number;
		effectiveMaxTokens: number;
	};
}

/** One JSONL line in events.jsonl. */
export interface CompactionEventRecord {
	ts: string;
	sessionId: string;
	/** TOKEN_METER_POLICY_TAG at process spawn, or "untagged". */
	policy: string;
	mode: string;
	path: CompactionPath;
	reason?: string;
	rung?: string;
	tokensBefore: number;
	/** Estimated tokens of the committed summary (chars/4). */
	summaryTokens?: number;
	latencyMs: number;
	model?: string;
	provider?: string;
	costBasis: CostBasis;
	/** Actual cost of the summarization under `costBasis` semantics (USD). */
	costUSD?: number;
	/**
	 * What pi's default summarizer WOULD have cost on the active model (USD);
	 * only set on non-default paths (deterministic), using this compaction's
	 * own summary size as the output-token proxy.
	 */
	counterfactualDefaultCostUSD?: number;
	/** Inputs behind derived/counterfactual figures, for bounds reporting. */
	components?: {
		summaryTokensEst?: number;
		inputPerMTok?: number;
		outputPerMTok?: number;
	};
	metrics?: PendingEvent["metrics"];
}

/**
 * Policy tag, captured once per process like token-meter does — the tag names
 * a whole session tree, so mid-process env churn must not fork the label.
 */
let policyTagCache: string | undefined;
export function policyTag(env: NodeJS.ProcessEnv = process.env): string {
	if (policyTagCache === undefined) {
		const raw = env.TOKEN_METER_POLICY_TAG;
		policyTagCache =
			typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "untagged";
	}
	return policyTagCache;
}

/** Resolve the JSONL ledger path. `agentDir` injectable for tests. */
export function eventsLogPath(agentDir?: string): string {
	const base = agentDir ?? join(homedir(), ".pi", "agent");
	return join(base, "extensions", NAMESPACE, LOG_BASENAME);
}

/** USD for `tokens` at `perMTok`; 0 when either side is non-finite. */
function usd(tokens: number, perMTok: number): number {
	if (!Number.isFinite(tokens) || !Number.isFinite(perMTok)) return 0;
	return (tokens / 1_000_000) * perMTok;
}

/** Round to micro-dollar precision so JSONL floats stay readable. */
function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/**
 * Complete a pending record into the final ledger line. Pure — clock and
 * summary size are inputs, not reads — so tests pin the math exactly.
 *
 * `committedSummaryTokens` is the chars/4 estimate of the summary pi actually
 * committed (from `CompactionEntry.summary`); for the deterministic path the
 * pending record's own `summaryTokens` (identical text) takes precedence.
 */
export function buildEventRecord(opts: {
	pending: PendingEvent;
	committedSummaryTokens?: number;
	now: number;
	ts: string;
	policy: string;
}): CompactionEventRecord {
	const { pending, ts, policy } = opts;
	const summaryTokens = pending.summaryTokens ?? opts.committedSummaryTokens;
	const latencyMs = Math.max(0, Math.round(opts.now - pending.t0));

	const record: CompactionEventRecord = {
		ts,
		sessionId: pending.sessionId,
		policy,
		mode: pending.mode,
		path: pending.path,
		tokensBefore: pending.tokensBefore,
		latencyMs,
		costBasis: pending.path === "deterministic" ? "zero" : "derived",
	};
	if (pending.reason !== undefined) record.reason = pending.reason;
	if (pending.rung !== undefined) record.rung = pending.rung;
	if (summaryTokens !== undefined) record.summaryTokens = summaryTokens;
	if (pending.model !== undefined) record.model = pending.model;
	if (pending.provider !== undefined) record.provider = pending.provider;
	if (pending.metrics !== undefined) record.metrics = pending.metrics;

	const rates = pending.rates;
	if (rates && (rates.inputPerMTok > 0 || rates.outputPerMTok > 0)) {
		const inputUsd = usd(pending.tokensBefore, rates.inputPerMTok);
		const outputUsd = usd(summaryTokens ?? 0, rates.outputPerMTok);
		const defaultPathUsd = round6(inputUsd + outputUsd);
		record.components = {
			...(summaryTokens !== undefined ? { summaryTokensEst: summaryTokens } : {}),
			inputPerMTok: rates.inputPerMTok,
			outputPerMTok: rates.outputPerMTok,
		};
		if (pending.path === "deterministic") {
			// Zero-cost path; report what the default summarizer WOULD have cost,
			// using our summary size as the output proxy.
			record.costUSD = 0;
			record.counterfactualDefaultCostUSD = defaultPathUsd;
		} else {
			// pi's built-in summarizer ran on the active model: the derived figure
			// IS the (upper-bound) actual. No separate counterfactual — this is
			// the default.
			record.costUSD = defaultPathUsd;
		}
	} else if (pending.path === "deterministic") {
		record.costUSD = 0;
	}
	return record;
}

/** Append one record as a JSONL line, creating the directory as needed. */
export async function appendEvent(
	record: CompactionEventRecord,
	agentDir?: string,
): Promise<void> {
	const file = eventsLogPath(agentDir);
	await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

// Exported for tests.
export const __internal = {
	usd,
	round6,
	resetPolicyTagCache: () => {
		policyTagCache = undefined;
	},
};
