# compaction-optimizer

Pi extension that augments `/compact` with (1) bounded file-tracker pruning,
(2) a pre-compaction archive of the discarded turns, and (3) a deterministic
LLM-free summary builder gated by a hybrid heuristic.

See [ADR-0019](https://github.com/psmfd/pi-config/blob/main/adrs/0019-compaction-optimizer-extension.md) for the
full design, threat model, and dissent record. This README is the operator-
facing surface.

## Install

```sh
pi install git:github.com/psmfd/pi-compaction-optimizer
```

Try it first without installing: `pi -e git:github.com/psmfd/pi-compaction-optimizer`.

## What it does

| Handler                  | Phase       | Behavior                                                                                            |
|--------------------------|-------------|-----------------------------------------------------------------------------------------------------|
| `session_before_compact` | pre-commit  | Prune `preparation.fileOps.read` in place; capture pre-cut payload to memory; dispatch by `mode`.   |
| `session_compact`        | post-commit | Consume captured payload; write markdown archive under the configured root.                         |
| `session_shutdown`       | teardown    | Clear the snapshot map + ephemeral roots for the closing session.                                   |

When `mode` selects deterministic-style summarization (either explicitly via
`mode: "deterministic"`, or implicitly via `mode: "hybrid"` on a tool-call-
dense cluster), `session_before_compact` returns
`{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` and
pi's LLM summarizer is **skipped**. Otherwise it returns `undefined` and pi's
default `compact()` runs, consuming the pruned `fileOps` via
`computeFileLists()`. Pruning the upstream sets is the structurally correct
attachment point; see
ADR-0019 implementation notes on #208.

## Modes

| Mode                       | Behavior                                                                                                                                              |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `hybrid` (default)         | Heuristic decision per call: deterministic build on tool-call-dense clusters, fall through to pi's LLM summarizer on chatty/planning/`/compact <instr>` cases. |
| `deterministic`            | Always run the LLM-free builder. `/compact <instructions>` are dropped with a one-time-per-session warning notify and a footer disclaimer on the summary.      |
| `llm-only-with-dump`       | Never run the builder. Pi's default summarizer always runs; the archive still captures the raw pre-cut payload.                                       |

### Hybrid heuristic

Falls through to pi's LLM summarizer when **any** of:

- `event.customInstructions` is non-empty (LLM honors them; the builder does not).
- `messagesToSummarize.length > hybrid.maxMessages` (default 200).
- `preparation.tokensBefore > hybrid.maxTokens` (default 60 000). Pi populates
  `tokensBefore` from the actual provider usage count on the previous request;
  when it is `0` or absent, the heuristic falls back to summing
  `ceil(chars/4)` across messages via `estimateTokens`. Prefer pinning
  `tokensBefore` whenever upstream provides it — the char-based fallback is
  approximate and walks every tool-call argument blob.
- `toolCallCount / messageCount < hybrid.minToolCallRatio` (default 0.3), evaluated only when message count ≥ 6.
- Orphan-assistant-text token estimate (`ceil(chars / 4)`) `> hybrid.maxOrphanAssistantTokens` (default 2 000).

All thresholds are user- and project-layer settable.

### Deterministic summary schema

Markdown sections rendered in order:

```text
## Goal                       — first user message, truncated to 500 chars
## User Turns (verbatim)      — every user message, stable ordinal numbering, capped at 2000 chars/turn
## Turn Prefix (split turn)   — present only when isSplitTurn=true; capped at 1000 chars/message
## File Activity              — Modified (written ∪ edited), Read (after pruning); both sorted
## Tool Activity Summary      — per-tool counts; bash includes last command
## Subagent Verdicts          — extracted from `subagent` toolResult; permissive `Verdict: ...` regex, REPORT_FILE: captured when present
## Carried-Forward Context    — first hybrid.previousSummaryMaxChars chars of previousSummary, plus truncation marker on overflow (default 500; 0 omits section entirely; archive preserves full text) — see #253
## Compaction Metadata        — tokens_before, entries_summarized, is_split_turn, turn_prefix_messages, generated_by, generated_at
```

**Determinism guarantee.** Two layers, distinct in scope:

- **Body-level determinism (production).** Given identical input messages,
  the rendered Markdown *body* — every section from `## Goal` through
  `## Critical Context` — is byte-identical across runs. `Set` iteration is
  replaced by `[...set].sort()`, no `Date.now()` / random suffixes are
  embedded in the body, and the subagent-verdict regex is anchored. This is
  the guarantee that matters for diff-review, archive replay, and downstream
  tooling that hashes summary content.
- **Full byte-determinism (test-mode property).** The header line
  `- generated_at: <ISO-8601>` differs across real-world runs because
  `index.ts` passes `new Date().toISOString()` to the builder on every
  compaction. Two production compactions of byte-identical sessions therefore
  produce summaries that match in body but differ in that one metadata line.
  Full byte-equality is reachable only when callers pin `generatedAt`
  explicitly — which `test/deterministic-summary.test.ts` does to verify the
  builder is otherwise pure (no I/O, no nondeterministic iteration order).

The extension returns `details: { readFiles, modifiedFiles, generatedBy:
"compaction-optimizer", mode }`, mirroring pi's own `CompactionDetails`
shape so cumulative file-tracking across subsequent compactions continues to
work via `extractFileOperations` in `pi-mono`'s default `compact()`.

### Runtime feedback

The dispatcher emits **one `info`-level notify per compaction** stating which
path ran, so operators can tell air-gapped from LLM fall-through at runtime
without grepping the session JSONL (#242):

| Path | Message shape |
|---|---|
| `deterministic` (mode-forced) | `compaction-optimizer: air-gapped deterministic summary (mode=deterministic, N msgs, K tokens)` |
| `hybrid` → deterministic | `compaction-optimizer: air-gapped deterministic summary (mode=hybrid, N msgs, K tokens)` |
| `hybrid` → fall-through | `compaction-optimizer: fell through to pi LLM summarizer (mode=hybrid, reason=<key>, N msgs, K tokens)` |
| `llm-only-with-dump` | `compaction-optimizer: deferred to pi LLM summarizer (mode=llm-only-with-dump); archive will capture raw payload` |

A `~` prefix on the token count (`~K tokens`) marks the char-based
`estimateTokens` fallback path; absent prefix means the count came from
pi-provided `preparation.tokensBefore` (see the hybrid threshold list above).

`reason` on the hybrid fall-through line is one of these stable keys:

- `custom-instructions` — `/compact <instructions>` was supplied; LLM honors them, builder does not.
- `too-many-messages` — cluster exceeded `hybrid.maxMessages`.
- `too-many-tokens` — cluster exceeded `hybrid.maxTokens`.
- `tool-call-ratio-low` — conversational/planning-heavy cluster (below `hybrid.minToolCallRatio`).
- `orphan-assistant-text` — free-form assistant prose exceeded `hybrid.maxOrphanAssistantTokens`.

The edge-case `warning`-level notifies are unchanged:

- Deterministic build threw → fall-through warning.
- Deterministic-mode requested but `preparation.fileOps` missing or not `Set`-shaped (pi shape drift) → fall-through warning.
- Deterministic mode + `/compact <instructions>` → dropped-instructions warning (the instructions are not honored, builder runs anyway).

## Settings

Settings are read from `~/.pi/agent/settings.json` (user) and
`<cwd>/.pi/settings.json` (project). Namespace: `extensionSettings.compactionOptimizer.*`.

Project-layer overrides are filtered by an allowlist. Project layer is
treated as **untrusted input** — any cloned repository can ship a
`.pi/settings.json`, and a hostile `archive.path` redirect would be an
arbitrary-file-write primitive. See
[ADR-0019 § Threat Model](https://github.com/psmfd/pi-config/blob/main/adrs/0019-compaction-optimizer-extension.md#threat-model-and-security-posture).

| Key                                  | User layer       | Project layer | Default                                                  |
|--------------------------------------|------------------|---------------|----------------------------------------------------------|
| `mode`                               | yes              | yes           | `hybrid`                                                 |
| `hybrid.maxMessages`                 | yes              | yes           | `200`                                                    |
| `hybrid.maxTokens`                   | yes              | yes           | `60000`                                                  |
| `hybrid.minToolCallRatio`            | yes              | yes           | `0.3`                                                    |
| `hybrid.maxOrphanAssistantTokens`    | yes              | yes           | `2000`                                                   |
| `hybrid.previousSummaryMaxChars`     | yes              | yes           | `500` (0 omits Carried-Forward; #253)                    |
| `fileTracker.maxReadFiles`           | yes              | yes           | `50`                                                     |
| `fileTracker.staleAfterCompactions`  | yes              | yes (reserved) | `3` (informational)                                     |
| `fileTracker.dropPatterns`           | yes              | **rejected**  | `[]`                                                     |
| `archive.enabled`                    | yes              | yes           | `true`                                                   |
| `archive.path`                       | yes (abs or `~`) | **rejected**  | `~/.pi/agent/extensions/compaction-optimizer/archive`    |
| `archive.ephemeralBehavior`          | yes              | **rejected**  | `skip`                                                   |
| `archive.redactPatterns`             | yes              | **rejected**  | `[]`                                                     |

Project-layer values for the rejected keys are dropped with a single
`ctx.ui.notify` warning naming the rejected key. A follow-up
(#226) tracks
restoring a constrained-relative form of project-layer `archive.path`
when a concrete use case appears.

**Project-layer numeric clamps.** Allowlisted numeric values from the
project layer are additionally clamped to defense-in-depth ranges before
merging (warning notify on each clamp):

| Key                                  | Floor | Ceiling   |
|--------------------------------------|-------|-----------|
| `hybrid.maxMessages`                 | `1`   | `2000`    |
| `hybrid.maxTokens`                   | `1`   | `500000`  |
| `hybrid.minToolCallRatio`            | `0`   | `1`       |
| `hybrid.maxOrphanAssistantTokens`    | `0`   | `100000`  |
| `hybrid.previousSummaryMaxChars`     | `0`   | `100000`  |
| `fileTracker.maxReadFiles`           | `1`   | `1000`    |
| `fileTracker.staleAfterCompactions`  | `1`   | `100`     |

The clamps cannot be loosened by the project layer (they live in the
user-trust-boundary loader). They are not exfiltration primitives —
deterministic-mode content is bounded to data pi already persists in the
raw session file — but they prevent a hostile `.pi/settings.json` from
shaping the persisted summary outside the envelope the user intends.

Regex-pattern keys (`fileTracker.dropPatterns`, `archive.redactPatterns`) are
deliberately **user-layer only** — Node's `RegExp` engine has no per-pattern
timeout, so a catastrophic-backtracking pattern blocks the Node event loop for
the *full* match duration (potentially many seconds on a large transcript), not
merely the 250 ms budget. That budget is measured **after** a pattern returns and
only skips *subsequent* patterns — it cannot preempt one mid-match. Keeping these
keys user-layer-only bounds the worst case to your own settings (self-DoS); a
hostile project-layer regex would otherwise stall `/compact`. See ADR-0019 §
Threat Model.

## Archive format

Plain markdown, written atomically. Each file:

```text
~/.pi/agent/extensions/compaction-optimizer/archive/<session-id>/<UTC-timestamp>.md
```

Each archive contains, at minimum:

- Session id, capture timestamp, `firstKeptEntryId`, `tokensBefore`, `isSplitTurn`.
- The previous compaction summary (if any).
- The full pre-cut `messagesToSummarize` payload (JSON-fenced per message).
- The `turnPrefixMessages` payload when the cut was mid-turn.

PR2's deterministic builder renders the schema described in **Deterministic
summary schema** above. The archive (this section) is operator-side state
and its byte format is informational, not contractual.

## Content sensitivity

**Archives contain the full pre-compaction transcript.** That includes
tool-call inputs and outputs, file contents from `read`, `bash` stdout/stderr
(which routinely contains tokens, env dumps, `aws sts` output, `kubectl config view`
output, etc.), `web_fetch` bodies, and any secret material the session touched.

No redaction is performed by default. Archive files are at least as sensitive
as the live session JSONL files at `~/.pi/sessions/`, and MUST be treated as
such by users and backup tooling.

This repository ships a `.gitignore` that excludes the `archive/` directory, so
snapshots are **never committed** — including in the public distribution mirror.
Do not remove that ignore rule, and never `git add --force` archive content.

Mitigations:

- Set `archive.enabled: false` (user layer or project layer) to skip writes.
- Set `archive.redactPatterns: ["regex1", "regex2"]` (user layer only) to replace
  matched substrings with `[REDACTED]`. Redaction is per-pattern *detect-and-break*:
  the writer measures each pattern's wall-clock duration **after** it returns and
  skips remaining patterns if the previous one exceeded 250 ms. Node's regex
  engine cannot preempt a single pattern — a catastrophic-backtracking pattern
  will block until completion. `redactPatterns` is user-layer-only specifically
  so the worst case is bounded to user-supplied input. Invalid patterns are
  skipped with a warning.

## secrets-guard interaction (accepted non-coverage)

The `secrets-guard` extension intercepts the `write`, `edit`, and
`artifact_review` tool-call events. The archive writer in `lib/archive.ts`
uses `fs.writeFile` directly (not a tool call) and is therefore invisible
to `secrets-guard`. This is **deliberate**: routing archive writes through
`artifact_review` would populate `.review/` with non-handoff content (violating
ADR-0007) and interrupt every compaction with a pre-write secret-scan UI prompt.

The `archive.redactPatterns` hook is the substitute mitigation. Users who
need stronger guarantees should use `archive.enabled: false` for highly
sensitive sessions.

## Integrity posture (non-claim)

Archives are plain markdown with no signing, hashing, or append-only
filesystem guarantee. The "decisioning provenance preserved" benefit is
qualified accordingly: provenance is preserved against accidental loss, not
against tampering by any process running as the same user. Tamper-resistance
is an explicit non-goal of v1.

## File-system posture

Hard invariants enforced by `lib/archive.ts`:

| Concern                       | Enforcement                                                                                                |
|-------------------------------|------------------------------------------------------------------------------------------------------------|
| Per-session directory mode    | `0o700`                                                                                                    |
| Archive file mode             | `0o600`                                                                                                    |
| Symlink components            | Refused: `realpath` the per-session directory and require it lies under `realpath(archive root)`.          |
| Pre-existing target           | Refused via `fs.link(2)` commit (EEXIST on existing target) rather than `rename(2)`; eliminates the access-check TOCTOU window. |
| Atomic write                  | Sibling tempfile opened with `O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW`; `fsync`; `fs.link(2)` to final target; tempfile unlinked. |
| Ephemeral session (`"tmp"`)   | `mkdtemp("pi-compaction-archive-")` under `$TMPDIR`, mode `0o700`. Sweep on next start (>24h age).         |
| Failure log                   | `~/.pi/agent/extensions/compaction-optimizer/failure.log`, mode `0o600`, opened with `O_NOFOLLOW \| O_APPEND` per write. |

Archive write is **best-effort**. Any failure logs to `failure.log`, surfaces
via `ctx.ui.notify`, and is never re-raised — the behavior degrades to
"pi without the extension installed" for that one compaction.

## Rollback

```bash
pi extensions disable compaction-optimizer
# or remove "./agent/extensions/compaction-optimizer" from settings.json -> extensions
```

The archive directory may be deleted or retained at user discretion. Its
presence does not affect operation if the extension is later re-enabled.

## Source rules and references

- [ADR-0019](https://github.com/psmfd/pi-config/blob/main/adrs/0019-compaction-optimizer-extension.md) — full design
- #208 — PR1 tracking issue + acceptance criteria
- #216 — PR2 (deterministic + hybrid + default flip)
- #226 — constrained-relative project-layer `archive.path` (follow-up)
- #210, #211 — upstream proposals (not blocking)
