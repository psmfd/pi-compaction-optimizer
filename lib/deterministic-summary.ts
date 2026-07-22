/**
 * Pure deterministic summary builder.
 *
 * Walks the pre-cut `messagesToSummarize` (and `turnPrefixMessages` when
 * `isSplitTurn`) once and emits a markdown checkpoint shaped per ADR-0019
 * § Design Discussion / "Proposed deterministic schema (PR2 implementation
 * target)". No I/O. No timestamps that vary between runs (caller supplies
 * `generatedAt`). No tokenizer dependency — orphan-assistant text and the
 * hybrid heuristic both use the same `ceil(charLength / 4)` estimator pi
 * itself documents (see pi-mono@v0.75.5 compaction.ts `estimateTokens`).
 *
 * Determinism contract: given identical inputs, two invocations produce
 * byte-identical output. Iteration over `Set<string>` (fileOps) is replaced
 * by `[...set].sort()` to defeat insertion-order leakage. No random suffixes.
 *
 * Source rules:
 * - ADR-0019 §Decision Outcome (mode taxonomy, `details` shape)
 * - ADR-0019 §Design Discussion (markdown schema)
 * - rules/structured-review-format.md (subagent verdict extraction)
 * - rules/subagent-parallel-handoff.md (Form A REPORT_FILE: extraction)
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * FileOperations mirrors `@earendil-works/pi-coding-agent`'s
 * `core/compaction/utils.ts:FileOperations`. We do not import the type
 * directly because the vendored runtime ships without `.d.ts` for the
 * coding-agent package; structural typing keeps us decoupled.
 */
export interface FileOperationsLike {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface BuildInput {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	previousSummary?: string;
	/**
	 * Cap on characters of `previousSummary` re-inlined into the
	 * `## Carried-Forward Context` section. 0 = omit the section entirely;
	 * undefined defaults to `DEFAULT_PREVIOUS_SUMMARY_MAX_CHARS` for
	 * backwards-compatibility with callers that don't yet thread the setting.
	 * Bounds geometric growth across compactions (#253).
	 */
	previousSummaryMaxChars?: number;
	fileOps: FileOperationsLike;
	tokensBefore: number;
	/** Injected for fixture determinism — never default to `Date.now()`. */
	generatedAt: string;
	/**
	 * True when the user supplied `/compact <instructions>` and the dispatcher
	 * chose deterministic mode. Renders a footer disclaimer; does NOT inject
	 * the instructions into the summary body.
	 */
	customInstructionsDropped: boolean;
}

/**
 * Default cap on re-inlined `previousSummary` chars when `BuildInput` does
 * not specify one. Mirrors `DEFAULTS.hybrid.previousSummaryMaxChars` in
 * `settings.ts`; the sync is asserted by a cross-import test in
 * `settings.test.ts`. Production dispatch always threads the Required
 * setting, so this fallback is reachable only by direct unit-test callers
 * of the builder. (#253, #781)
 */
export const DEFAULT_PREVIOUS_SUMMARY_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// Shrink ladder (#254, ADR-0108)
//
// The builder renders at one of N fidelity rungs. Rungs are CUMULATIVE: each
// rung applies every drop of the rungs before it. The dispatcher walks
// RUNG_ORDER until the rendered output fits `hybrid.maxOutputTokens`
// (first-fit short-circuit). Every rung is a pure function of
// (input, rung) — byte-identical output for identical input, per the same
// determinism contract the full render has always carried.
// ---------------------------------------------------------------------------

export type Rung =
	| "full"
	| "no-file-activity"
	| "no-tools"
	| "no-verdict-brief"
	| "no-prefix"
	| "no-carried-forward"
	| "trimmed-turns"
	| "stub";

export const RUNG_ORDER: readonly Rung[] = [
	"full",
	"no-file-activity",
	"no-tools",
	"no-verdict-brief",
	"no-prefix",
	"no-carried-forward",
	"trimmed-turns",
	"stub",
] as const;

/**
 * chars/4 token estimate of a rendered summary — the OUTPUT-side counterpart
 * of `estimateTokens` (which takes an AgentMessage). Single home for the
 * convention so the dispatcher's budget check and tests share one estimator.
 */
export function estimateSummaryTokens(summary: string): number {
	return Math.ceil(summary.length / 4);
}

/**
 * Rendering caps, named per the file's existing USER_TURN_MAX_CHARS convention
 * (#254 promoted the former inline literals). Definitional properties of the
 * renderer, not settings — deliberately not operator-tunable (same rationale
 * as RATIO_CHECK_MIN_MESSAGES in hybrid.ts; recorded in ADR-0108).
 */
const SUBAGENT_BRIEF_EXCERPT_MAX_CHARS = 120;
const TURN_PREFIX_MSG_MAX_CHARS = 1000;
const BASH_LAST_COMMAND_MAX_CHARS = 80;
/**
 * Aggregate bound on the Turn Prefix section: only the LAST N prefix
 * messages render (earlier ones elided with a deterministic marker). The
 * per-message char cap alone left the section unbounded in message count —
 * the dominant tail section in on-host measurement (5.7K tokens of a 7.6K
 * summary on the largest observed compaction; #254 measurement record).
 */
const TURN_PREFIX_MAX_MESSAGES = 12;
/** trimmed-turns rung: per-turn char cap and kept-turn count (first + last K-1). */
const TRIMMED_USER_TURN_MAX_CHARS = 500;
const TRIMMED_USER_TURNS_KEEP = 10;
/** stub rung: first turn + last N turns. */
const STUB_USER_TURNS_KEEP_LAST = 2;

/**
 * Deterministic marker appended when `previousSummary` is truncated. Byte-
 * stable; consumed by tests asserting bounded output growth.
 */
const PREVIOUS_SUMMARY_TRUNCATION_MARKER =
	"\n\n_(prior summary truncated; full text preserved in archive)_";

/** Truncate to N chars with a visible ellipsis marker, byte-stable. */
function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

/** Flatten a message's text content blocks to a single string. */
function textOf(msg: AgentMessage): string {
	const m = msg as { role: string; content?: unknown };
	if (m.role === "user" || m.role === "toolResult" || m.role === "custom") {
		const c = m.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			return c
				.filter((b): b is { type: "text"; text: string } => {
					const block = b as { type?: string };
					return block.type === "text";
				})
				.map((b) => b.text)
				.join("\n");
		}
		return "";
	}
	if (m.role === "assistant") {
		const blocks = (m.content ?? []) as Array<{ type: string; text?: string }>;
		return blocks
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n");
	}
	if (m.role === "bashExecution") {
		const be = m as unknown as { command: string; output: string };
		return `\`${be.command}\`\n${be.output}`;
	}
	if (m.role === "branchSummary" || m.role === "compactionSummary") {
		return (m as unknown as { summary: string }).summary;
	}
	return "";
}

interface ToolCallView {
	name: string;
	arguments: Record<string, unknown>;
}

function toolCallsOf(msg: AgentMessage): ToolCallView[] {
	const m = msg as { role: string; content?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	return (m.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>)
		.filter((b) => b.type === "toolCall")
		.map((b) => ({
			name: String(b.name ?? "<unknown>"),
			arguments: (b.arguments ?? {}),
		}));
}

/**
 * Estimate token cost of a message using pi's documented `ceil(chars/4)`
 * heuristic. Cheap, deterministic, dependency-free.
 */
export function estimateTokens(msg: AgentMessage): number {
	const text = textOf(msg);
	let chars = text.length;
	if ((msg as { role: string }).role === "assistant") {
		// Add tool-call bytes the same way pi does so split-turn hybrid threshold
		// math agrees with pi's reserveTokens/keepRecentTokens accounting.
		for (const tc of toolCallsOf(msg)) {
			chars += tc.name.length + JSON.stringify(tc.arguments).length;
		}
	}
	return Math.ceil(chars / 4);
}

/**
 * Extract subagent verdict rows from toolResult messages where toolName is
 * `subagent`. Permissive regex (per PR2 plan Q2): matches a `Verdict:` line
 * anywhere in the text content; if a `REPORT_FILE:` line is also present,
 * the path is captured. Falls back to verdict-only rows.
 */
/**
 * VERDICT_RE intentionally permits an optional colon (`Verdict PASS` matches
 * `Verdict: PASS`) — absorbs minor drift from `rules/structured-review-format.md`
 * canonical form. PR2 plan Q2 explicitly chose permissive over strict. The
 * `g` + `i` + `m` flags drive `matchAll` so we surface every verdict in a
 * single aggregated parallel-subagent toolResult (not just the first).
 *
 * Backtracking safety: the input is unbounded subagent-transcript text, so the
 * separator structure must stay unambiguous — each optional separator group
 * requires its distinguishing character (`(?:[ \t]*:)?`, `(?:[ \t]*\*{1,2})?`)
 * so a long whitespace run has exactly one parse. Adjacent bare `\s*` runs
 * around the optional colon/stars were polynomial on `"Verdict" + " "×N`
 * (CodeQL js/polynomial-redos, pi-compaction-optimizer alert #3).
 */
const VERDICT_RE = /^[ \t]*\*{0,2}Verdict\*{0,2}(?:[ \t]*:)?(?:[ \t]*\*{1,2})?[ \t]*(PASS|PASS_WITH_WARNINGS|NEEDS_CHANGES|PRECONDITION_FAILURE)\b/gim;
const REPORT_FILE_RE = /^\s*REPORT_FILE:\s*(\S+)/gim;
const AGENT_ARG_KEYS = ["agent", "agentName", "name"] as const;
// Per-task header emitted by the vendored subagent extension in parallel
// mode — see agent/extensions/subagent/index.ts (the `### [<agent>] <status>`
// emitter around the `summaries.map(...)` block). Status word is optional
// because some fixtures (and a possible future emitter change) omit it.
const PARALLEL_HEADER_RE = /^###\s+\[([^\]\n]+)\](?:\s+\S+)?\s*$/gm;
// Form B sentinel — see rules/subagent-parallel-handoff.md. The verdict line
// is contractually emitted AFTER the report block, so we scope verdict scans
// to text after the last `<!-- END REPORT -->` within a segment when one is
// present. This defeats `Verdict:` lines quoted inside a nested report.
const REPORT_END_MARKER = "<!-- END REPORT -->";

interface SubagentVerdict {
	agent: string;
	verdict: string;
	reportFile?: string;
	briefExcerpt: string;
}

/**
 * Index a subagent toolCall's argument structure by call id, returning the
 * list of agent names invoked (`[agent]` for single mode, `[a, b, c]` for
 * parallel-tasks mode). Used by `extractSubagentVerdicts` to pair Nth
 * verdict with Nth task agent in parallel reports.
 */
function agentsFromToolCallArgs(args: Record<string, unknown>): string[] {
	for (const k of AGENT_ARG_KEYS) {
		const v = args[k];
		if (typeof v === "string" && v.length > 0) return [v];
	}
	if (Array.isArray(args.tasks)) {
		return (args.tasks as Array<Record<string, unknown>>)
			.map((t) => (typeof t.agent === "string" ? t.agent : "<unknown>"));
	}
	return ["<unknown>"];
}

function extractSubagentVerdicts(messages: AgentMessage[]): SubagentVerdict[] {
	const out: SubagentVerdict[] = [];
	// Index assistant tool calls by id so the fallback (no-header) path has
	// an authoritative agent-name list and a hard cap on row count.
	const agentsByCallId = new Map<string, string[]>();
	for (const msg of messages) {
		const m = msg as { role: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as Array<{
			type: string;
			id?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}>) {
			if (block.type !== "toolCall" || block.name !== "subagent" || !block.id) continue;
			agentsByCallId.set(block.id, agentsFromToolCallArgs(block.arguments ?? {}));
		}
	}
	for (const msg of messages) {
		const m = msg as { role: string; toolName?: string; toolCallId?: string };
		if (m.role !== "toolResult" || m.toolName !== "subagent") continue;
		const text = textOf(msg);
		const agents = agentsByCallId.get(String(m.toolCallId ?? "")) ?? ["<unknown>"];
		const briefExcerpt = truncate(
			text.replace(/\s+/g, " ").trim(),
			SUBAGENT_BRIEF_EXCERPT_MAX_CHARS,
		);

		// Preferred path: split the toolResult into per-task segments using the
		// `### [<agent>] <status>` headers the subagent extension emits in
		// parallel mode. This (a) attributes each verdict to the agent named in
		// the header rather than relying on the Nth call-arg matching the Nth
		// Verdict match (the original positional-pairing bug, #229), and (b)
		// scopes the verdict regex to one segment at a time so a quoted
		// `Verdict:` line in one segment cannot mis-attribute to another agent.
		const segments = splitParallelSegments(text);
		if (segments.length > 0) {
			for (const seg of segments) {
				const row = extractVerdictFromScope(seg.body);
				if (!row) continue;
				out.push({
					agent: seg.agent,
					verdict: row.verdict,
					reportFile: row.reportFile,
					briefExcerpt,
				});
			}
			continue;
		}

		// Fallback path: no per-task headers (single-mode toolResult, or a
		// non-conforming emitter). Use the global scan but cap match count to
		// the number of agents the call was made with — fail closed rather
		// than mis-attribute. Quoted inner `Verdict:` lines are still possible
		// here; the cap prevents them from manufacturing phantom rows beyond
		// the actual agent count.
		const verdictMatches = [...text.matchAll(VERDICT_RE)];
		if (verdictMatches.length === 0) continue;
		const reportMatches = [...text.matchAll(REPORT_FILE_RE)];
		const limit = Math.min(verdictMatches.length, agents.length);
		for (let i = 0; i < limit; i++) {
			const agent = agents[i] ?? agents[agents.length - 1] ?? "<unknown>";
			const rf = reportMatches[i] ?? reportMatches[0];
			out.push({
				agent,
				verdict: verdictMatches[i][1],
				reportFile: rf ? rf[1] : undefined,
				briefExcerpt,
			});
		}
	}
	return out;
}

interface ParallelSegment {
	agent: string;
	body: string;
}

/**
 * Slice the toolResult text on `### [<agent>] <status>` headers, returning
 * one segment per header. Returns `[]` when no headers are present (caller
 * falls back to the global-scan path).
 */
function splitParallelSegments(text: string): ParallelSegment[] {
	// Reset the regex state — it's `g`-flagged at module scope.
	PARALLEL_HEADER_RE.lastIndex = 0;
	const headers: { agent: string; start: number; end: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = PARALLEL_HEADER_RE.exec(text)) !== null) {
		headers.push({ agent: match[1].trim(), start: match.index, end: match.index + match[0].length });
	}
	if (headers.length === 0) return [];
	const segments: ParallelSegment[] = [];
	for (let i = 0; i < headers.length; i++) {
		const bodyStart = headers[i].end;
		const bodyEnd = i + 1 < headers.length ? headers[i + 1].start : text.length;
		segments.push({ agent: headers[i].agent, body: text.slice(bodyStart, bodyEnd) });
	}
	return segments;
}

/**
 * Scoped verdict extraction for one per-task segment.
 *
 * Per `rules/subagent-parallel-handoff.md`, the VERDICT line is emitted
 * AFTER the report block (Form B: after `<!-- END REPORT -->`; Form A:
 * after the `REPORT_FILE:` line). So when a segment contains
 * `<!-- END REPORT -->`, we scope the verdict scan to text after the LAST
 * occurrence — nested quoted reports cannot mis-attribute. Within the
 * scope, the LAST matched VERDICT wins (the agent's own verdict line is
 * the terminal one per the contract).
 */
function extractVerdictFromScope(
	body: string,
): { verdict: string; reportFile?: string } | undefined {
	const lastEnd = body.lastIndexOf(REPORT_END_MARKER);
	const scope = lastEnd >= 0 ? body.slice(lastEnd + REPORT_END_MARKER.length) : body;
	const verdictMatches = [...scope.matchAll(VERDICT_RE)];
	if (verdictMatches.length === 0) return undefined;
	const reportMatches = [...scope.matchAll(REPORT_FILE_RE)];
	const v = verdictMatches[verdictMatches.length - 1];
	const rf = reportMatches[reportMatches.length - 1];
	return { verdict: v[1], reportFile: rf ? rf[1] : undefined };
}

interface ToolActivity {
	name: string;
	count: number;
	lastBashCommand?: string;
}

function summarizeToolActivity(messages: AgentMessage[]): ToolActivity[] {
	const counts = new Map<string, number>();
	let lastBash: string | undefined;
	for (const msg of messages) {
		for (const tc of toolCallsOf(msg)) {
			counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
		}
		const m = msg as { role: string; command?: string };
		if (m.role === "bashExecution" && typeof m.command === "string") {
			lastBash = m.command;
		}
	}
	const out: ToolActivity[] = [];
	for (const name of [...counts.keys()].sort()) {
		const entry: ToolActivity = { name, count: counts.get(name) ?? 0 };
		if (name === "bash" && lastBash !== undefined) entry.lastBashCommand = lastBash;
		out.push(entry);
	}
	return out;
}

/**
 * Detect "orphan" assistant text — assistant `text` blocks whose immediate
 * next message is NOT a `toolResult`. Used by the hybrid heuristic to detect
 * conversational/planning content the LLM summarizer handles better.
 *
 * Returns the cumulative orphan-text token estimate (chars/4).
 */
export function orphanAssistantTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as { role: string; content?: unknown };
		if (m.role !== "assistant") continue;
		const next = messages[i + 1] as { role?: string } | undefined;
		if (next?.role === "toolResult") continue;
		// Orphan: count only text blocks (tool calls accounted separately).
		const text = textOf(messages[i]);
		total += Math.ceil(text.length / 4);
	}
	return total;
}

/** Sum of all assistant `toolCall` blocks across the message array. */
export function toolCallCount(messages: AgentMessage[]): number {
	let n = 0;
	for (const msg of messages) n += toolCallsOf(msg).length;
	return n;
}

/** Per-turn body cap for user messages in the deterministic summary. */
const USER_TURN_MAX_CHARS = 2000;

/**
 * Render the User Turns section at one of three fidelity levels (ADR-0108).
 *
 * - `all` — every turn, USER_TURN_MAX_CHARS per turn (original behavior).
 * - `trimmed` — turn #1 plus the last TRIMMED_USER_TURNS_KEEP-1 turns at
 *   TRIMMED_USER_TURN_MAX_CHARS each. Turn #1 is always preserved: the
 *   `## Goal` section it used to duplicate was removed as unconditional
 *   dedup, so the first turn is the only remaining carrier of the
 *   original ask.
 * - `stub` — turn #1 plus the last STUB_USER_TURNS_KEEP_LAST turns.
 *
 * Elided ranges render a deterministic marker with the elided count.
 * Degrades gracefully at 0/1 available turns (no padding, no error).
 */
function renderUserTurns(
	messages: AgentMessage[],
	level: "all" | "trimmed" | "stub",
): string[] {
	const lines: string[] = ["## User Turns (verbatim)", ""];
	const turns: string[] = [];
	for (const msg of messages) {
		if ((msg as { role: string }).role !== "user") continue;
		turns.push(textOf(msg).trim());
	}
	if (turns.length === 0) {
		lines.push("(none)");
		lines.push("");
		return lines;
	}
	const maxChars =
		level === "all" ? USER_TURN_MAX_CHARS : TRIMMED_USER_TURN_MAX_CHARS;
	const keepLast =
		level === "all"
			? turns.length
			: level === "trimmed"
				? TRIMMED_USER_TURNS_KEEP - 1
				: STUB_USER_TURNS_KEEP_LAST;
	// Kept ordinals: always #1, plus the last `keepLast` turns (1-based).
	const lastStart = Math.max(turns.length - keepLast, 1);
	for (let i = 0; i < turns.length; i++) {
		const ord = i + 1;
		if (ord !== 1 && ord <= lastStart) {
			// Emit one elision marker at the start of the skipped range.
			if (ord === 2) {
				lines.push(`_(… ${lastStart - 1} earlier turn${lastStart - 1 === 1 ? "" : "s"} elided …)_`);
			}
			continue;
		}
		const body = truncate(turns[i], maxChars);
		lines.push(`${ord}. ${body.length > 0 ? body : "(empty user message)"}`);
	}
	lines.push("");
	return lines;
}

function renderFileActivity(fileOps: FileOperationsLike): string[] {
	const modified = [...new Set([...fileOps.written, ...fileOps.edited])].sort();
	const read = [...fileOps.read].sort();
	const lines: string[] = ["## File Activity", ""];
	lines.push(`### Modified (${modified.length} file${modified.length === 1 ? "" : "s"})`);
	if (modified.length === 0) {
		lines.push("- (none)");
	} else {
		for (const p of modified) lines.push(`- \`${p}\``);
	}
	lines.push("");
	lines.push(`### Read (${read.length} file${read.length === 1 ? "" : "s"}, after pruning)`);
	if (read.length === 0) {
		lines.push("- (none)");
	} else {
		for (const p of read) lines.push(`- \`${p}\``);
	}
	lines.push("");
	return lines;
}

function renderToolActivity(messages: AgentMessage[]): string[] {
	const acts = summarizeToolActivity(messages);
	const lines: string[] = ["## Tool Activity Summary", ""];
	if (acts.length === 0) {
		lines.push("(no tool calls)");
		lines.push("");
		return lines;
	}
	for (const a of acts) {
		const suffix =
			a.lastBashCommand !== undefined
				? ` (last: \`${truncate(a.lastBashCommand, BASH_LAST_COMMAND_MAX_CHARS).replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\`)`
				: "";
		lines.push(`- \`${a.name}\`: ${a.count} invocation${a.count === 1 ? "" : "s"}${suffix}`);
	}
	lines.push("");
	return lines;
}

/**
 * Render the Subagent Verdicts table at one of three fidelity levels
 * (ADR-0108):
 *
 * - `full` — `| Agent | Verdict | Brief |` where Brief is REPORT_FILE when
 *   present, else the excerpt (original behavior).
 * - `no-brief` — `| Agent | Verdict | Ref |` where Ref is REPORT_FILE when
 *   present, else `—`; the excerpt is dropped.
 * - `stub` — `| Agent | Verdict |` only.
 */
function renderSubagentVerdicts(
	messages: AgentMessage[],
	level: "full" | "no-brief" | "stub",
): string[] {
	const verdicts = extractSubagentVerdicts(messages);
	const lines: string[] = ["## Subagent Verdicts", ""];
	if (verdicts.length === 0) {
		lines.push("(no subagent calls)");
		lines.push("");
		return lines;
	}
	// Escape pipe AND backtick characters to keep table cells well-formed
	// even when an LLM-emitted agent name or REPORT_FILE path contains them.
	const escape = (s: string): string => s.replace(/[`|]/g, (c) => `\\${c}`);
	if (level === "stub") {
		lines.push("| Agent | Verdict |");
		lines.push("|---|---|");
		for (const v of verdicts) {
			lines.push(`| \`${escape(v.agent)}\` | ${v.verdict} |`);
		}
	} else if (level === "no-brief") {
		lines.push("| Agent | Verdict | Ref |");
		lines.push("|---|---|---|");
		for (const v of verdicts) {
			const ref = v.reportFile ? escape(v.reportFile) : "—";
			lines.push(`| \`${escape(v.agent)}\` | ${v.verdict} | ${ref} |`);
		}
	} else {
		lines.push("| Agent | Verdict | Brief |");
		lines.push("|---|---|---|");
		for (const v of verdicts) {
			const brief = v.reportFile ? `REPORT_FILE: ${v.reportFile}` : v.briefExcerpt;
			lines.push(`| \`${escape(v.agent)}\` | ${v.verdict} | ${escape(brief)} |`);
		}
	}
	lines.push("");
	return lines;
}

// `## Goal` was removed as unconditional dedup (#254, ADR-0108): it
// duplicated User Turns #1, which every fidelity level of renderUserTurns
// preserves. The first user turn is the sole carrier of the original ask.

function renderTurnPrefix(messages: AgentMessage[]): string[] {
	if (messages.length === 0) return [];
	const lines: string[] = ["## Turn Prefix (split turn)", ""];
	// Aggregate bound (ADR-0108): only the last TURN_PREFIX_MAX_MESSAGES
	// prefix messages render; the per-message char cap alone left this
	// section unbounded in message count.
	const start = Math.max(messages.length - TURN_PREFIX_MAX_MESSAGES, 0);
	if (start > 0) {
		lines.push(`_(… ${start} earlier prefix message${start === 1 ? "" : "s"} elided …)_`);
	}
	for (let i = start; i < messages.length; i++) {
		const msg = messages[i];
		const role = (msg as { role: string }).role;
		const body = truncate(textOf(msg).trim(), TURN_PREFIX_MSG_MAX_CHARS);
		lines.push(`${i + 1}. **${role}** — ${body.length > 0 ? body : "(empty)"}`);
	}
	lines.push("");
	return lines;
}

/** Per-rung render configuration, derived cumulatively from RUNG_ORDER. */
interface RungConfig {
	fileActivity: boolean;
	toolActivity: boolean;
	verdictLevel: "full" | "no-brief" | "stub";
	turnPrefix: boolean;
	carriedForward: boolean;
	userTurnLevel: "all" | "trimmed" | "stub";
	instructionsFooter: boolean;
}

function rungConfig(rung: Rung): RungConfig {
	const i = RUNG_ORDER.indexOf(rung);
	const at = (r: Rung): boolean => i >= RUNG_ORDER.indexOf(r);
	return {
		fileActivity: !at("no-file-activity"),
		toolActivity: !at("no-tools"),
		verdictLevel: at("stub") ? "stub" : at("no-verdict-brief") ? "no-brief" : "full",
		turnPrefix: !at("no-prefix"),
		carriedForward: !at("no-carried-forward"),
		userTurnLevel: at("stub") ? "stub" : at("trimmed-turns") ? "trimmed" : "all",
		instructionsFooter: !at("stub"),
	};
}

/**
 * Build the deterministic markdown summary at a fidelity rung (#254,
 * ADR-0108). Pure: byte-identical output for identical (input, rung) —
 * including `generatedAt`. `## Compaction Metadata` survives every rung.
 */
export function buildAtRung(input: BuildInput, rung: Rung): string {
	const cfg = rungConfig(rung);
	const lines: string[] = [];

	lines.push(...renderUserTurns(input.messagesToSummarize, cfg.userTurnLevel));
	if (cfg.turnPrefix && input.isSplitTurn) {
		lines.push(...renderTurnPrefix(input.turnPrefixMessages));
	}
	if (cfg.fileActivity) lines.push(...renderFileActivity(input.fileOps));
	if (cfg.toolActivity) lines.push(...renderToolActivity(input.messagesToSummarize));
	lines.push(...renderSubagentVerdicts(input.messagesToSummarize, cfg.verdictLevel));

	if (
		cfg.carriedForward &&
		input.previousSummary &&
		input.previousSummary.trim().length > 0
	) {
		const cap =
			input.previousSummaryMaxChars ?? DEFAULT_PREVIOUS_SUMMARY_MAX_CHARS;
		// cap === 0 → omit the section entirely (archive remains the canonical
		// source). cap > 0 → include up to `cap` chars of the prior summary;
		// truncation marker emitted on overflow so the LLM knows to consult the
		// archive for full context. Bounds geometric growth (#253).
		if (cap > 0) {
			const trimmed = input.previousSummary.trim();
			const rendered =
				trimmed.length <= cap
					? trimmed
					: `${trimmed.slice(0, cap)}${PREVIOUS_SUMMARY_TRUNCATION_MARKER}`;
			lines.push("## Carried-Forward Context", "");
			lines.push(rendered);
			lines.push("");
		}
	}

	lines.push("## Compaction Metadata", "");
	lines.push(`- tokens_before: ${input.tokensBefore}`);
	lines.push(`- entries_summarized: ${input.messagesToSummarize.length}`);
	lines.push(`- is_split_turn: ${input.isSplitTurn}`);
	lines.push(`- turn_prefix_messages: ${input.turnPrefixMessages.length}`);
	lines.push("- generated_by: compaction-optimizer (deterministic)");
	lines.push(`- generated_at: ${input.generatedAt}`);
	lines.push("");

	if (cfg.instructionsFooter && input.customInstructionsDropped) {
		lines.push(
			"> NOTE: `/compact <instructions>` were not honored in deterministic mode. " +
				"Switch to `mode: \"hybrid\"` or `\"llm-only-with-dump\"` to use custom instructions.",
		);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Full-fidelity build — backward-compatible wrapper over `buildAtRung`.
 * Byte-identical for identical input, including `generatedAt`.
 */
export function buildDeterministicSummary(input: BuildInput): string {
	return buildAtRung(input, "full");
}
