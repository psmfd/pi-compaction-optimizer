/**
 * Archive writer for the compaction-optimizer extension.
 *
 * Post-commit archive write triggered from `session_compact`. The pre-commit
 * `session_before_compact` handler captures the message payload into the
 * snapshot store; this module consumes the snapshot, renders it as markdown,
 * and writes it to disk under the configured archive root.
 *
 * Hard invariants (PR1 acceptance, ADR-0019 § Threat Model — File-system posture):
 *   - Per-session directory created with mode 0o700.
 *   - Archive file created with mode 0o600.
 *   - Symlink components refused: realpath the deepest existing ancestor and
 *     verify it lies under realpath(archive root); refuse otherwise.
 *   - Tempfile opened with O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW so
 *     a leaf symlink yields ELOOP and a pre-existing tempfile name fails
 *     EEXIST.
 *   - Pre-existing target refused: explicit fs.access check before rename(2).
 *   - Failures append a JSON record to `<archive root>/../failure.log` and
 *     never re-raise. Archive write is best-effort.
 *
 * Source rules: ADR-0019 § Decision Outcome (post-commit placement),
 *               ADR-0019 § Threat Model — File-system posture,
 *               ADR-0019 § Threat Model — Content sensitivity.
 */

import { promises as fs, constants as fsConstants, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionOptimizerSettings } from "./settings.ts";
import type { MessageSnapshot } from "./snapshot.ts";

/** Default archive root (mirrors DEFAULTS.archive.path post-tilde-expansion). */
export const DEFAULT_ARCHIVE_ROOT = resolve(
	homedir(),
	".pi/agent/extensions/compaction-optimizer/archive",
);

/** Failure log lives one level above the per-session archive dirs. */
export function failureLogPath(): string {
	return resolve(homedir(), ".pi/agent/extensions/compaction-optimizer/failure.log");
}

/**
 * Process-lifetime tracker for ephemeral archive roots created via `mkdtemp`.
 * Cleaned by `cleanupEphemerals()` (called on `session_shutdown` and process exit).
 */
const ephemeralRoots = new Set<string>();

/** Remove all ephemeral roots created during this process lifetime. */
export async function cleanupEphemerals(): Promise<void> {
	for (const path of ephemeralRoots) {
		try {
			await fs.rm(path, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		ephemeralRoots.delete(path);
	}
}

/** Synchronous variant for `process.on("exit")` (async listeners are not awaited). */
export function cleanupEphemeralsSync(): void {
	for (const path of ephemeralRoots) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		ephemeralRoots.delete(path);
	}
}

/**
 * Post-execution wall-clock threshold for `applyRedaction` (ms). After each
 * pattern's `replace()` returns, if elapsed exceeded this value, *remaining*
 * patterns are skipped. This is NOT a per-pattern preemption budget — Node's
 * regex engine cannot be interrupted mid-match. See `applyRedaction`.
 */
const REDACT_BUDGET_MS = 250;
/** Ephemeral sweep age threshold (24h in ms). */
const EPHEMERAL_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export interface WriteContext {
	sessionId: string;
	isPersisted: boolean;
	snapshot: MessageSnapshot;
	settings: CompactionOptimizerSettings;
	notify?: (msg: string, type?: "info" | "warning" | "error") => void;
	signal?: AbortSignal;
	/**
	 * Test-only override for the failure-log destination. When unset, the log
	 * resolves to `failureLogPath()` under the operator's `$HOME`. Tests MUST
	 * set this to a tmp path to avoid polluting the operator's user layer (see
	 * #236 — the leaked committed `failure.log` traced back to this gap).
	 */
	failureLogPath?: string;
	/**
	 * Test-only override for the timestamp clock. When unset, the writer
	 * calls `new Date()`. Tests use this to predict the target/tempfile
	 * filenames so they can pre-plant colliding symlinks for the
	 * O_NOFOLLOW leaf-refusal fixture (see #227). Production callers MUST
	 * NOT set this — the writer depends on monotonically-increasing
	 * timestamps for collision-free archive filenames.
	 */
	now?: () => Date;
	/**
	 * Test-only override for tempfile-suffix entropy. When unset, the writer
	 * calls `randomBytes(8)` from `node:crypto`. Tests use this to predict
	 * the tempfile path so they can pre-plant a colliding symlink for the
	 * O_NOFOLLOW leaf-refusal fixture (see #227). Production callers MUST
	 * NOT set this — the entropy is load-bearing against tempfile-name
	 * collisions between concurrent writers in the same session dir.
	 */
	randomBytes?: (n: number) => Buffer;
}

export interface WriteResult {
	status: "ok" | "skipped" | "failed";
	path?: string;
	reason?: string;
}

// ============================================================================
// Public entry points
// ============================================================================

/** Write the archive for a completed compaction. Never throws. */
export async function writeArchive(ctx: WriteContext): Promise<WriteResult> {
	try {
		if (!ctx.settings.archive.enabled) {
			return { status: "skipped", reason: "archive.enabled=false" };
		}
		if (ctx.signal?.aborted) {
			return { status: "skipped", reason: "aborted" };
		}

		const archiveRoot = await resolveArchiveRoot(ctx);
		if (archiveRoot === undefined) {
			return { status: "skipped", reason: "ephemeral session, behavior=skip" };
		}

		const content = renderArchive(ctx);
		const redacted = applyRedaction(content, ctx.settings.archive.redactPatterns, ctx.notify);

		const sessionDir = join(archiveRoot, ctx.sessionId);

		// Ensure the archive root exists FIRST, then realpath it so the safe-
		// ancestor check below operates on the canonical root path.
		await ensureDir(archiveRoot);

		// Symlink defense: lstat sessionDir BEFORE creating it. If it pre-exists
		// as a symlink, refuse — mkdir-recursive and fs.chmod both follow symlinks,
		// so creating-then-checking would leak a mode change (0o700) onto whatever
		// the symlink points to before the safe-ancestor assertion fires.
		try {
			const pre = await fs.lstat(sessionDir);
			if (pre.isSymbolicLink()) {
				return await recordFailure(
					ctx,
					`session directory is a pre-existing symlink: ${sessionDir}`,
					{ status: "failed", reason: "symlink-refused" },
				);
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				return await recordFailure(
					ctx,
					`lstat sessionDir failed: ${(err as Error).message}`,
					{ status: "failed", reason: "lstat-failed" },
				);
			}
			// ENOENT — expected for fresh sessions.
		}

		await ensureDir(sessionDir);

		const timestamp = (ctx.now ? ctx.now() : new Date())
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace(/Z$/, "");
		const targetName = `${timestamp}.md`;
		const target = join(sessionDir, targetName);

		// Realpath-based ancestor assertion: refuses any deeper symlink redirect.
		await assertSafeAncestor(sessionDir, archiveRoot);

		// Pre-existing target refusal.
		try {
			await fs.access(target, fsConstants.F_OK);
			return await recordFailure(
				ctx,
				`pre-existing target refused: ${target}`,
				{ status: "failed", reason: "target-exists" },
			);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				return await recordFailure(
					ctx,
					`access check failed for ${target}: ${(err as Error).message}`,
					{ status: "failed", reason: "access-failed" },
				);
			}
		}

		// Atomic write via O_NOFOLLOW | O_EXCL tempfile + rename.
		const tmpName = `.${targetName}.tmp-${(ctx.randomBytes ?? randomBytes)(8).toString("hex")}`;
		const tmpPath = join(sessionDir, tmpName);
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(
				tmpPath,
				fsConstants.O_WRONLY |
					fsConstants.O_CREAT |
					fsConstants.O_EXCL |
					fsConstants.O_NOFOLLOW,
				0o600,
			);
			await handle.writeFile(redacted, { encoding: "utf-8" });
			await handle.sync();
		} catch (err) {
			if (handle) await handle.close().catch(() => undefined);
			await fs.unlink(tmpPath).catch(() => undefined);
			const code = (err as NodeJS.ErrnoException).code;
			const reason =
				code === "ELOOP"
					? "symlink-refused"
					: code === "EEXIST"
						? "tempfile-collision"
						: "write-failed";
			return await recordFailure(
				ctx,
				`archive write failed (${code ?? "ERR"}): ${(err as Error).message}`,
				{ status: "failed", reason },
			);
		} finally {
			if (handle) await handle.close().catch(() => undefined);
		}

		try {
			// fs.link refuses to overwrite an existing target (EEXIST). This is
			// stronger than fs.rename, which on POSIX silently clobbers a regular
			// file at the destination — closing the TOCTOU window between the
			// access check above and the final commit.
			await fs.link(tmpPath, target);
		} catch (err) {
			await fs.unlink(tmpPath).catch(() => undefined);
			const code = (err as NodeJS.ErrnoException).code;
			return await recordFailure(
				ctx,
				`archive commit failed (${code ?? "ERR"}): ${(err as Error).message}`,
				{
					status: "failed",
					reason: code === "EEXIST" ? "target-exists" : "rename-failed",
				},
			);
		}
		// Best-effort cleanup of the tempfile hardlink; archive remains at `target`.
		await fs.unlink(tmpPath).catch((err) => {
			ctx.notify?.(
				`compaction-optimizer: tempfile unlink failed after successful link (${(err as Error).message}); archive at ${target} is intact, tempfile may remain.`,
				"info",
			);
		});

		return { status: "ok", path: target };
	} catch (err) {
		return await recordFailure(
			ctx,
			`unexpected archive error: ${(err as Error).message}`,
			{ status: "failed", reason: "unexpected" },
		);
	}
}

/**
 * Sweep ephemeral archive directories older than 24h.
 * Called at extension load. Never throws.
 */
export async function sweepEphemerals(): Promise<void> {
	try {
		const root = tmpdir();
		const entries = await fs.readdir(root, { withFileTypes: true });
		const now = Date.now();
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!entry.name.startsWith("pi-compaction-archive-")) continue;
			const full = join(root, entry.name);
			try {
				// lstat (not stat) so a symlink planted in $TMPDIR under our prefix is
				// never followed and never treated as a sweepable directory — a
				// followed symlink-to-dir would otherwise turn this best-effort sweep
				// into an arbitrary recursive-delete gadget. Only real directories are
				// swept. (Blast radius is per-user $TMPDIR, but harden regardless.)
				const stat = await fs.lstat(full);
				if (stat.isDirectory() && now - stat.mtimeMs > EPHEMERAL_SWEEP_AGE_MS) {
					await fs.rm(full, { recursive: true, force: true });
				}
			} catch {
				// best-effort
			}
		}
	} catch {
		// best-effort
	}
}

// ============================================================================
// Internal helpers
// ============================================================================

async function resolveArchiveRoot(ctx: WriteContext): Promise<string | undefined> {
	if (ctx.isPersisted) {
		const p = ctx.settings.archive.path;
		// Defensive: reject relative paths that slipped through (loader normalizes,
		// but archive.path is contractually absolute or ~-rooted at the user layer).
		if (!isAbsolute(p)) {
			await recordFailureBare(
				`archive.path is not absolute after expansion: '${p}'; falling back to default root.`,
				{ sessionId: ctx.sessionId, logPath: ctx.failureLogPath },
			);
			return DEFAULT_ARCHIVE_ROOT;
		}
		return p;
	}

	// Ephemeral session.
	if (ctx.settings.archive.ephemeralBehavior === "skip") return undefined;
	const ephRoot = await fs.mkdtemp(join(tmpdir(), "pi-compaction-archive-"));
	await fs.chmod(ephRoot, 0o700).catch(() => undefined);
	ephemeralRoots.add(ephRoot);
	return ephRoot;
}

async function ensureDir(path: string): Promise<void> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	// `mkdir` does not chmod existing dirs; tighten if loose.
	await fs.chmod(path, 0o700).catch(() => undefined);
}

/**
 * Assert that realpath(dir) lies under realpath(root) — i.e., no symlink
 * component redirects writes outside the archive root. Throws on violation.
 */
async function assertSafeAncestor(dir: string, root: string): Promise<void> {
	const realRoot = await fs.realpath(root);
	const realDir = await fs.realpath(dir);
	if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
		throw new Error(
			`symlink-refused: resolved dir '${realDir}' is not under archive root '${realRoot}'`,
		);
	}
}

function applyRedaction(
	content: string,
	patterns: readonly string[],
	notify?: WriteContext["notify"],
): string {
	// Redaction posture: per-pattern *detect-and-break*, not per-pattern
	// preemption. Node's `RegExp` runs synchronously with no engine-level
	// timeout; a catastrophic-backtracking pattern blocks the event loop until
	// completion. The wall-clock measurement below fires AFTER `replace`
	// returns and only prevents *subsequent* patterns from running. Since
	// `archive.redactPatterns` is user-layer-only (project-layer rejected per
	// ADR-0019 Threat Model), the worst-case is self-DoS by the user's own
	// settings file — not a cross-trust-boundary vector. README documents this
	// limit honestly. True preemption would require worker_threads.terminate().
	if (patterns.length === 0) return content;
	let out = content;
	for (let i = 0; i < patterns.length; i++) {
		const raw = patterns[i];
		let re: RegExp;
		try {
			re = new RegExp(raw, "g");
		} catch (err) {
			notify?.(
				`compaction-optimizer: skipping invalid redactPatterns[${i}]='${raw}' (${(err as Error).message})`,
				"warning",
			);
			continue;
		}
		const t0 = performance.now();
		try {
			out = out.replace(re, "[REDACTED]");
		} catch (err) {
			notify?.(
				`compaction-optimizer: redactPatterns[${i}] failed: ${(err as Error).message}`,
				"warning",
			);
			continue;
		}
		const elapsed = performance.now() - t0;
		if (elapsed > REDACT_BUDGET_MS) {
			notify?.(
				`compaction-optimizer: redactPatterns[${i}]='${raw}' took ${elapsed.toFixed(0)}ms (>${REDACT_BUDGET_MS}ms); skipping remaining patterns to bound additional latency. (Single-pattern execution cannot be preempted by Node's regex engine.)`,
				"warning",
			);
			break;
		}
	}
	return out;
}

function renderArchive(ctx: WriteContext): string {
	const { snapshot } = ctx;
	const lines: string[] = [];
	lines.push("# Compaction archive");
	lines.push("");
	lines.push(`- session_id: ${ctx.sessionId}`);
	lines.push(`- captured_at: ${snapshot.capturedAt}`);
	lines.push(`- first_kept_entry_id: ${snapshot.firstKeptEntryId}`);
	lines.push(`- tokens_before: ${snapshot.tokensBefore}`);
	lines.push(`- is_split_turn: ${snapshot.isSplitTurn}`);
	lines.push(`- messages_summarized: ${snapshot.messagesToSummarize.length}`);
	lines.push(`- turn_prefix_messages: ${snapshot.turnPrefixMessages.length}`);
	if (snapshot.previousSummary) {
		lines.push("");
		lines.push("## Previous summary");
		lines.push("");
		lines.push(snapshot.previousSummary);
	}
	lines.push("");
	lines.push("## Summarized messages");
	lines.push("");
	for (const msg of snapshot.messagesToSummarize) {
		lines.push(renderMessage(msg));
		lines.push("");
	}
	if (snapshot.turnPrefixMessages.length > 0) {
		lines.push("## Turn prefix");
		lines.push("");
		for (const msg of snapshot.turnPrefixMessages) {
			lines.push(renderMessage(msg));
			lines.push("");
		}
	}
	return lines.join("\n");
}

function renderMessage(msg: AgentMessage): string {
	// Conservative renderer: dump the role and serialize JSON for the body.
	// Goal is verbatim preservation, not pretty rendering — PR2's
	// deterministic builder will produce richer output.
	const role = (msg as { role?: string }).role ?? "unknown";
	const body = JSON.stringify(msg, null, 2);
	return `### ${role}\n\n\`\`\`json\n${body}\n\`\`\``;
}

// ============================================================================
// Failure log
// ============================================================================

async function recordFailure(
	ctx: WriteContext,
	message: string,
	result: WriteResult,
): Promise<WriteResult> {
	ctx.notify?.(`compaction-optimizer: ${message}`, "warning");
	await recordFailureBare(message, { sessionId: ctx.sessionId, logPath: ctx.failureLogPath });
	return result;
}

async function recordFailureBare(
	message: string,
	opts: { sessionId?: string; logPath?: string } = {},
): Promise<void> {
	try {
		const path = opts.logPath ?? failureLogPath();
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const record =
			JSON.stringify({
				ts: new Date().toISOString(),
				sessionId: opts.sessionId ?? null,
				message,
			}) + "\n";
		// Open append-only with O_NOFOLLOW. Refuse to create through a symlink.
		const handle = await fs.open(
			path,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_APPEND |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(record, { encoding: "utf-8" });
		} finally {
			await handle.close();
		}
	} catch {
		// failure.log itself failed; degrade silently.
	}
}

// Test surface.
export const __internal = {
	renderArchive,
	applyRedaction,
	assertSafeAncestor,
	resolveArchiveRoot,
	REDACT_BUDGET_MS,
};
