/**
 * Settings layer for the compaction-optimizer extension.
 *
 * Loads `~/.pi/agent/settings.json` (user) then `<cwd>/.pi/settings.json`
 * (project). Project values override user values *only for keys on the
 * project-layer allowlist*. Rejected project-layer keys produce a one-shot
 * `ctx.ui.notify` warning naming the rejected key.
 *
 * Trust boundary: `<cwd>/.pi/settings.json` is, by the project-overrides-user
 * precedence convention, attacker-controlled the moment a user `cd`s into a
 * cloned repository. See ADR-0019 § Threat Model — Trust boundary.
 *
 * Source rules: ADR-0019 § Decision Outcome, § Threat Model.
 * Tracking: #208 PR1 acceptance criteria — Settings layer.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type Mode = "deterministic" | "hybrid" | "llm-only-with-dump";
export type EphemeralBehavior = "skip" | "tmp";

export interface HybridThresholds {
	maxMessages?: number;
	maxTokens?: number;
	minToolCallRatio?: number;
	maxOrphanAssistantTokens?: number;
	/**
	 * Cap on the number of characters of `previousSummary` re-inlined into
	 * the deterministic builder's `## Carried-Forward Context` section.
	 * 0 = drop the section entirely (full prior summary remains in archive).
	 * Bounds geometric summary growth across successive compactions (#253).
	 */
	previousSummaryMaxChars?: number;
}

export interface FileTrackerSettings {
	/** Cap on number of read-only file paths retained per compaction. */
	maxReadFiles?: number;
	/** Drop read files older than N compactions (currently informational). */
	staleAfterCompactions?: number;
	/** Path-pattern filters; files matching any pattern are dropped from `read`. */
	dropPatterns?: string[];
}

export interface ArchiveSettings {
	enabled?: boolean;
	/** Absolute or `~`-rooted path. User-layer only; project-layer rejected. */
	path?: string;
	/** Ephemeral-session behavior. User-layer only; project-layer rejected. */
	ephemeralBehavior?: EphemeralBehavior;
	/** Regex patterns applied to archive content. User-layer only. */
	redactPatterns?: string[];
}

export interface CompactionOptimizerSettings {
	mode: Mode;
	hybrid: Required<HybridThresholds>;
	fileTracker: Required<FileTrackerSettings>;
	archive: Required<ArchiveSettings>;
}

export const DEFAULTS: CompactionOptimizerSettings = {
	// ADR-0019 default (PR2 active). `hybrid` runs the deterministic builder
	// when the conversation is tool-call-dense, and falls through to pi's LLM
	// summarizer otherwise (orphan assistant text, custom instructions, high
	// message/token count, low tool-call ratio).
	mode: "hybrid",
	hybrid: {
		maxMessages: 200,
		maxTokens: 60000,
		minToolCallRatio: 0.3,
		maxOrphanAssistantTokens: 2000,
		// 500 chars ≈ 125 tokens. Preserves a flavor of the prior summary for
		// next-session continuity without re-inlining the full text (which
		// recursively contains its own prior summary — geometric growth, #253).
		// 0 drops the section entirely; archive remains the canonical source.
		previousSummaryMaxChars: 500,
	},
	fileTracker: {
		maxReadFiles: 50,
		staleAfterCompactions: 3,
		dropPatterns: [],
	},
	archive: {
		enabled: true,
		path: "~/.pi/agent/extensions/compaction-optimizer/archive",
		ephemeralBehavior: "skip",
		redactPatterns: [],
	},
};

/** Keys the project layer (`<cwd>/.pi/settings.json`) MAY override. */
const PROJECT_LAYER_ALLOWLIST = new Set<string>([
	"mode",
	"hybrid.maxMessages",
	"hybrid.maxTokens",
	"hybrid.minToolCallRatio",
	"hybrid.maxOrphanAssistantTokens",
	"hybrid.previousSummaryMaxChars",
	"fileTracker.maxReadFiles",
	"fileTracker.staleAfterCompactions",
	"archive.enabled",
]);

/** Keys the project layer MUST NOT override (rejected with notify). */
const PROJECT_LAYER_REJECT = new Set<string>([
	"archive.path",
	"archive.ephemeralBehavior",
	"archive.redactPatterns",
	"fileTracker.dropPatterns",
]);

/**
 * Project-layer numeric clamps. A hostile or misconfigured `.pi/settings.json`
 * could otherwise (a) force every cluster into the deterministic path by
 * zeroing `minToolCallRatio` and ballooning `maxOrphanAssistantTokens`,
 * (b) push `maxMessages` / `maxTokens` past the envelope the user-layer
 * policy intends. Not exfiltration primitives — deterministic-mode content
 * is bounded to data pi already persists in the raw session file — but they
 * shape the persisted summary future LLM turns will read. Defense-in-depth.
 *
 * Source: security-review-expert finding on PR2 (#216).
 */
const PROJECT_LAYER_CLAMPS: Record<string, { min?: number; max?: number }> = {
	"hybrid.maxMessages": { min: 1, max: 2000 },
	"hybrid.maxTokens": { min: 1, max: 500_000 },
	"hybrid.minToolCallRatio": { min: 0, max: 1 },
	"hybrid.maxOrphanAssistantTokens": { min: 0, max: 100_000 },
	"hybrid.previousSummaryMaxChars": { min: 0, max: 100_000 },
	"fileTracker.maxReadFiles": { min: 1, max: 1000 },
	"fileTracker.staleAfterCompactions": { min: 1, max: 100 },
};

function clampProjectValue(
	key: string,
	value: unknown,
): { value: unknown; clamped: boolean } {
	const clamp = PROJECT_LAYER_CLAMPS[key];
	if (!clamp || typeof value !== "number" || !Number.isFinite(value)) {
		return { value, clamped: false };
	}
	let next = value;
	if (clamp.min !== undefined && next < clamp.min) next = clamp.min;
	if (clamp.max !== undefined && next > clamp.max) next = clamp.max;
	return { value: next, clamped: next !== value };
}

export interface NotifyFn {
	(message: string, type?: "info" | "warning" | "error"): void;
}

interface RawSettingsFile {
	extensionSettings?: {
		compactionOptimizer?: Record<string, unknown>;
	};
}

async function readJson(
	path: string,
	notify: NotifyFn | undefined,
	label: string,
): Promise<RawSettingsFile> {
	try {
		const buf = await fs.readFile(path, "utf-8");
		return JSON.parse(buf) as RawSettingsFile;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		// Malformed JSON or read error: degrade safely to defaults, surface notify.
		notify?.(
			`compaction-optimizer: ignoring malformed ${label} settings at '${path}' (${(err as Error).message}); applying defaults.`,
			"warning",
		);
		return {};
	}
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return p;
}

/**
 * Prototype-polluting keys refused by `flatten`, `assignDotted`, and
 * `deepMerge`. User-layer settings are ADR-treated as trusted, but defending
 * against `__proto__` / `constructor` / `prototype` is cheap defense-in-depth
 * recommended by security-review-expert on PR1 (#208).
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursively flatten a nested object to dotted-key form. */
function flatten(obj: Record<string, unknown>, prefix = ""): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const [k, v] of Object.entries(obj)) {
		if (FORBIDDEN_KEYS.has(k)) continue;
		const key = prefix ? `${prefix}.${k}` : k;
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			for (const [kk, vv] of flatten(v as Record<string, unknown>, key)) {
				out.set(kk, vv);
			}
		} else {
			out.set(key, v);
		}
	}
	return out;
}

/** Assign a dotted key into a nested target object. Refuses forbidden keys. */
function assignDotted(target: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".");
	if (parts.some((p) => FORBIDDEN_KEYS.has(p))) return;
	let cursor: Record<string, unknown> = target;
	for (let i = 0; i < parts.length - 1; i++) {
		const next = cursor[parts[i]];
		if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
			cursor[parts[i]] = {};
		}
		cursor = cursor[parts[i]] as Record<string, unknown>;
	}
	cursor[parts[parts.length - 1]] = value;
}

/** Deep-merge `src` into `dst` (object values merged; arrays/primitives replaced). */
function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>): void {
	for (const [k, v] of Object.entries(src)) {
		if (FORBIDDEN_KEYS.has(k)) continue;
		const existing = dst[k];
		if (
			v !== null &&
			typeof v === "object" &&
			!Array.isArray(v) &&
			existing !== null &&
			typeof existing === "object" &&
			!Array.isArray(existing)
		) {
			deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
		} else {
			dst[k] = v;
		}
	}
}

/** Apply post-merge expansions/coercions to produce the typed settings. */
function materialize(raw: Record<string, unknown>): CompactionOptimizerSettings {
	const out: CompactionOptimizerSettings = JSON.parse(JSON.stringify(DEFAULTS));
	deepMerge(out as unknown as Record<string, unknown>, raw);
	if (typeof out.archive.path === "string") {
		out.archive.path = expandTilde(out.archive.path);
	}
	return out;
}

export interface LoadOptions {
	/** Absolute path to user settings file. Defaults to `~/.pi/agent/settings.json`. */
	userSettingsPath?: string;
	/** Project root (cwd). Project settings read from `<cwd>/.pi/settings.json`. */
	cwd: string;
	/** Notify hook for rejected project-layer keys. */
	notify?: NotifyFn;
}

/**
 * Load user + project settings, enforcing the project-layer allowlist.
 *
 * Returns the merged, materialized settings. Unknown keys in either layer
 * are passed through to the merge but ignored by the consumer (`DEFAULTS`
 * shape is the consumer contract).
 */
export async function loadSettings(opts: LoadOptions): Promise<CompactionOptimizerSettings> {
	const userPath = opts.userSettingsPath ?? resolve(homedir(), ".pi/agent/settings.json");
	const projectPath = resolve(opts.cwd, ".pi/settings.json");

	const userRaw = await readJson(userPath, opts.notify, "user-layer");
	const projectRaw = await readJson(projectPath, opts.notify, "project-layer");

	const userBlock = (userRaw.extensionSettings?.compactionOptimizer ?? {});
	const projectBlock = (projectRaw.extensionSettings?.compactionOptimizer ?? {});

	// Filter the project block: only allowlist keys pass through.
	const projectFlat = flatten(projectBlock);
	const projectFiltered: Record<string, unknown> = {};
	const rejected: string[] = [];
	const clamped: string[] = [];
	for (const [k, v] of projectFlat) {
		if (PROJECT_LAYER_ALLOWLIST.has(k)) {
			const { value, clamped: wasClamped } = clampProjectValue(k, v);
			if (wasClamped) clamped.push(k);
			assignDotted(projectFiltered, k, value);
		} else if (PROJECT_LAYER_REJECT.has(k) || k.startsWith("archive.")) {
			// Explicit reject list + any other archive.* key not allowlisted.
			rejected.push(k);
		} else {
			// Unknown key: drop silently. Forward-compat for keys added by later PRs
			// that this PR1 binary does not yet know about.
		}
	}

	if (rejected.length > 0 && opts.notify) {
		for (const k of rejected) {
			opts.notify(
				`compaction-optimizer: ignoring project-layer setting 'extensionSettings.compactionOptimizer.${k}' — not on project-layer allowlist (see ADR-0019 Threat Model).`,
				"warning",
			);
		}
	}

	if (clamped.length > 0 && opts.notify) {
		for (const k of clamped) {
			const c = PROJECT_LAYER_CLAMPS[k];
			opts.notify(
				`compaction-optimizer: clamped project-layer 'extensionSettings.compactionOptimizer.${k}' to [${c?.min ?? "-∞"}, ${c?.max ?? "+∞"}] (defense-in-depth).`,
				"warning",
			);
		}
	}

	// Merge: defaults <- user <- project (filtered).
	const merged: Record<string, unknown> = {};
	deepMerge(merged, userBlock);
	deepMerge(merged, projectFiltered);

	return materialize(merged);
}

/** Public: return a deep clone of DEFAULTS for safe fallback after a load failure. */
export function getDefaults(): CompactionOptimizerSettings {
	return JSON.parse(JSON.stringify(DEFAULTS));
}

// Exported for tests.
export const __internal = {
	PROJECT_LAYER_ALLOWLIST,
	PROJECT_LAYER_REJECT,
	flatten,
	assignDotted,
	deepMerge,
	expandTilde,
	materialize,
};
