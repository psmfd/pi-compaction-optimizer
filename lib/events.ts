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
 * Cost bases (ADR-0151; supersedes ADR-0117):
 *   - "zero"     — deterministic builder: no model call.
 *   - "reported" — the committed CompactionEntry carries provider-reported
 *     usage and pi's usage-based cost. This is the normal built-in summarizer
 *     path in pinned pi v0.84.2-psmfd.1 (#840).
 *   - "derived"  — backward-compatible fallback when committed usage is absent
 *     or lacks a finite total cost. Reconstructed from tokensBefore and the
 *     estimated summary size; an upper bound, not provider-reported usage.
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
import type { Usage } from "@earendil-works/pi-ai";

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
	/** Provider-reported token/cache components; present for reported rows. */
	usage?: Omit<Usage, "cost">;
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

interface NormalizedCommittedUsage {
	usage: Omit<Usage, "cost">;
	costTotal: number;
}

function isTokenCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Accept only finite, non-negative, safely serializable runtime usage. */
function normalizeCommittedUsage(value: unknown): NormalizedCommittedUsage | undefined {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		const raw = value as {
			input?: unknown;
			output?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
			cacheWrite1h?: unknown;
			reasoning?: unknown;
			totalTokens?: unknown;
			cost?:
				| {
						input?: unknown;
						output?: unknown;
						cacheRead?: unknown;
						cacheWrite?: unknown;
						total?: unknown;
				  }
				| null;
		};
		// Snapshot each accessor exactly once. A stateful getter or proxy must not
		// change a field between validation and construction of the ledger record.
		const input = raw.input;
		const output = raw.output;
		const cacheRead = raw.cacheRead;
		const cacheWrite = raw.cacheWrite;
		const cacheWrite1h = raw.cacheWrite1h;
		const reasoning = raw.reasoning;
		const totalTokens = raw.totalTokens;
		const cost = raw.cost;
		if (
			!isTokenCount(input) ||
			!isTokenCount(output) ||
			!isTokenCount(cacheRead) ||
			!isTokenCount(cacheWrite) ||
			!isTokenCount(totalTokens) ||
			(cacheWrite1h !== undefined && !isTokenCount(cacheWrite1h)) ||
			(reasoning !== undefined && !isTokenCount(reasoning))
		) {
			return undefined;
		}
		if (typeof cost !== "object" || cost === null) return undefined;
		const costInput = cost.input;
		const costOutput = cost.output;
		const costCacheRead = cost.cacheRead;
		const costCacheWrite = cost.cacheWrite;
		const costTotalRaw = cost.total;
		if (
			!isCost(costInput) ||
			!isCost(costOutput) ||
			!isCost(costCacheRead) ||
			!isCost(costCacheWrite) ||
			!isCost(costTotalRaw)
		) {
			return undefined;
		}
		const costTotal = round6(costTotalRaw);
		if (!Number.isFinite(costTotal)) return undefined;
		return {
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
				...(reasoning !== undefined ? { reasoning } : {}),
				totalTokens,
			},
			costTotal,
		};
	} catch {
		// Type assertions do not validate runtime event data. Any accessor or
		// proxy failure degrades to derived accounting instead of dropping the row.
		return undefined;
	}
}

/**
 * Complete a pending record into the final ledger line. Pure — clock and
 * summary size are inputs, not reads — so tests pin the math exactly.
 *
 * `committedSummaryTokens` is the chars/4 estimate of the summary pi actually
 * committed (from `CompactionEntry.summary`); for the deterministic path the
 * pending record's own `summaryTokens` (identical text) takes precedence.
 * `committedUsage` is untrusted runtime data from `CompactionEntry.usage`. A
 * complete, finite, non-negative usage object takes precedence over derived
 * reconstruction on every non-deterministic path.
 */
export function buildEventRecord(opts: {
	pending: PendingEvent;
	committedSummaryTokens?: number;
	committedUsage?: unknown;
	now: number;
	ts: string;
	policy: string;
}): CompactionEventRecord {
	const { pending, ts, policy } = opts;
	const summaryTokens = pending.summaryTokens ?? opts.committedSummaryTokens;
	const latencyMs = Math.max(0, Math.round(opts.now - pending.t0));
	const normalizedUsage =
		pending.path === "deterministic"
			? undefined
			: normalizeCommittedUsage(opts.committedUsage);

	const record: CompactionEventRecord = {
		ts,
		sessionId: pending.sessionId,
		policy,
		mode: pending.mode,
		path: pending.path,
		tokensBefore: pending.tokensBefore,
		latencyMs,
		costBasis:
			pending.path === "deterministic"
				? "zero"
				: normalizedUsage !== undefined
					? "reported"
					: "derived",
	};
	if (pending.reason !== undefined) record.reason = pending.reason;
	if (pending.rung !== undefined) record.rung = pending.rung;
	if (summaryTokens !== undefined) record.summaryTokens = summaryTokens;
	if (pending.model !== undefined) record.model = pending.model;
	if (pending.provider !== undefined) record.provider = pending.provider;
	if (pending.metrics !== undefined) record.metrics = pending.metrics;

	if (normalizedUsage !== undefined) {
		record.costUSD = normalizedUsage.costTotal;
		record.usage = normalizedUsage.usage;
		return record;
	}

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
			// No finite committed usage cost was available. Preserve ADR-0117's
			// reconstruction as an explicit backward-compatible fallback.
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
