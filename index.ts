/**
 * compaction-optimizer — pi extension (PR1 + PR2)
 *
 * Registers `session_before_compact`, `session_compact`, and `session_shutdown`
 * handlers to:
 *   1. Prune `event.preparation.fileOps.read` in place (default `compact()`
 *      consumes the pruned set via `computeFileLists()`).
 *   2. Capture the pre-cut message payload to an in-memory snapshot map keyed
 *      by session id, for the cross-handler state hand-off.
 *   3. Dispatch summary mode:
 *      - `deterministic` — build markdown checkpoint from snapshot, return
 *        `{compaction: CompactionResult}` (skips pi's LLM call entirely;
 *        an over-budget stub is emitted with a warning, never LLM-routed).
 *      - `hybrid` — heuristic; deterministic when tool-call-dense, else
 *        return `undefined` to fall through to pi's LLM summarizer.
 *      - `llm-only-with-dump` — always return `undefined` (LLM summarizes,
 *        archive captures the raw pre-cut payload).
 *      Deterministic output is budget-bounded by an output-side shrink
 *      ladder (`hybrid.maxOutputTokens`, ADR-0108): the summary re-renders
 *      at progressively lower fidelity rungs until it fits; in hybrid mode
 *      an over-budget stub falls through to the LLM.
 *   4. Post-commit, consume the snapshot and write a markdown archive under
 *      `~/.pi/agent/extensions/compaction-optimizer/archive/<session-id>/`.
 *
 * Source: ADR-0019 (Decision Outcome, Staged Delivery — PR1 & PR2).
 * Tracking: #208 (PR1, merged), #216 (PR2).
 */

import { basename } from "node:path";
import type {
	CompactionOptimizerSettings,
	Mode,
} from "./lib/settings.ts";
import { getDefaults, loadSettings } from "./lib/settings.ts";
import * as snapshot from "./lib/snapshot.ts";
import { pruneReadSet } from "./lib/file-tracker.ts";
import {
	cleanupEphemerals,
	cleanupEphemeralsSync,
	sweepEphemerals,
	writeArchive,
} from "./lib/archive.ts";
import {
	buildAtRung,
	estimateSummaryTokens,
	RUNG_ORDER,
	type FileOperationsLike,
	type Rung,
} from "./lib/deterministic-summary.ts";
import { decideHybrid } from "./lib/hybrid.ts";
import { decideDefer, decideProactive } from "./lib/timing.ts";
import * as phaseState from "./shared/phase-state.ts";

// Loose typing for the extension API — pi types are sourced from the runtime
// at load time and are not bundled with this repo.
// biome-ignore lint/suspicious/noExplicitAny: extension API surface
type Pi = any;

const MODE_NOTIFY_SENT = new Set<string>();

function clearNotifyForSession(sessionId: string): void {
	// Covers every notifyOnce key family for the session: `mode:<sid>:*`
	// (mode-dispatch one-shots) and `defer:<sid>:*` (when-policy toasts) —
	// the latter are normally re-armed on a committed compaction, but a
	// session that shuts down mid-deferral-episode would otherwise leak
	// them in this process-lifetime Set (#781 review finding).
	for (const prefix of [`mode:${sessionId}:`, `defer:${sessionId}:`]) {
		for (const key of MODE_NOTIFY_SENT) {
			if (key.startsWith(prefix)) MODE_NOTIFY_SENT.delete(key);
		}
	}
}

/**
 * The slice of `ctx.model` the when-policy and hybrid dispatch read.
 * Single home for the cast-and-coerce so the three call sites cannot
 * drift (#781 review finding). `contextWindow` is 0 when unknown — every
 * consumer treats non-positive as "window unknown" and fails open.
 */
function modelInfoOf(ctx: Pi): { provider: string | undefined; contextWindow: number } {
	const model = (ctx as { model?: { provider?: unknown; contextWindow?: unknown } })?.model;
	return {
		provider: typeof model?.provider === "string" ? model.provider : undefined,
		contextWindow: Number(model?.contextWindow ?? 0),
	};
}

/** Module-init guard so re-invocation of the factory (reload/fork) does not
 *  re-register the process.exit listener and trigger MaxListenersExceeded. */
let processExitWired = false;

function sessionIdOf(ctx: Pi): string {
	const sm = ctx.sessionManager;
	if (typeof sm?.getSessionId === "function") {
		const id = sm.getSessionId();
		if (typeof id === "string" && id.length > 0) {
			// Defense-in-depth: the session id becomes a path component under the
			// archive root, so strip any directory parts and reject traversal/dot
			// forms before use. The realpath ancestor assert in archive.ts is the
			// backstop; this prevents `mkdir -p` from ever materialising a path
			// outside the root if a runtime/fork returns a non-UUID id. (OWASP
			// path traversal — getSessionId is otherwise used verbatim.)
			const safe = basename(id);
			if (safe.length > 0 && safe !== "." && safe !== "..") return safe;
		}
	}
	if (typeof sm?.getSessionFile === "function") {
		const file: unknown = sm.getSessionFile();
		if (typeof file === "string" && file.length > 0) {
			return basename(file, ".jsonl");
		}
	}
	return "unknown-session";
}

function isPersistedOf(ctx: Pi): boolean {
	const sm = ctx.sessionManager;
	if (typeof sm?.isPersisted === "function") {
		return Boolean(sm.isPersisted());
	}
	return true;
}

function notifyOnce(ctx: Pi, key: string, message: string, kind: "info" | "warning" | "error" = "info"): void {
	if (MODE_NOTIFY_SENT.has(key)) return;
	MODE_NOTIFY_SENT.add(key);
	ctx?.ui?.notify?.(message, kind);
}

/**
 * Per-compaction path-taken notify (#242). One info-level message per
 * compaction call, surfacing which dispatch branch ran so operators can
 * tell air-gapped from LLM fall-through at runtime without grepping the
 * session JSONL. Token count is prefixed with `~` when it came from the
 * char-based `estimateTokens` fallback rather than pi's `tokensBefore`.
 */
function formatPathNotify(opts: {
	path: "deterministic" | "fall-through" | "llm-only" | "ladder-exhausted";
	mode: Mode;
	messageCount: number;
	tokenEstimate: number;
	tokensFromPi: boolean;
	reason?: string;
	/** Shrink rung the summary was emitted at (ADR-0108); omitted at full fidelity. */
	rung?: string;
}): string {
	const tokenStr = `${opts.tokensFromPi ? "" : "~"}${opts.tokenEstimate} tokens`;
	const tail = `${opts.messageCount} msgs, ${tokenStr}`;
	if (opts.path === "deterministic") {
		const rungStr =
			opts.rung !== undefined && opts.rung !== "full"
				? `, rung=shrunk-${opts.rung}`
				: "";
		return `compaction-optimizer: air-gapped deterministic summary (mode=${opts.mode}${rungStr}, ${tail})`;
	}
	if (opts.path === "fall-through") {
		return `compaction-optimizer: fell through to pi LLM summarizer (mode=${opts.mode}, reason=${opts.reason ?? "unknown"}, ${tail})`;
	}
	if (opts.path === "ladder-exhausted") {
		return `compaction-optimizer: shrink ladder exhausted at stub rung, falling through to pi LLM summarizer (mode=${opts.mode}, ${tail})`;
	}
	return `compaction-optimizer: deferred to pi LLM summarizer (mode=${opts.mode}); archive will capture raw payload`;
}

export default async function (pi: Pi): Promise<void> {
	// Best-effort startup sweep; never blocks load.
	void sweepEphemerals();

	// Process-exit safety net (one-shot, idempotent across factory re-invocation).
	if (!processExitWired) {
		processExitWired = true;
		process.once("exit", () => {
			snapshot.clearAll();
			cleanupEphemeralsSync();
		});
	}

	pi.on(
		"session_before_compact",
		async (
			event: Pi,
			ctx: Pi,
		): Promise<undefined | { compaction: unknown } | { cancel: true }> => {
			let settings: CompactionOptimizerSettings;
			try {
				settings = await loadSettings({
					cwd: ctx.cwd,
					notify: (m, t) => ctx?.ui?.notify?.(m, t),
				});
			} catch (err) {
				ctx?.ui?.notify?.(
					`compaction-optimizer: settings load failed (${(err as Error).message}); using defaults.`,
					"warning",
				);
				settings = getDefaults();
			}

			const sessionId = sessionIdOf(ctx);

			// 0. When-policy veto (#677, ADR-0109) — MUST precede the
			//    file-tracker prune and snapshot capture: both are wasted work
			//    on a deferred fire (pi re-checks after every agent_end while
			//    tokens keep growing), and a cancelled compaction never
			//    commits, so nothing below is needed. A policy-triggered
			//    proactive compaction arrives as reason:"manual" with the
			//    self-flag armed; consuming the flag documents it and keeps
			//    the veto (which only touches reason:"threshold") inert.
			const selfTriggered = phaseState.consumeSelfCompact(sessionId);
			if (!selfTriggered) {
				const modelInfo = modelInfoOf(ctx);
				const decision = decideDefer({
					settings: settings.timing,
					reason: (event as { reason?: unknown })?.reason,
					provider: modelInfo.provider,
					contextWindow: modelInfo.contextWindow,
					tokensBefore: Number(event?.preparation?.tokensBefore ?? 0),
					phase: {
						subagentInFlight: phaseState.subagentInFlight(sessionId),
						turnsSinceTaskTypeChange:
							phaseState.turnsSinceTaskTypeChange(sessionId),
						taskTypeChangedSinceCompaction:
							phaseState.taskTypeChangedSinceCompaction(sessionId),
						deferrals: phaseState.deferralCount(sessionId),
					},
				});
				if (decision.defer) {
					const n = phaseState.noteDeferral(sessionId);
					// One toast per deferral episode; re-armed when a real
					// compaction commits (session_compact handler below).
					notifyOnce(
						ctx,
						`defer:${sessionId}:active`,
						`compaction-optimizer: deferred threshold compaction — ${
							decision.reason === "fanout-in-flight"
								? "subagent fan-out in flight"
								: "mid-phase"
						} (deferral ${n} this episode; compacts by ${Math.round(settings.timing.deferCeilingFraction * 100)}% of window regardless).`,
						"info",
					);
					return { cancel: true };
				}
				if (
					settings.timing.enabled &&
					decision.reason === "ceiling-reached"
				) {
					notifyOnce(
						ctx,
						`defer:${sessionId}:ceiling`,
						"compaction-optimizer: deferral ceiling reached — compacting now regardless of phase state.",
						"info",
					);
				}
			}

			// 1. File-tracker pruning — mutate fileOps in place. Default compact()
			//    consumes the pruned sets via computeFileLists(). Deterministic mode
			//    also consumes them via the same fileOps object below.
			const fileOps = event?.preparation?.fileOps as
				| FileOperationsLike
				| undefined;
			try {
				if (
					fileOps &&
					fileOps.read instanceof Set &&
					fileOps.written instanceof Set &&
					fileOps.edited instanceof Set
				) {
					pruneReadSet(fileOps, settings.fileTracker);
				}
			} catch (err) {
				ctx?.ui?.notify?.(
					`compaction-optimizer: file-tracker prune failed (${(err as Error).message}); proceeding.`,
					"warning",
				);
			}

			// 2. Snapshot capture for the post-commit archive write.
			const messagesToSummarize: unknown[] = Array.from(
				event?.preparation?.messagesToSummarize ?? [],
			);
			const turnPrefixMessages: unknown[] = Array.from(
				event?.preparation?.turnPrefixMessages ?? [],
			);
			const isSplitTurn = Boolean(event?.preparation?.isSplitTurn);
			const firstKeptEntryId = String(
				event?.preparation?.firstKeptEntryId ?? "",
			);
			const tokensBefore = Number(event?.preparation?.tokensBefore ?? 0);
			// Defensive coercion — every other field in this handler runs through
			// String/Number/Boolean/Array.from before persistence; previousSummary
			// should match. buildDeterministicSummary's `.trim()` would throw on a
			// non-string truthy value if pi ever emits one.
			const rawPreviousSummary = event?.preparation?.previousSummary;
			const previousSummary: string | undefined =
				rawPreviousSummary === undefined || rawPreviousSummary === null
					? undefined
					: String(rawPreviousSummary);
			try {
				snapshot.put(sessionId, {
					messagesToSummarize: messagesToSummarize as never,
					turnPrefixMessages: turnPrefixMessages as never,
					isSplitTurn,
					firstKeptEntryId,
					tokensBefore,
					previousSummary,
					capturedAt: new Date().toISOString(),
				});
			} catch (err) {
				ctx?.ui?.notify?.(
					`compaction-optimizer: snapshot capture failed (${(err as Error).message}); archive will be skipped.`,
					"warning",
				);
			}

			// 3. Mode dispatch.
			const mode: Mode = settings.mode;
			const customInstructions: string | undefined = event?.customInstructions;

			let useDeterministic = false;
			let customInstructionsDropped = false;
			// Hoisted so the fall-through branch can read `.reason` / `.metrics`
			// for the path-taken notify (#242). Populated only when mode=hybrid.
			let hybridResult:
				| ReturnType<typeof decideHybrid>
				| undefined;

			if (mode === "deterministic") {
				useDeterministic = true;
				if (customInstructions && customInstructions.trim().length > 0) {
					customInstructionsDropped = true;
					notifyOnce(
						ctx,
						`mode:${sessionId}:det-instructions`,
						"compaction-optimizer: /compact <instructions> not honored in deterministic mode; switch to hybrid or llm-only-with-dump to use custom instructions.",
						"warning",
					);
				}
			} else if (mode === "hybrid") {
				// Context-window-relative token gate (ADR-0107). `ctx.model` may be
				// undefined (ExtensionContext.model is optional in pi's contract);
				// decideHybrid falls back to the absolute maxTokens gate when the
				// window is unknown or non-positive.
				const { contextWindow } = modelInfoOf(ctx);
				hybridResult = decideHybrid({
					messages: messagesToSummarize as never,
					tokensBefore,
					customInstructions,
					thresholds: settings.hybrid,
					contextWindow,
				});
				useDeterministic = hybridResult.decision === "deterministic";
			}
			// mode === "llm-only-with-dump": always fall through.

			if (
				useDeterministic &&
				fileOps &&
				fileOps.read instanceof Set &&
				fileOps.written instanceof Set &&
				fileOps.edited instanceof Set
			) {
				try {
					// generatedAt pinned once per compaction so every rung retry
					// renders the identical timestamp (per-rung byte-determinism,
					// ADR-0108).
					const builderInput = {
						messagesToSummarize: messagesToSummarize as never,
						turnPrefixMessages: turnPrefixMessages as never,
						isSplitTurn,
						previousSummary,
						previousSummaryMaxChars: settings.hybrid.previousSummaryMaxChars,
						fileOps,
						tokensBefore,
						generatedAt: new Date().toISOString(),
						customInstructionsDropped,
					};
					// Output-side shrink ladder (#254, ADR-0108): walk RUNG_ORDER
					// until the rendered summary fits the budget (first fit wins).
					const budget = settings.hybrid.maxOutputTokens;
					let rung: Rung = "full";
					let summary = buildAtRung(builderInput, rung);
					for (const next of RUNG_ORDER.slice(1)) {
						if (estimateSummaryTokens(summary) <= budget) break;
						rung = next;
						summary = buildAtRung(builderInput, rung);
					}
					const overBudget = estimateSummaryTokens(summary) > budget;
					const notifyMeta = {
						mode,
						messageCount:
							hybridResult?.metrics.messageCount ?? messagesToSummarize.length,
						tokenEstimate: hybridResult?.metrics.tokenEstimate ?? tokensBefore,
						tokensFromPi: tokensBefore > 0,
					};
					if (overBudget && mode !== "deterministic") {
						// Even the stub exceeds the budget — hybrid tolerates an LLM
						// call, so fall through. Path-taken notify (#242) fires here,
						// AFTER the ladder outcome is final.
						ctx?.ui?.notify?.(
							formatPathNotify({ path: "ladder-exhausted", ...notifyMeta }),
							"info",
						);
						return undefined;
					}
					if (overBudget) {
						// mode=deterministic is an air-gap guarantee (ADR-0019): no
						// LLM fallback exists. Emit the stub anyway, loudly.
						ctx?.ui?.notify?.(
							"compaction-optimizer: stub-rung summary still exceeds hybrid.maxOutputTokens in deterministic mode; emitting anyway — no LLM fallback available in this mode.",
							"warning",
						);
					}
					// Mirror pi's CompactionDetails shape so cumulative file-tracking
					// across compactions keeps working, plus our extension marker.
					// Invariant (ADR-0108): details is built from fileOps directly,
					// never derived from the rendered markdown — rungs that drop the
					// File Activity section do not affect it.
					const readFiles = [...fileOps.read].sort();
					const modifiedFiles = [
						...new Set([...fileOps.written, ...fileOps.edited]),
					].sort();
					// Path-taken notify (#242): air-gapped deterministic branch,
					// emitted only after the rung decision is final.
					ctx?.ui?.notify?.(
						formatPathNotify({ path: "deterministic", rung, ...notifyMeta }),
						"info",
					);
					return {
						compaction: {
							summary,
							firstKeptEntryId,
							tokensBefore,
							details: {
								readFiles,
								modifiedFiles,
								generatedBy: "compaction-optimizer",
								mode,
							},
						},
					};
				} catch (err) {
					ctx?.ui?.notify?.(
						`compaction-optimizer: deterministic build failed (${(err as Error).message}); falling through to LLM summarizer.`,
						"warning",
					);
					return undefined;
				}
			}

			// llm-only-with-dump or hybrid-fall-through: pi default compact() runs.
			// If the operator explicitly chose deterministic and we still reached
			// this branch, fileOps was missing or not Set-shaped (future pi shape
			// drift). Surface that so the fall-through is not silent.
			if (useDeterministic) {
				notifyOnce(
					ctx,
					`mode:${sessionId}:det-fileops-missing`,
					"compaction-optimizer: deterministic mode requested but preparation.fileOps was missing or not Set-shaped; falling through to pi default LLM summarizer.",
					"warning",
				);
			}
			// Path-taken notify (#242): hybrid fall-through or llm-only-with-dump.
			// Skipped when useDeterministic was true but fileOps was missing — the
			// warning above is the louder, more useful signal in that edge case.
			if (!useDeterministic) {
				if (mode === "hybrid" && hybridResult) {
					ctx?.ui?.notify?.(
						formatPathNotify({
							path: "fall-through",
							mode,
							messageCount: hybridResult.metrics.messageCount,
							tokenEstimate: hybridResult.metrics.tokenEstimate,
							tokensFromPi: tokensBefore > 0,
							reason: hybridResult.reason,
						}),
						"info",
					);
				} else if (mode === "llm-only-with-dump") {
					ctx?.ui?.notify?.(
						formatPathNotify({
							path: "llm-only",
							mode,
							messageCount: messagesToSummarize.length,
							tokenEstimate: tokensBefore,
							tokensFromPi: tokensBefore > 0,
						}),
						"info",
					);
				}
			}
			return undefined;
		},
	);

	pi.on("session_compact", async (_event: Pi, ctx: Pi): Promise<void> => {
		const sessionId = sessionIdOf(ctx);
		// When-policy bookkeeping (#677): a compaction committed — record it,
		// reset the deferral counter, and re-arm the defer/ceiling toasts so a
		// later deferral episode in the same session notifies again.
		phaseState.noteCompaction(sessionId);
		MODE_NOTIFY_SENT.delete(`defer:${sessionId}:active`);
		MODE_NOTIFY_SENT.delete(`defer:${sessionId}:ceiling`);
		const snap = snapshot.take(sessionId);
		if (!snap) return; // No captured payload (e.g., compaction was cancelled).

		let settings: CompactionOptimizerSettings;
		try {
			settings = await loadSettings({
				cwd: ctx.cwd,
				notify: (m, t) => ctx?.ui?.notify?.(m, t),
			});
		} catch {
			// If settings load fails here, skip the archive — we don't have a safe
			// path to write to. The pre-commit handler already loaded settings
			// successfully or failed loudly; this branch is defensive. The snapshot
			// was already consumed by snapshot.take() above, so warn the user that
			// this checkpoint's archive is being dropped — it is silent data loss
			// otherwise (it especially matters in llm-only-with-dump mode, where the
			// archive is the primary record).
			ctx?.ui?.notify?.(
				"compaction-optimizer: settings load failed at session_compact; the archive for this checkpoint was skipped",
				"warning",
			);
			return;
		}

		await writeArchive({
			sessionId,
			isPersisted: isPersistedOf(ctx),
			snapshot: snap,
			settings,
			notify: (m, t) => ctx?.ui?.notify?.(m, t),
			signal: ctx?.signal,
		});
	});

	pi.on("session_shutdown", async (_event: Pi, ctx: Pi): Promise<void> => {
		const sessionId = sessionIdOf(ctx);
		snapshot.clear(sessionId);
		clearNotifyForSession(sessionId);
		phaseState.clearSession(sessionId);
		await cleanupEphemerals();
	});

	// ------------------------------------------------------------------
	// When-policy signal wiring (#677, ADR-0109). All handlers are
	// observational and must never disturb a turn — each swallows errors.
	// ------------------------------------------------------------------

	pi.on("turn_end", async (event: Pi, ctx: Pi): Promise<void> => {
		try {
			phaseState.noteTurnEnd(sessionIdOf(ctx), Number(event?.turnIndex ?? 0));
		} catch {
			/* observational only */
		}
	});

	pi.on("tool_execution_start", async (event: Pi, ctx: Pi): Promise<void> => {
		try {
			if (event?.toolName !== "subagent") return;
			phaseState.subagentStarted(sessionIdOf(ctx), String(event?.toolCallId ?? ""));
		} catch {
			/* observational only */
		}
	});

	pi.on("tool_execution_end", async (event: Pi, ctx: Pi): Promise<void> => {
		try {
			if (event?.toolName !== "subagent") return;
			phaseState.subagentEnded(sessionIdOf(ctx), String(event?.toolCallId ?? ""));
		} catch {
			/* observational only */
		}
	});

	pi.on("agent_settled", async (_event: Pi, ctx: Pi): Promise<void> => {
		// Proactive phase-boundary compaction (#677, ADR-0109): pay the one
		// unavoidable cold re-prefill at the cheapest moment — a settled
		// session at a fresh task-type boundary with a compaction imminent
		// anyway — instead of mid-phase at pi's threshold fire.
		try {
			const sessionId = sessionIdOf(ctx);
			let settings: CompactionOptimizerSettings;
			try {
				// Deliberately no notify callback here: agent_settled fires once
				// per settled turn, so malformed-settings warnings would repeat
				// every turn. The compaction-path loads (which run at most once
				// per compaction) own surfacing those warnings.
				settings = await loadSettings({ cwd: ctx.cwd });
			} catch {
				return;
			}
			if (!settings.timing.enabled) return;
			// Proactive trigger requires a callable ctx.compact — check BEFORE
			// arming the self-flag: an armed flag with no compact() call would
			// never be consumed and would skip the veto on the next unrelated
			// compaction fire (#781 review finding).
			const compactFn = (ctx as { compact?: unknown })?.compact;
			if (typeof compactFn !== "function") return;
			const modelInfo = modelInfoOf(ctx);
			const fire = decideProactive({
				settings: settings.timing,
				provider: modelInfo.provider,
				contextWindow: modelInfo.contextWindow,
				usageTokens: Number(ctx?.getContextUsage?.()?.tokens ?? 0),
				phase: {
					subagentInFlight: phaseState.subagentInFlight(sessionId),
					turnsSinceTaskTypeChange:
						phaseState.turnsSinceTaskTypeChange(sessionId),
					taskTypeChangedSinceCompaction:
						phaseState.taskTypeChangedSinceCompaction(sessionId),
					deferrals: phaseState.deferralCount(sessionId),
				},
			});
			if (!fire) return;
			phaseState.armSelfCompact(sessionId);
			ctx?.ui?.notify?.(
				"compaction-optimizer: phase-boundary compaction triggered (task-type transition, usage past proactive threshold).",
				"info",
			);
			(compactFn as (opts: { onError: () => void }) => void).call(ctx, {
				onError: () => phaseState.disarmSelfCompact(sessionId),
			});
		} catch {
			/* the policy must never disturb a settled session */
		}
	});
}
