import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildAtRung,
	buildDeterministicSummary,
	estimateSummaryTokens,
	estimateTokens,
	orphanAssistantTokens,
	RUNG_ORDER,
	toolCallCount,
	type FileOperationsLike,
} from "../lib/deterministic-summary.ts";

// Minimal AgentMessage builders. Structural typing keeps us decoupled from
// the un-bundled `@earendil-works/pi-agent-core` types.
function userMsg(text: string, ts = 1): unknown {
	return { role: "user", content: text, timestamp: ts };
}
function assistantText(text: string, ts = 2): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "anthropic",
		model: "claude",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: ts,
	};
}
function assistantToolCall(name: string, args: Record<string, unknown>, id = "tc1", ts = 3): unknown {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		provider: "anthropic",
		model: "claude",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: ts,
	};
}
function toolResult(toolName: string, toolCallId: string, text: string, ts = 4): unknown {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	};
}
function bashExec(command: string, output: string, ts = 5): unknown {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: ts,
	};
}

function emptyFileOps(): FileOperationsLike {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

test("buildDeterministicSummary: byte-identical across two runs with same input", () => {
	const fileOps: FileOperationsLike = {
		read: new Set(["src/a.ts", "src/b.ts"]),
		written: new Set(["src/c.ts"]),
		edited: new Set(["src/a.ts"]),
	};
	const input = {
		messagesToSummarize: [
			userMsg("First request: implement X"),
			assistantText("Sure, I'll start."),
			assistantToolCall("read", { path: "src/a.ts" }, "tc1"),
			toolResult("read", "tc1", "file body"),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps,
		tokensBefore: 12345,
		generatedAt: "2026-05-26T15:30:00.000Z",
		customInstructionsDropped: false,
	};
	const a = buildDeterministicSummary(input);
	const b = buildDeterministicSummary(input);
	assert.equal(a, b, "two invocations must produce byte-identical output");
});

test("buildDeterministicSummary: section ordering and headings", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("Goal text")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	// `## Goal` was removed as unconditional dedup of User Turns #1 (#254).
	const sections = [
		"## User Turns (verbatim)",
		"## File Activity",
		"## Tool Activity Summary",
		"## Subagent Verdicts",
		"## Compaction Metadata",
	];
	let last = -1;
	for (const s of sections) {
		const idx = out.indexOf(s);
		assert.ok(idx > last, `${s} must come after the previous section (last=${last}, idx=${idx})`);
		last = idx;
	}
	assert.ok(!out.includes("## Goal"), "## Goal is dedup-dropped at every rung (#254)");
});

test("buildDeterministicSummary: file list is sorted (defeats Set insertion-order leakage)", () => {
	const fileOps: FileOperationsLike = {
		read: new Set(["z.ts", "a.ts", "m.ts"]),
		written: new Set(),
		edited: new Set(),
	};
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("x")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps,
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	const a = out.indexOf("`a.ts`");
	const m = out.indexOf("`m.ts`");
	const z = out.indexOf("`z.ts`");
	assert.ok(a > 0 && m > a && z > m, "file paths must render in lexical order");
});

test("buildDeterministicSummary: customInstructionsDropped footer present iff flag set", () => {
	const base = {
		messagesToSummarize: [userMsg("x")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
	};
	const without = buildDeterministicSummary({ ...base, customInstructionsDropped: false });
	const withFlag = buildDeterministicSummary({ ...base, customInstructionsDropped: true });
	assert.ok(!without.includes("not honored"), "footer must be absent when flag is false");
	assert.ok(withFlag.includes("not honored"), "footer must be present when flag is true");
});

test("buildDeterministicSummary: split-turn renders Turn Prefix section", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("history")] as never,
		turnPrefixMessages: [userMsg("prefix-user"), assistantText("prefix-assistant")] as never,
		isSplitTurn: true,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /## Turn Prefix \(split turn\)/);
	assert.match(out, /prefix-user/);
	assert.match(out, /prefix-assistant/);
	assert.match(out, /is_split_turn: true/);
});

test("buildDeterministicSummary: subagent verdict extraction (permissive)", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall("subagent", { agent: "code-review-expert" }, "tc-1"),
			toolResult(
				"subagent",
				"tc-1",
				"some prelude\n\n**Verdict:** PASS_WITH_WARNINGS\n\nmore text",
			),
			assistantToolCall("subagent", { sequence: [{ agent: "linter", task: "x" }] }, "tc-2"),
			toolResult(
				"subagent",
				"tc-2",
				"REPORT_FILE: .review/linter/out.md\n\nVerdict: PASS",
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /code-review-expert.*PASS_WITH_WARNINGS/);
	assert.match(out, /linter.*PASS.*REPORT_FILE: \.review\/linter\/out\.md/);
});

test("buildDeterministicSummary: tool activity counts include bash last-command", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("run"),
			assistantToolCall("bash", { command: "ls" }, "tc-a"),
			toolResult("bash", "tc-a", "files"),
			assistantToolCall("bash", { command: "pwd" }, "tc-b"),
			toolResult("bash", "tc-b", "/tmp"),
			bashExec("pwd", "/tmp"),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /`bash`: 2 invocations.*`pwd`/);
});

test("buildDeterministicSummary: previousSummary renders Carried-Forward Context", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("x")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		previousSummary: "## Prior Summary\n\nWe were working on X.",
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /## Carried-Forward Context/);
	assert.match(out, /We were working on X\./);
});

// #253 — previousSummary recursion bug coverage.
test("buildDeterministicSummary: previousSummary truncated to default cap with marker", () => {
	const big = "A".repeat(5000); // 5000 chars, default cap is 500
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("x")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		previousSummary: big,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /## Carried-Forward Context/);
	assert.match(out, /prior summary truncated; full text preserved in archive/);
	// Only the first 500 'A's should appear in the carried-forward section.
	// Extract that section to count just our payload, avoiding 'A' chars from
	// header words like 'Activity'.
	const section = out.split("## Carried-Forward Context")[1] ?? "";
	const payload = section.split("_(prior summary truncated")[0] ?? "";
	const aCount = (payload.match(/A/g) ?? []).length;
	assert.equal(aCount, 500, `expected 500 'A' chars in carried-forward section, got ${aCount}`);
});

test("buildDeterministicSummary: previousSummaryMaxChars=0 omits section entirely", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("x")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		previousSummary: "## Prior Summary\n\nWe were working on X.",
		previousSummaryMaxChars: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.doesNotMatch(out, /## Carried-Forward Context/);
	assert.doesNotMatch(out, /We were working on X\./);
	assert.doesNotMatch(out, /prior summary truncated/);
});

test("buildDeterministicSummary: previousSummaryMaxChars=10000 (over actual length) preserves full text", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg("x")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		previousSummary: "## Prior Summary\n\nWe were working on X.",
		previousSummaryMaxChars: 10000,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /## Carried-Forward Context/);
	assert.match(out, /We were working on X\./);
	assert.doesNotMatch(out, /prior summary truncated/);
});

test("buildDeterministicSummary: bounded growth across simulated 3 successive compactions (#253)", () => {
	// Simulate the geometric-growth scenario: each compaction's output is fed
	// back as the next compaction's previousSummary. Without the cap, S_3 would
	// be roughly 3x the per-compaction baseline. With the default cap of 500,
	// S_3 should be bounded to baseline + cap + marker overhead.
	const baseInput = {
		messagesToSummarize: [userMsg("first user message in this compaction")] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	};
	const s0 = buildDeterministicSummary({ ...baseInput, previousSummary: undefined });
	const s1 = buildDeterministicSummary({ ...baseInput, previousSummary: s0 });
	const s2 = buildDeterministicSummary({ ...baseInput, previousSummary: s1 });
	const s3 = buildDeterministicSummary({ ...baseInput, previousSummary: s2 });

	// Each successive summary's length must not exceed S_0 + cap + small overhead
	// for the section header (~30 chars) + truncation marker (~70 chars).
	const CAP = 500;
	const OVERHEAD = 200;
	const upperBound = s0.length + CAP + OVERHEAD;
	assert.ok(
		s3.length <= upperBound,
		`s3 length ${s3.length} exceeds upper bound ${upperBound} (s0=${s0.length}, cap=${CAP}); geometric growth not bounded`,
	);
	// Also assert that successive summaries asymptote (don't grow without bound).
	assert.ok(
		s3.length - s2.length <= OVERHEAD,
		`s3-s2 delta ${s3.length - s2.length} exceeds overhead ${OVERHEAD}; not asymptoting`,
	);
});

test("estimateTokens: chars/4 heuristic (matches pi)", () => {
	// 12 chars text → ceil(12/4) = 3 tokens.
	const t = estimateTokens(userMsg("abcdefghijkl") as never);
	assert.equal(t, 3);
});

test("orphanAssistantTokens: counts assistant text NOT followed by toolResult", () => {
	const orphan = orphanAssistantTokens([
		assistantText("explaining at length…"),  // orphan (no follow-up)
		userMsg("ok"),
		assistantText("more reasoning"),        // orphan
		assistantToolCall("bash", { command: "x" }, "tc-1"),
		toolResult("bash", "tc-1", "ok"),       // makes tool-call non-orphan
	] as never);
	assert.ok(orphan > 0);
});

test("toolCallCount: sums toolCall blocks across assistant messages", () => {
	assert.equal(
		toolCallCount([
			assistantToolCall("read", {}, "a"),
			assistantToolCall("bash", {}, "b"),
			assistantText("no tool"),
		] as never),
		2,
	);
});

test("buildDeterministicSummary: serial sequence emits one verdict row per item", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall(
				"subagent",
				{
					sequence: [
						{ agent: "code-review-expert", task: "x" },
						{ agent: "security-review-expert", task: "y" },
						{ agent: "linter", task: "z" },
					],
				},
				"tc-fan",
			),
			toolResult(
				"subagent",
				"tc-fan",
				"### [code-review-expert]\n\nVerdict: PASS_WITH_WARNINGS\n\n### [security-review-expert]\n\nVerdict: NEEDS_CHANGES\n\n### [linter]\n\nVerdict: PASS",
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /code-review-expert.*PASS_WITH_WARNINGS/);
	assert.match(out, /security-review-expert.*NEEDS_CHANGES/);
	assert.match(out, /linter.*PASS\b/);
});

test("buildDeterministicSummary: user turns are capped per-message (no unbounded paste leak)", () => {
	const hugePaste = "X".repeat(50000);
	const out = buildDeterministicSummary({
		messagesToSummarize: [userMsg(hugePaste)] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.ok(out.length < 10000, `expected truncated output; got ${out.length} chars`);
	assert.match(out, /…/, "expected ellipsis marker indicating truncation");
});

test("buildDeterministicSummary: agent name and REPORT_FILE backticks/pipes are escaped in verdict table", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall("subagent", { agent: "weird`name|here" }, "tc-weird"),
			toolResult("subagent", "tc-weird", "REPORT_FILE: weird`path|name.md\n\nVerdict: PASS"),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /weird\\`name\\\|here/, "agent name must escape backtick and pipe");
	assert.match(out, /weird\\`path\\\|name\.md/, "REPORT_FILE must escape backtick and pipe");
});

test("buildDeterministicSummary: empty input degrades gracefully", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /## User Turns \(verbatim\)[\s\S]*\(none\)/);
	assert.match(out, /entries_summarized: 0/);
});

// ---------------------------------------------------------------------------
// Header-attributed verdict extraction (#229) — guards against the original
// positional-pairing bug where the Nth `Verdict:` match was paired with the
// Nth call-arg agent. Now: parallel toolResults are segmented by the
// `### [<agent>] <status>` headers the subagent extension emits, and each
// segment's verdict is attributed to that header's agent name. Form B
// `<!-- END REPORT -->` markers shield the verdict scan from nested quoted
// reports. Non-conforming toolResults fall back to the global scan capped
// at agents.length.
// ---------------------------------------------------------------------------

test("verdict extraction #229: real serial sequence preamble and separators", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall(
				"subagent",
				{
					sequence: [
						{ agent: "code-review-expert", task: "x" },
						{ agent: "security-review-expert", task: "y" },
						{ agent: "linter", task: "z" },
					],
				},
				"tc-real",
			),
			toolResult(
				"subagent",
				"tc-real",
				[
					"Sequence: 3/3 succeeded",
					"",
					"### [code-review-expert] completed",
					"",
					"<!-- BEGIN REPORT -->",
					"...findings...",
					"<!-- END REPORT -->",
					"Summary: looks good.",
					"VERDICT: PASS_WITH_WARNINGS",
					"",
					"---",
					"",
					"### [security-review-expert] completed",
					"",
					"<!-- BEGIN REPORT -->",
					"...findings...",
					"<!-- END REPORT -->",
					"Summary: one high-severity item.",
					"VERDICT: NEEDS_CHANGES",
					"",
					"---",
					"",
					"### [linter] completed",
					"",
					"REPORT_FILE: /tmp/subagent-linter-123.md",
					"Summary: clean.",
					"VERDICT: PASS",
				].join("\n"),
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /code-review-expert.*PASS_WITH_WARNINGS/);
	assert.match(out, /security-review-expert.*NEEDS_CHANGES/);
	assert.match(out, /linter.*PASS\b/);
});

test("verdict extraction #229: quoted inner `Verdict:` in one segment does not mis-attribute", () => {
	// security-review-expert quotes a child report containing
	// `Verdict: NEEDS_CHANGES`. The outer agent's own verdict is PASS.
	// Pre-#229 positional pairing would attribute NEEDS_CHANGES to security
	// (Nth match) and shift code-review's PASS to linter, etc.
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall(
				"subagent",
				{
					sequence: [
						{ agent: "code-review-expert", task: "x" },
						{ agent: "security-review-expert", task: "y" },
					],
				},
				"tc-quote",
			),
			toolResult(
				"subagent",
				"tc-quote",
				[
					"### [code-review-expert] completed",
					"",
					"Summary: no issues.",
					"VERDICT: PASS",
					"",
					"---",
					"",
					"### [security-review-expert] completed",
					"",
					"While reviewing, I noticed an old report that said:",
					"  > Verdict: NEEDS_CHANGES",
					"  > Verdict: PRECONDITION_FAILURE",
					"That was a prior cycle. My finding:",
					"VERDICT: PASS",
				].join("\n"),
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	// security-review-expert's OWN terminal verdict wins (last in segment).
	assert.match(out, /security-review-expert.*PASS\b/);
	assert.doesNotMatch(out, /security-review-expert.*NEEDS_CHANGES/);
	assert.doesNotMatch(out, /security-review-expert.*PRECONDITION_FAILURE/);
	// code-review-expert is unaffected.
	assert.match(out, /code-review-expert.*PASS\b/);
});

test("verdict extraction #229: fenced Form B shields nested verdicts inside the report", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall("subagent", { sequence: [{ agent: "code-review-expert", task: "x" }] }, "tc-formB"),
			toolResult(
				"subagent",
				"tc-formB",
				[
					"### [code-review-expert] completed",
					"",
					"```report",
					"Prior cycle artifacts:",
					"Verdict: NEEDS_CHANGES",
					"Verdict: PRECONDITION_FAILURE",
					"Verdict: PASS_WITH_WARNINGS",
					"```",
					"",
					"Summary: all clean.",
					"VERDICT: PASS",
				].join("\n"),
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	const row = out.split("\n").find((line) => /code-review-expert/.test(line) && /\|/.test(line));
	assert.ok(row, `expected a verdict row for code-review-expert; got:\n${out}`);
	const cells = row.split("|").map((cell) => cell.trim());
	assert.equal(cells[2], "PASS", `verdict cell must use the post-fence verdict; row: ${row}`);
});

test("verdict extraction #229: single-mode toolResult (no headers) still works via fallback", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall("subagent", { agent: "code-review-expert" }, "tc-single"),
			toolResult(
				"subagent",
				"tc-single",
				"Prelude text.\n\nREPORT_FILE: /tmp/x.md\n\nVerdict: PASS_WITH_WARNINGS",
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /code-review-expert.*PASS_WITH_WARNINGS/);
	assert.match(out, /\/tmp\/x\.md/);
});

test("verdict extraction #229: fallback caps row count to agents.length (fail-closed)", () => {
	// Non-conforming output: no `### [<agent>]` headers, but multiple
	// `Verdict:` lines (e.g., a quoted prior conversation). With 2 agents
	// in the call and 4 Verdict matches in the text, only 2 rows must be
	// emitted — fail-closed rather than manufacture phantom rows.
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall(
				"subagent",
				{ sequence: [{ agent: "agent-a", task: "x" }, { agent: "agent-b", task: "y" }] },
				"tc-noheader",
			),
			toolResult(
				"subagent",
				"tc-noheader",
				[
					"Some preamble without headers.",
					"Verdict: PASS",
					"Verdict: NEEDS_CHANGES",
					"Verdict: PASS_WITH_WARNINGS",
					"Verdict: PRECONDITION_FAILURE",
				].join("\n"),
			),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	// Exactly 2 rows in the verdict table (one per agent). Agent names are
	// rendered in backticks for table-cell safety.
	const tableRows = out.split("\n").filter((l) => /^\|\s*`agent-/.test(l));
	assert.equal(tableRows.length, 2, `expected 2 verdict rows; got ${tableRows.length}\n${out}`);
	assert.match(out, /agent-a.*PASS\b/);
	assert.match(out, /agent-b.*NEEDS_CHANGES/);
});

// ---------------------------------------------------------------------------
// Shrink ladder (#254, ADR-0108)
// ---------------------------------------------------------------------------

function richInput() {
	const messages: unknown[] = [];
	// 15 user turns so trimmed (first + last 9) and stub (first + last 2) elide.
	for (let i = 1; i <= 15; i++) {
		messages.push(userMsg(`turn-${i} ${"x".repeat(60)}`, i));
		messages.push(assistantToolCall("bash", { command: `cmd${i}` }, `tc${i}`, i));
		messages.push(toolResult("bash", `tc${i}`, "ok", i));
	}
	messages.push(assistantToolCall("subagent", { agent: "linter" }, "tc-sub", 90));
	messages.push(
		toolResult("subagent", "tc-sub", "brief text here\n\nREPORT_FILE: .review/x.md\n\nVerdict: PASS", 91),
	);
	messages.push(bashExec("echo " + "y".repeat(200), "out", 95));
	const turnPrefix: unknown[] = [];
	for (let i = 0; i < 20; i++) turnPrefix.push(assistantText(`prefix-${i}`, 100 + i));
	return {
		messagesToSummarize: messages as never,
		turnPrefixMessages: turnPrefix as never,
		isSplitTurn: true,
		previousSummary: "prior summary content",
		fileOps: {
			read: new Set(["r1.ts", "r2.ts"]),
			written: new Set(["w1.ts"]),
			edited: new Set(["e1.ts"]),
		} as FileOperationsLike,
		tokensBefore: 5000,
		generatedAt: "2026-07-20T00:00:00.000Z",
		customInstructionsDropped: true,
	};
}

test("buildAtRung: every rung is byte-deterministic for identical input", () => {
	const input = richInput();
	for (const rung of RUNG_ORDER) {
		const a = buildAtRung(input, rung);
		const b = buildAtRung(input, rung);
		assert.equal(a, b, `rung ${rung} must be byte-deterministic`);
	}
});

test("buildAtRung: rungs drop sections cumulatively and never grow output", () => {
	const input = richInput();
	const outputs = RUNG_ORDER.map((r) => buildAtRung(input, r));
	// Monotonic non-increase down the ladder.
	for (let i = 1; i < outputs.length; i++) {
		assert.ok(
			outputs[i].length <= outputs[i - 1].length,
			`rung ${RUNG_ORDER[i]} output (${outputs[i].length}) must not exceed ${RUNG_ORDER[i - 1]} (${outputs[i - 1].length})`,
		);
	}
	const at = (rung: string) => outputs[RUNG_ORDER.indexOf(rung as never)];
	// full keeps everything (except the dedup-dropped Goal).
	assert.match(at("full"), /## File Activity/);
	assert.match(at("full"), /## Tool Activity Summary/);
	assert.match(at("full"), /\| Agent \| Verdict \| Brief \|/);
	assert.match(at("full"), /## Turn Prefix \(split turn\)/);
	assert.match(at("full"), /## Carried-Forward Context/);
	// no-file-activity drops File Activity, keeps Tool Activity.
	assert.ok(!at("no-file-activity").includes("## File Activity"));
	assert.match(at("no-file-activity"), /## Tool Activity Summary/);
	// no-tools also drops Tool Activity (cumulative).
	assert.ok(!at("no-tools").includes("## File Activity"));
	assert.ok(!at("no-tools").includes("## Tool Activity Summary"));
	// no-verdict-brief collapses the table to Agent|Verdict|Ref.
	assert.match(at("no-verdict-brief"), /\| Agent \| Verdict \| Ref \|/);
	assert.ok(!at("no-verdict-brief").includes("brief text here"));
	assert.match(at("no-verdict-brief"), /\.review\/x\.md/);
	// no-prefix drops the Turn Prefix section.
	assert.ok(!at("no-prefix").includes("## Turn Prefix"));
	// no-carried-forward drops Carried-Forward even though previousSummary set.
	assert.ok(!at("no-carried-forward").includes("## Carried-Forward Context"));
	// trimmed-turns keeps turn 1 + last 9 with an elision marker.
	assert.match(at("trimmed-turns"), /1\. turn-1 /);
	assert.match(at("trimmed-turns"), /15\. turn-15 /);
	assert.match(at("trimmed-turns"), /5 earlier turns elided/);
	assert.ok(!/\n3\. turn-3 /.test(at("trimmed-turns")), "turn 3 must be elided at trimmed-turns");
	// stub: turn 1 + last 2, two-column verdict table, footer dropped.
	assert.match(at("stub"), /1\. turn-1 /);
	assert.match(at("stub"), /14\. turn-14 /);
	assert.match(at("stub"), /\| Agent \| Verdict \|\n\|---\|---\|/);
	assert.ok(!at("stub").includes("| Brief |") && !at("stub").includes("| Ref |"));
	assert.ok(!at("stub").includes("not honored"), "instructions footer dropped at stub");
	// Compaction Metadata survives EVERY rung (ADR-0108 invariant).
	for (let i = 0; i < outputs.length; i++) {
		assert.match(outputs[i], /## Compaction Metadata/, `metadata missing at ${RUNG_ORDER[i]}`);
		assert.match(outputs[i], /generated_by: compaction-optimizer \(deterministic\)/);
	}
});

test("buildAtRung: stub degrades gracefully at 0 and 1 user turns", () => {
	const base = { ...richInput(), messagesToSummarize: [] as never };
	const none = buildAtRung(base, "stub");
	assert.match(none, /## User Turns \(verbatim\)[\s\S]*\(none\)/);
	const one = buildAtRung(
		{ ...richInput(), messagesToSummarize: [userMsg("only turn")] as never },
		"stub",
	);
	assert.match(one, /1\. only turn/);
	assert.ok(!one.includes("elided"), "no elision marker with a single turn");
});

test("renderTurnPrefix: aggregate cap keeps last 12 messages with elision marker", () => {
	const input = richInput(); // 20 prefix messages
	const out = buildAtRung(input, "full");
	assert.match(out, /8 earlier prefix messages elided/);
	assert.ok(!out.includes("**assistant** — prefix-7"), "message 8 (index 7) must be elided");
	assert.match(out, /9\. \*\*assistant\*\* — prefix-8/);
	assert.match(out, /20\. \*\*assistant\*\* — prefix-19/);
});

test("renderToolActivity: bash last-command truncated to 80 chars", () => {
	const out = buildAtRung(richInput(), "full");
	const m = /\(last: `([^`]+)`\)/.exec(out);
	assert.ok(m, "expected a (last: ...) suffix");
	assert.ok(m[1].length <= 81, `last-command must be capped (~80 chars), got ${m[1].length}`);
	assert.match(m[1], /…$/);
});

test("estimateSummaryTokens: chars/4 ceiling", () => {
	assert.equal(estimateSummaryTokens(""), 0);
	assert.equal(estimateSummaryTokens("abcd"), 1);
	assert.equal(estimateSummaryTokens("abcde"), 2);
});

test("buildDeterministicSummary === buildAtRung(input, 'full') (back-compat wrapper)", () => {
	const input = richInput();
	assert.equal(buildDeterministicSummary(input), buildAtRung(input, "full"));
});

// -----------------------------------------------------------------------------
// VERDICT_RE backtracking safety (CodeQL js/polynomial-redos, mirror alert #3).
// The regex scans unbounded subagent-transcript text; the separator structure
// must keep a long whitespace run to a single parse. These tests pin (a) form
// parity for the rewritten separators and (b) linear-time behavior on the
// adversarial input that was polynomial under the old adjacent-`\s*` shape.
// -----------------------------------------------------------------------------

test("verdict extraction: separator form parity (space-before-colon, bold value, no-space colon)", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall("subagent", { agent: "spaced-colon" }, "tc-f1"),
			toolResult("subagent", "tc-f1", "Verdict : PASS"),
			assistantToolCall("subagent", { agent: "bold-value" }, "tc-f2"),
			toolResult("subagent", "tc-f2", "Verdict: **NEEDS_CHANGES**"),
			assistantToolCall("subagent", { agent: "tight-colon" }, "tc-f3"),
			toolResult("subagent", "tc-f3", "Verdict:PASS_WITH_WARNINGS"),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	assert.match(out, /spaced-colon.*PASS/);
	assert.match(out, /bold-value.*NEEDS_CHANGES/);
	assert.match(out, /tight-colon.*PASS_WITH_WARNINGS/);
});

test("verdict extraction: 'Verdict' + long whitespace run without a verdict completes fast (ReDoS)", () => {
	// Old regex: three ambiguous adjacent `\s*` runs -> O(N^2) splits on this
	// input (N = 100_000 hangs for minutes). New regex parses it once.
	const attack = `prelude\nVerdict${" ".repeat(100_000)}not-a-verdict\n`;
	const started = Date.now();
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("go"),
			assistantToolCall("subagent", { agent: "hostile" }, "tc-redos"),
			toolResult("subagent", "tc-redos", attack),
		] as never,
		turnPrefixMessages: [] as never,
		isSplitTurn: false,
		fileOps: emptyFileOps(),
		tokensBefore: 0,
		generatedAt: "2026-01-01T00:00:00.000Z",
		customInstructionsDropped: false,
	});
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2_000, `verdict scan must be linear-time; took ${elapsed}ms`);
	assert.ok(!/hostile.*(PASS|NEEDS_CHANGES)/.test(out), "no phantom verdict row from the attack string");
});
