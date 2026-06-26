/**
 * File-tracker pruning tests.
 *
 * Acceptance criteria covered (PR1, #208):
 *   - fileOps.read is capped at fileTracker.maxReadFiles, evicting oldest.
 *   - fileTracker.dropPatterns filters fileOps.read by regex.
 *   - modifiedFiles (written ∪ edited) is NEVER pruned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneReadSet, type FileOperationsLike } from "../lib/file-tracker.ts";

function mkOps(read: string[], written: string[] = [], edited: string[] = []): FileOperationsLike {
	return {
		read: new Set(read),
		written: new Set(written),
		edited: new Set(edited),
	};
}

test("cap evicts oldest entries first", () => {
	const ops = mkOps(["a", "b", "c", "d", "e"]);
	const res = pruneReadSet(ops, {
		maxReadFiles: 3,
		staleAfterCompactions: 3,
		dropPatterns: [],
	});
	assert.equal(res.readBefore, 5);
	assert.equal(res.readAfter, 3);
	assert.equal(res.droppedByCap, 2);
	assert.equal(res.droppedByPattern, 0);
	// Most-recent retained.
	assert.deepEqual([...ops.read], ["c", "d", "e"]);
});

test("dropPatterns runs before cap", () => {
	const ops = mkOps(["/tmp/x", "src/keep-1.ts", "src/keep-2.ts", "/tmp/y"]);
	const res = pruneReadSet(ops, {
		maxReadFiles: 50,
		staleAfterCompactions: 3,
		dropPatterns: ["^/tmp/"],
	});
	assert.equal(res.droppedByPattern, 2);
	assert.equal(res.droppedByCap, 0);
	assert.deepEqual([...ops.read].sort(), ["src/keep-1.ts", "src/keep-2.ts"]);
});

test("invalid pattern is skipped silently (best-effort)", () => {
	const ops = mkOps(["a", "b"]);
	const res = pruneReadSet(ops, {
		maxReadFiles: 50,
		staleAfterCompactions: 3,
		dropPatterns: ["[invalid("],
	});
	assert.equal(res.droppedByPattern, 0);
	assert.equal(ops.read.size, 2);
});

test("modifiedFiles (written ∪ edited) is never pruned", () => {
	const ops = mkOps(["r1", "r2"], ["w1", "w2", "w3"], ["e1", "e2", "e3"]);
	pruneReadSet(ops, {
		maxReadFiles: 0, // try to nuke everything
		staleAfterCompactions: 3,
		dropPatterns: [".*"], // drop every read
	});
	assert.equal(ops.read.size, 0);
	assert.equal(ops.written.size, 3);
	assert.equal(ops.edited.size, 3);
});

test("cap=0 empties the read set without touching modified", () => {
	const ops = mkOps(["a", "b"], ["w"], ["e"]);
	const res = pruneReadSet(ops, {
		maxReadFiles: 0,
		staleAfterCompactions: 3,
		dropPatterns: [],
	});
	assert.equal(res.readAfter, 0);
	assert.equal(ops.written.size, 1);
	assert.equal(ops.edited.size, 1);
});
