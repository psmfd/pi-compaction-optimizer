/**
 * Snapshot store tests.
 *
 * Acceptance criteria covered (PR1, #208):
 *   - Map bounded to 1 entry per session (overwrite stale captures).
 *   - take() consumes and clears.
 *   - clear() / clearAll() empty the map.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as snapshot from "../lib/snapshot.ts";

function snap(id: string) {
	return {
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		firstKeptEntryId: id,
		tokensBefore: 0,
		capturedAt: new Date().toISOString(),
	};
}

test("put then take returns the snapshot and clears", () => {
	snapshot.clearAll();
	snapshot.put("s1", snap("e1"));
	const out = snapshot.take("s1");
	assert.ok(out);
	assert.equal(out?.firstKeptEntryId, "e1");
	assert.equal(snapshot.take("s1"), undefined);
});

test("second put on same session overwrites first (cancelled-compaction case)", () => {
	snapshot.clearAll();
	snapshot.put("s1", snap("first"));
	snapshot.put("s1", snap("second"));
	assert.equal(snapshot.size(), 1);
	assert.equal(snapshot.take("s1")?.firstKeptEntryId, "second");
});

test("clear removes a specific session without affecting others", () => {
	snapshot.clearAll();
	snapshot.put("a", snap("a-id"));
	snapshot.put("b", snap("b-id"));
	snapshot.clear("a");
	assert.equal(snapshot.size(), 1);
	assert.equal(snapshot.take("b")?.firstKeptEntryId, "b-id");
});

test("clearAll empties the map", () => {
	snapshot.clearAll();
	snapshot.put("a", snap("x"));
	snapshot.put("b", snap("y"));
	snapshot.clearAll();
	assert.equal(snapshot.size(), 0);
});
