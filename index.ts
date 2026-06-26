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
 *        `{compaction: CompactionResult}` (skips pi's LLM call entirely).
 *      - `hybrid` — heuristic; deterministic when tool-call-dense, else
 *        return `undefined` to fall through to pi's LLM summarizer.
 *      - `llm-only-with-dump` — always return `undefined` (LLM summarizes,
 *        archive captures the raw pre-cut payload).
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
	buildDeterministicSummary,
	type FileOperationsLike,
} from "./lib/deterministic-summary.ts";
import { decideHybrid } from "./lib/hybrid.ts";

// Loose typing for the extension API — pi types are sourced from the runtime
// at load time and are not bundled with this repo.
// biome-ignore lint/suspicious/noExplicitAny: extension API surface
type Pi = any;

const MODE_NOTIFY_SENT = new Set<string>();

function clearNotifyForSession(sessionId: string): void {
	const prefix = `mode:${sessionId}:`;
	for (const key of MODE_NOTIFY_SENT) {
		if (key.startsWith(prefix)) MODE_NOTIFY_SENT.delete(key);
	}
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
	path: "deterministic" | "fall-through" | "llm-only";
	mode: Mode;
	messageCount: number;
	tokenEstimate: number;
	tokensFromPi: boolean;
	reason?: string;
}): string {
	const tokenStr = `${opts.tokensFromPi ? "" : "~"}${opts.tokenEstimate} tokens`;
	const tail = `${opts.messageCount} msgs, ${tokenStr}`;
	if (opts.path === "deterministic") {
		return `compaction-optimizer: air-gapped deterministic summary (mode=${opts.mode}, ${tail})`;
	}
	if (opts.path === "fall-through") {
		return `compaction-optimizer: fell through to pi LLM summarizer (mode=${opts.mode}, reason=${opts.reason ?? "unknown"}, ${tail})`;
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
		async (event: Pi, ctx: Pi): Promise<undefined | { compaction: unknown }> => {
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
				hybridResult = decideHybrid({
					messages: messagesToSummarize as never,
					tokensBefore,
					customInstructions,
					thresholds: settings.hybrid,
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
					const summary = buildDeterministicSummary({
						messagesToSummarize: messagesToSummarize as never,
						turnPrefixMessages: turnPrefixMessages as never,
						isSplitTurn,
						previousSummary,
						previousSummaryMaxChars: settings.hybrid.previousSummaryMaxChars,
						fileOps,
						tokensBefore,
						generatedAt: new Date().toISOString(),
						customInstructionsDropped,
					});
					// Mirror pi's CompactionDetails shape so cumulative file-tracking
					// across compactions keeps working, plus our extension marker.
					const readFiles = [...fileOps.read].sort();
					const modifiedFiles = [
						...new Set([...fileOps.written, ...fileOps.edited]),
					].sort();
					// Path-taken notify (#242): air-gapped deterministic branch.
					ctx?.ui?.notify?.(
						formatPathNotify({
							path: "deterministic",
							mode,
							messageCount:
								hybridResult?.metrics.messageCount ?? messagesToSummarize.length,
							tokenEstimate: hybridResult?.metrics.tokenEstimate ?? tokensBefore,
							tokensFromPi: tokensBefore > 0,
						}),
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
		await cleanupEphemerals();
	});
}
