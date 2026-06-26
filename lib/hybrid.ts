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
	minToolCallRatio: number;
	maxOrphanAssistantTokens: number;
}

export interface HybridInput {
	messages: AgentMessage[];
	tokensBefore: number;
	customInstructions?: string;
	thresholds: HybridThresholds;
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

	const metrics = {
		messageCount,
		tokenEstimate,
		toolCallCount: tcCount,
		toolCallRatio: ratio,
		orphanAssistantTokens: orphanTokens,
	};

	// Order matters: customInstructions is the most specific signal; check first.
	if (customInstructions && customInstructions.trim().length > 0) {
		return { decision: "fall-through", reason: "custom-instructions", metrics };
	}
	if (messageCount > thresholds.maxMessages) {
		return { decision: "fall-through", reason: "too-many-messages", metrics };
	}
	if (tokenEstimate > thresholds.maxTokens) {
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
