import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildDeterministicSummary,
	estimateTokens,
	orphanAssistantTokens,
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
	const sections = [
		"## Goal",
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
			assistantToolCall("subagent", { tasks: [{ agent: "linter", task: "x" }] }, "tc-2"),
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

test("buildDeterministicSummary: parallel fan-out emits one verdict row per task", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall(
				"subagent",
				{
					tasks: [
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
	assert.match(out, /## Goal[\s\S]*no user message in summarized span/);
	assert.match(out, /\(none\)/);
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

test("verdict extraction #229: real subagent format (`Parallel: N/M succeeded` preamble + `\\n---\\n` separators)", () => {
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall(
				"subagent",
				{
					tasks: [
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
					"Parallel: 3/3 succeeded",
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
					tasks: [
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

test("verdict extraction #229: Form B `<!-- END REPORT -->` shields nested verdicts inside the block", () => {
	// The inner report block quotes a chain of prior verdicts. The agent's
	// OWN verdict line is contractually after `<!-- END REPORT -->`. The
	// scope-after-last-END-REPORT rule must apply.
	const out = buildDeterministicSummary({
		messagesToSummarize: [
			userMsg("/review"),
			assistantToolCall("subagent", { tasks: [{ agent: "code-review-expert", task: "x" }] }, "tc-formB"),
			toolResult(
				"subagent",
				"tc-formB",
				[
					"### [code-review-expert] completed",
					"",
					"<!-- BEGIN REPORT -->",
					"Prior cycle artifacts:",
					"Verdict: NEEDS_CHANGES",
					"Verdict: PRECONDITION_FAILURE",
					"Verdict: PASS_WITH_WARNINGS",
					"<!-- END REPORT -->",
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
	// Inspect the verdict-column value for the single row — the brief column
	// naturally echoes the raw text (incl. inner-block verdicts), so we can't
	// assert globally on the verdict tokens. The fix's contract is that the
	// Verdict CELL is `PASS`, not one of the shielded inner verdicts.
	const row = out.split("\n").find((l) => /code-review-expert/.test(l) && /\|/.test(l));
	assert.ok(row, `expected a verdict row for code-review-expert; got:\n${out}`);
	const cells = row.split("|").map((c) => c.trim());
	// Row shape: `| `agent` | VERDICT | brief |` → split yields 5 entries
	// (leading & trailing empties + 3 cells).
	const verdictCell = cells[2];
	assert.equal(verdictCell, "PASS", `verdict cell must be the post-END-REPORT VERDICT ("PASS"); got "${verdictCell}" from row: ${row}`);
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
				{ tasks: [{ agent: "agent-a", task: "x" }, { agent: "agent-b", task: "y" }] },
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
