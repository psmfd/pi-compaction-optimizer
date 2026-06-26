import { test } from "node:test";
import assert from "node:assert/strict";
import { decideHybrid, type HybridThresholds } from "../lib/hybrid.ts";

const THRESHOLDS: HybridThresholds = {
	maxMessages: 200,
	maxTokens: 60000,
	minToolCallRatio: 0.3,
	maxOrphanAssistantTokens: 2000,
};

function user(text: string): unknown {
	return { role: "user", content: text, timestamp: 1 };
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
function asstTool(name: string, id: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		provider: "anthropic",
		model: "x",
		timestamp: 3,
	};
}
function toolRes(name: string, id: string): unknown {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 4,
	};
}

function toolHeavyCluster(): unknown[] {
	// 1 user, 3× (assistantToolCall + toolResult) → 7 messages, 3/7 ≈ 0.43 ratio.
	const msgs: unknown[] = [user("do work")];
	for (let i = 0; i < 3; i++) {
		msgs.push(asstTool("bash", `tc${i}`));
		msgs.push(toolRes("bash", `tc${i}`));
	}
	return msgs;
}

test("hybrid: tool-call-dense cluster → deterministic", () => {
	const r = decideHybrid({
		messages: toolHeavyCluster() as never,
		tokensBefore: 1000,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "deterministic");
	assert.equal(r.reason, "ok");
});

test("hybrid: customInstructions present → fall-through", () => {
	const r = decideHybrid({
		messages: toolHeavyCluster() as never,
		tokensBefore: 1000,
		customInstructions: "focus on X",
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "fall-through");
	assert.equal(r.reason, "custom-instructions");
});

test("hybrid: messageCount > maxMessages → fall-through", () => {
	const many: unknown[] = [];
	for (let i = 0; i < 250; i++) {
		many.push(asstTool("bash", `tc${i}`));
		many.push(toolRes("bash", `tc${i}`));
	}
	const r = decideHybrid({
		messages: many as never,
		tokensBefore: 0,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "fall-through");
	assert.equal(r.reason, "too-many-messages");
});

test("hybrid: tokensBefore > maxTokens → fall-through", () => {
	const r = decideHybrid({
		messages: toolHeavyCluster() as never,
		tokensBefore: 100000,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "fall-through");
	assert.equal(r.reason, "too-many-tokens");
});

test("hybrid: low tool-call ratio (chatty cluster) → fall-through", () => {
	const chatty: unknown[] = [];
	for (let i = 0; i < 10; i++) {
		chatty.push(user(`q${i}`));
		chatty.push(asstText(`a${i}`));
	}
	const r = decideHybrid({
		messages: chatty as never,
		tokensBefore: 1000,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "fall-through");
	assert.equal(r.reason, "tool-call-ratio-low");
});

test("hybrid: orphan-assistant-text above threshold → fall-through", () => {
	// One assistant message with a lot of text and NO follow-up toolResult.
	const longText = "x".repeat(20000); // ~5000 tokens worth of orphan
	const r = decideHybrid({
		messages: [user("explain"), asstText(longText)] as never,
		tokensBefore: 1000,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "fall-through");
	assert.equal(r.reason, "orphan-assistant-text");
});

test("hybrid: ratio check is suppressed for short clusters (<6 messages)", () => {
	// 3 messages, 0 tool calls → ratio is 0 but we skip the check.
	const r = decideHybrid({
		messages: [user("x"), asstText("y"), user("z")] as never,
		tokensBefore: 100,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.decision, "deterministic");
	assert.equal(r.reason, "ok");
});

test("hybrid: metrics block reports computed values", () => {
	const r = decideHybrid({
		messages: toolHeavyCluster() as never,
		tokensBefore: 12345,
		thresholds: THRESHOLDS,
	});
	assert.equal(r.metrics.messageCount, 7);
	assert.equal(r.metrics.toolCallCount, 3);
	assert.equal(r.metrics.tokenEstimate, 12345); // tokensBefore takes precedence
	assert.ok(r.metrics.toolCallRatio > 0.4 && r.metrics.toolCallRatio < 0.5);
});

test("hybrid: falls back to chars/4 token estimate when tokensBefore=0", () => {
	const r = decideHybrid({
		messages: [user("hello world")] as never,
		tokensBefore: 0,
		thresholds: THRESHOLDS,
	});
	// "hello world" = 11 chars → ceil(11/4) = 3
	assert.equal(r.metrics.tokenEstimate, 3);
});
