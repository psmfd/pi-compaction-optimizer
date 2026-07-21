/**
 * Pure heuristic for hybrid mode mode-of-modes selection.
 *
 * Returns `"deterministic"` when the conversation looks like an
 * orchestration/tool-call-heavy turn cluster the deterministic builder
 * handles well, or `"fall-through"` when it looks conversational /
 * planning-heavy and pi's LLM summarizer is the safer choice.
 *
 * Source: ADR-0019 § "Where deterministic falls down — and the hybrid escape".
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	orphanAssistantTokens,
	toolCallCount,
} from "./deterministic-summary.ts";

export interface HybridThresholds {
	maxMessages: number;
	maxTokens: number;
	/**
	 * Context-window-relative token gate (#244, ADR-0107). The effective token
	 * ceiling is `max(maxTokens, maxTokensFraction × contextWindow)` when the
	 * caller supplies a known context window, so threshold-triggered
	 * compactions (which fire at ~0.9 × contextWindow by construction) pass
	 * the gate regardless of model size. `maxTokens` remains the absolute
	 * floor and the sole gate when the window is unknown.
	 */
	maxTokensFraction: number;
	minToolCallRatio: number;
	maxOrphanAssistantTokens: number;
}

export interface HybridInput {
	messages: AgentMessage[];
	tokensBefore: number;
	customInstructions?: string;
	thresholds: HybridThresholds;
	/**
	 * The active model's context window in tokens, when known. Optional and
	 * explicit — `decideHybrid` stays pure; the caller reads it from
	 * `ctx.model?.contextWindow`. Undefined or non-positive values fall back
	 * to the absolute `maxTokens` gate alone (fail-open to prior behavior).
	 */
	contextWindow?: number;
}

export type HybridDecision = "deterministic" | "fall-through";

export interface HybridResult {
	decision: HybridDecision;
	/** Reason key — stable string for logs/notify/tests. */
	reason:
		| "ok"
		| "custom-instructions"
		| "too-many-messages"
		| "too-many-tokens"
		| "tool-call-ratio-low"
		| "orphan-assistant-text";
	/** Computed metrics for transparency (also helps fixture assertions). */
	metrics: {
		messageCount: number;
		tokenEstimate: number;
		toolCallCount: number;
		toolCallRatio: number;
		orphanAssistantTokens: number;
		/**
		 * The token ceiling the `too-many-tokens` gate actually compared
		 * against: `max(maxTokens, maxTokensFraction × contextWindow)` when
		 * the window was known, else `maxTokens` (ADR-0107).
		 */
		effectiveMaxTokens: number;
	};
}

/**
 * Minimum message count before the tool-call-ratio heuristic is applied.
 * A 2- or 3-message cluster has a trivially-zero ratio and would always
 * fall through, defeating the heuristic's intent. Exposed as a named
 * constant for discoverability; not project-layer settable because the
 * value is a definitional property of the heuristic, not a tunable.
 */
export const RATIO_CHECK_MIN_MESSAGES = 6;

/**
 * Decide between deterministic build and LLM fall-through. Pure function;
 * no I/O.
 *
 * Token estimate: prefer pi's `preparation.tokensBefore` when caller passes
 * it (most accurate — reflects actual provider usage); otherwise sum the
 * `ceil(chars/4)` estimator over messages.
 */
export function decideHybrid(input: HybridInput): HybridResult {
	const { messages, customInstructions, thresholds } = input;
	const messageCount = messages.length;
	const tokenEstimate =
		input.tokensBefore > 0
			? input.tokensBefore
			: messages.reduce((acc, m) => acc + estimateTokens(m), 0);
	const tcCount = toolCallCount(messages);
	const ratio = messageCount > 0 ? tcCount / messageCount : 0;
	const orphanTokens = orphanAssistantTokens(messages);
	// max() combinator: a user's explicit absolute `maxTokens` override can
	// only widen the gate relative to the window-derived ceiling, never
	// narrow it — sessions on small-window models are not gated more
	// aggressively than the absolute setting promises (ADR-0107).
	const contextWindow =
		typeof input.contextWindow === "number" && input.contextWindow > 0
			? input.contextWindow
			: undefined;
	const effectiveMaxTokens =
		contextWindow !== undefined
			? Math.max(
					thresholds.maxTokens,
					thresholds.maxTokensFraction * contextWindow,
				)
			: thresholds.maxTokens;

	const metrics = {
		messageCount,
		tokenEstimate,
		toolCallCount: tcCount,
		toolCallRatio: ratio,
		orphanAssistantTokens: orphanTokens,
		effectiveMaxTokens,
	};

	// Order matters: customInstructions is the most specific signal; check first.
	if (customInstructions && customInstructions.trim().length > 0) {
		return { decision: "fall-through", reason: "custom-instructions", metrics };
	}
	if (messageCount > thresholds.maxMessages) {
		return { decision: "fall-through", reason: "too-many-messages", metrics };
	}
	if (tokenEstimate > effectiveMaxTokens) {
		return { decision: "fall-through", reason: "too-many-tokens", metrics };
	}
	// Apply ratio check only when we have enough messages to make the ratio
	// meaningful — a 2-message cluster trivially fails any sane ratio.
	if (messageCount >= RATIO_CHECK_MIN_MESSAGES && ratio < thresholds.minToolCallRatio) {
		return { decision: "fall-through", reason: "tool-call-ratio-low", metrics };
	}
	if (orphanTokens > thresholds.maxOrphanAssistantTokens) {
		return { decision: "fall-through", reason: "orphan-assistant-text", metrics };
	}
	return { decision: "deterministic", reason: "ok", metrics };
}
