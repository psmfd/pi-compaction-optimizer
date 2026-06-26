/**
 * File-tracker pruning for `event.preparation.fileOps`.
 *
 * Mutates the `FileOperations = {read, written, edited}: Set<string>` shape
 * in place before the handler returns. Default pi `compact()` consumes the
 * pruned sets via `computeFileLists()` to produce `CompactionDetails.readFiles`
 * and `modifiedFiles`. Pruning the upstream sets propagates correctly through
 * the LLM-fall-through path (PR1 default mode).
 *
 * `modifiedFiles` (the union of `written` ∪ `edited`) is NEVER pruned — the
 * record of what changed during the session must survive compaction in full.
 * Only the `read` set is capped/filtered.
 *
 * Source rules: ADR-0019 § Consequences (Bounded file-tracker), Decision Outcome.
 */

import type { FileTrackerSettings } from "./settings.ts";

export interface FileOperationsLike {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface PruneResult {
	readBefore: number;
	readAfter: number;
	droppedByPattern: number;
	droppedByCap: number;
}

function compilePattern(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

/**
 * Prune `fileOps.read` in place:
 *   1. Drop entries matching any `dropPatterns` regex.
 *   2. If still over `maxReadFiles`, evict oldest insertion order (Set
 *      iteration order is insertion order in JavaScript), keeping the most
 *      recent N. Recent entries are more likely to be relevant carry-forward.
 *
 * Note: `staleAfterCompactions` from settings is currently informational; the
 * default `compact()` path does not surface per-file "age in compactions" to
 * extensions, so applying it requires reading historical `CompactionEntry`
 * details. Deferred to PR2 or later; settings key reserved for forward-compat.
 */
export function pruneReadSet(
	fileOps: FileOperationsLike,
	settings: Required<FileTrackerSettings>,
): PruneResult {
	const readBefore = fileOps.read.size;

	// Step 1: drop-by-pattern.
	const patterns = settings.dropPatterns
		.map((p) => compilePattern(p))
		.filter((r): r is RegExp => r !== undefined);
	let droppedByPattern = 0;
	if (patterns.length > 0) {
		for (const path of fileOps.read) {
			if (patterns.some((re) => re.test(path))) {
				fileOps.read.delete(path);
				droppedByPattern++;
			}
		}
	}

	// Step 2: cap.
	let droppedByCap = 0;
	const cap = settings.maxReadFiles;
	if (cap >= 0 && fileOps.read.size > cap) {
		const overflow = fileOps.read.size - cap;
		const iter = fileOps.read.values();
		for (let i = 0; i < overflow; i++) {
			const next = iter.next();
			if (next.done) break;
			fileOps.read.delete(next.value);
			droppedByCap++;
		}
	}

	return {
		readBefore,
		readAfter: fileOps.read.size,
		droppedByPattern,
		droppedByCap,
	};
}
