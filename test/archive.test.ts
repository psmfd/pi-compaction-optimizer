/**
 * Archive writer tests.
 *
 * Acceptance criteria covered (PR1, #208):
 *   - Per-session directory mode 0o700.
 *   - Archive file mode 0o600.
 *   - Symlink components refused: ancestor symlink redirecting outside root.
 *   - Pre-existing target refused.
 *   - Atomic write semantics (no leftover tempfile on success).
 *   - archive.enabled=false skips writes.
 *   - Failure log emitted on refusal cases.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { writeArchive } from "../lib/archive.ts";
import { DEFAULTS, type CompactionOptimizerSettings } from "../lib/settings.ts";
import { captureNotify, makeTmp, rmTmp, stat } from "./helpers.ts";

function settingsWith(overrides: Partial<CompactionOptimizerSettings["archive"]>): CompactionOptimizerSettings {
	return {
		...DEFAULTS,
		archive: { ...DEFAULTS.archive, ...overrides },
	};
}

/**
 * Per-test failure-log path under the test's tmp root. Required to prevent
 * `recordFailureBare()` from writing into the operator's `$HOME/.pi/...`
 * (regression guard for #236).
 */
function failureLogIn(root: string): string {
	return join(root, "failure.log");
}

function mkSnapshot() {
	return {
		messagesToSummarize: [{ role: "user", content: "hello" } as never],
		turnPrefixMessages: [],
		isSplitTurn: false,
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		capturedAt: new Date().toISOString(),
	};
}

test("happy path writes archive with 0o700 dir and 0o600 file", async () => {
	const root = await makeTmp("compopt-arch-");
	try {
		const res = await writeArchive({
			sessionId: "sess-1",
			isPersisted: true,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root }),
			failureLogPath: failureLogIn(root),
		});
		assert.equal(res.status, "ok");
		assert.ok(res.path);
		const dirStat = await stat(join(root, "sess-1"));
		assert.equal(dirStat.mode, 0o700);
		const fileStat = await stat(res.path);
		assert.equal(fileStat.mode, 0o600);
		// No leftover tempfile.
		const entries = await fs.readdir(join(root, "sess-1"));
		const tmpLeftover = entries.find((e) => e.includes(".tmp-"));
		assert.equal(tmpLeftover, undefined);
	} finally {
		await rmTmp(root);
	}
});

test("archive.enabled=false skips write", async () => {
	const root = await makeTmp("compopt-arch-disabled-");
	try {
		const res = await writeArchive({
			sessionId: "sess-x",
			isPersisted: true,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root, enabled: false }),
			failureLogPath: failureLogIn(root),
		});
		assert.equal(res.status, "skipped");
		const entries = await fs.readdir(root).catch(() => []);
		assert.equal(entries.length, 0);
	} finally {
		await rmTmp(root);
	}
});

test("symlink ancestor refusal: per-session dir is a symlink to outside root", async () => {
	const root = await makeTmp("compopt-arch-symlink-");
	const elsewhere = await makeTmp("compopt-arch-target-");
	const cap = captureNotify();
	// Capture pre-test mode of `elsewhere` so we can assert no mode tampering.
	const preMode = (await stat(elsewhere)).mode;
	try {
		// Pre-plant: <root>/sess-evil -> <elsewhere>
		await fs.symlink(elsewhere, join(root, "sess-evil"));
		const res = await writeArchive({
			sessionId: "sess-evil",
			isPersisted: true,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root }),
			notify: cap.notify,
			failureLogPath: failureLogIn(root),
		});
		assert.equal(res.status, "failed");
		// Nothing should have been written into <elsewhere>.
		const leak = await fs.readdir(elsewhere);
		assert.equal(leak.length, 0);
		// And mode of `elsewhere` must be unchanged (no chmod-through-symlink).
		const postMode = (await stat(elsewhere)).mode;
		assert.equal(postMode, preMode, "mode of pre-planted symlink target was tampered");
		assert.ok(
			cap.calls.some((c) => /symlink/i.test(c.message)),
			`expected a notify mentioning symlink; got ${JSON.stringify(cap.calls)}`,
		);
	} finally {
		await rmTmp(root);
		await rmTmp(elsewhere);
	}
});

test("O_NOFOLLOW leaf refusal (#227): pre-planted tempfile-path symlink → ELOOP, no exfiltration", async () => {
	const root = await makeTmp("compopt-arch-leaf-tmp-");
	const sink = await makeTmp("compopt-arch-leaf-tmp-sink-");
	const cap = captureNotify();
	try {
		const sessionDir = join(root, "sess-leaf-tmp");
		await fs.mkdir(sessionDir, { mode: 0o700 });

		// Predict the writer's tempfile path by injecting deterministic clock
		// + entropy seams. With those overrides:
		//   timestamp = "2026-01-01T00-00-00-000"
		//   targetName = "2026-01-01T00-00-00-000.md"
		//   tmpName    = ".2026-01-01T00-00-00-000.md.tmp-" + "00".repeat(8)
		const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");
		const fixedEntropy = (_n: number) => Buffer.alloc(8, 0); // 16-char hex of zeros
		const timestamp = "2026-01-01T00-00-00-000";
		const tmpPath = join(sessionDir, `.${timestamp}.md.tmp-${"00".repeat(8)}`);

		// Pre-plant the symlink at the predicted tempfile path. The writer
		// opens with `O_CREAT | O_EXCL | O_NOFOLLOW`. POSIX evaluates O_EXCL
		// BEFORE O_NOFOLLOW when the path already exists, so on a pre-planted
		// leaf symlink the kernel returns EEXIST (→ reason: tempfile-collision)
		// rather than ELOOP. Either errno satisfies the no-follow contract:
		// the open fails, no fd is returned, no traversal occurs. Acceptance
		// (#227) is met by asserting the refusal + no-exfiltration, not a
		// specific errno. The O_NOFOLLOW path-component guard (ELOOP) is
		// covered by the ancestor-symlink test above. (If O_EXCL were ever
		// removed, this same fixture would surface ELOOP via O_NOFOLLOW.)
		await fs.symlink(join(sink, "captured.md"), tmpPath);

		const res = await writeArchive({
			sessionId: "sess-leaf-tmp",
			isPersisted: true,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root }),
			notify: cap.notify,
			failureLogPath: failureLogIn(root),
			now: fixedNow,
			randomBytes: fixedEntropy,
		});

		assert.equal(res.status, "failed", `expected failed status; got ${JSON.stringify(res)}`);
		// Accept either of the two refusal reasons — see the comment above on
		// POSIX O_EXCL/O_NOFOLLOW ordering.
		assert.ok(
			res.reason === "symlink-refused" || res.reason === "tempfile-collision",
			`expected reason in {symlink-refused, tempfile-collision}; got ${res.reason}`,
		);

		// No exfiltration: sink dir must still be empty (decoy never traversed).
		const leaked = await fs.readdir(sink);
		assert.equal(leaked.length, 0, `sink leaked entries: ${JSON.stringify(leaked)}`);

		// Note: the writer's catch block calls `fs.unlink(tmpPath)` to clean up
		// what it perceives as a stale tempfile. That removes our pre-planted
		// symlink — which is correct behavior (the catch-path treats any
		// failed-open name as collateral). The proof of no-follow is the
		// sink-empty check above plus the EEXIST/ELOOP errno in the log: a
		// followed open would have created `captured.md` in the sink before
		// the unlink (which targets `tmpPath`, not the symlink's destination).

		// Failure log must record one of the refusal errnos.
		const log = await fs.readFile(failureLogIn(root), "utf-8");
		assert.match(log, /ELOOP|EEXIST/, `failure log should record ELOOP or EEXIST; got:\n${log}`);
	} finally {
		await rmTmp(root);
		await rmTmp(sink);
	}
});

test("O_NOFOLLOW leaf refusal (#227): pre-planted target symlink → fs.link EEXIST, no exfiltration", async () => {
	// Acceptance #2: the final-target symlink case. `fs.link(2)` operates on
	// the symlink name itself (does not follow), so the existing pre-planted
	// symlink at `target` causes `fs.link(tmpPath, target)` to fail with
	// EEXIST — mapped by the writer to reason: "target-exists". The symlink
	// target (sink file) is never opened for write.
	const root = await makeTmp("compopt-arch-leaf-tgt-");
	const sink = await makeTmp("compopt-arch-leaf-tgt-sink-");
	const cap = captureNotify();
	try {
		const sessionDir = join(root, "sess-leaf-tgt");
		await fs.mkdir(sessionDir, { mode: 0o700 });

		const fixedNow = () => new Date("2026-02-02T00:00:00.000Z");
		const timestamp = "2026-02-02T00-00-00-000";
		const target = join(sessionDir, `${timestamp}.md`);

		// Pre-plant a *dangling* symlink at the target path. The pre-existing
		// fs.access(F_OK) check follows symlinks; on a dangling symlink it
		// returns ENOENT, so the access check passes ("fresh") — but then
		// fs.link(tmpPath, target) hits EEXIST because the symlink name
		// itself exists. Either way, no write to the sink occurs.
		await fs.symlink(join(sink, "never-created.md"), target);

		const res = await writeArchive({
			sessionId: "sess-leaf-tgt",
			isPersisted: true,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root }),
			notify: cap.notify,
			failureLogPath: failureLogIn(root),
			now: fixedNow,
		});

		assert.equal(res.status, "failed", `expected failed status; got ${JSON.stringify(res)}`);
		assert.equal(res.reason, "target-exists", `expected reason=target-exists; got ${res.reason}`);

		// No exfiltration: the symlink's target file must not have been created.
		const leaked = await fs.readdir(sink);
		assert.equal(leaked.length, 0, `sink leaked entries: ${JSON.stringify(leaked)}`);

		// The pre-planted symlink must still be a symlink (unchanged).
		const lst = await fs.lstat(target);
		assert.ok(lst.isSymbolicLink(), "pre-planted target must remain a symlink");

		// Per the contract, no tempfile should be left behind in the session dir.
		const remaining = await fs.readdir(sessionDir);
		assert.deepEqual(
			remaining.filter((n) => n.startsWith(".")),
			[],
			`expected no leftover tempfile; got ${JSON.stringify(remaining)}`,
		);
	} finally {
		await rmTmp(root);
		await rmTmp(sink);
	}
});

test("ephemeral session with skip (default) writes nothing", async () => {
	const root = await makeTmp("compopt-arch-eph-");
	try {
		const res = await writeArchive({
			sessionId: "eph-1",
			isPersisted: false,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root, ephemeralBehavior: "skip" }),
			failureLogPath: failureLogIn(root),
		});
		assert.equal(res.status, "skipped");
		const entries = await fs.readdir(root).catch(() => []);
		assert.equal(entries.length, 0);
	} finally {
		await rmTmp(root);
	}
});

test("ephemeral session with tmp writes under $TMPDIR (mode 0o700)", async () => {
	const res = await writeArchive({
		sessionId: "eph-tmp",
		isPersisted: false,
		snapshot: mkSnapshot(),
		settings: settingsWith({ ephemeralBehavior: "tmp" }),
		failureLogPath: join((await makeTmp("compopt-arch-eph-tmp-log-")), "failure.log"),
	});
	assert.equal(res.status, "ok");
	assert.ok(res.path);
	const fileStat = await stat(res.path);
	assert.equal(fileStat.mode, 0o600);
	// Best-effort cleanup.
	try {
		await fs.rm(res.path);
	} catch {
		/* ignore */
	}
});

test("regression #236: failure path honors failureLogPath override and does not touch $HOME", async () => {
	const root = await makeTmp("compopt-arch-236-");
	const elsewhere = await makeTmp("compopt-arch-236-target-");
	const fakeHome = await makeTmp("compopt-arch-236-fakehome-");
	const logPath = join(root, "failure.log");
	const cap = captureNotify();
	const originalHome = process.env.HOME;
	const originalUserprofile = process.env.USERPROFILE;
	try {
		// Repoint HOME so any accidental homedir()-rooted write lands in fakeHome
		// (where we can assert nothing was created), not in the operator's real $HOME.
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		// Pre-plant a symlink to trigger the same failure path that leaked the
		// committed log in #236 (`sess-evil` ancestor-symlink redirect).
		await fs.symlink(elsewhere, join(root, "sess-evil"));
		const res = await writeArchive({
			sessionId: "sess-evil",
			isPersisted: true,
			snapshot: mkSnapshot(),
			settings: settingsWith({ path: root }),
			notify: cap.notify,
			failureLogPath: logPath,
		});
		assert.equal(res.status, "failed");
		// Override path received the failure record …
		const logged = await fs.readFile(logPath, "utf-8");
		assert.ok(logged.includes("sess-evil"), "override log should contain the failure record");
		// … and nothing was created under the (fake) operator HOME.
		const homeEntries = await fs.readdir(fakeHome);
		assert.deepEqual(homeEntries, [], `fake $HOME must be untouched; found: ${JSON.stringify(homeEntries)}`);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserprofile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserprofile;
		await rmTmp(root);
		await rmTmp(elsewhere);
		await rmTmp(fakeHome);
	}
});

test("redactPatterns replaces matched substrings", async () => {
	const root = await makeTmp("compopt-arch-redact-");
	try {
		const res = await writeArchive({
			sessionId: "sess-redact",
			isPersisted: true,
			snapshot: {
				...mkSnapshot(),
				messagesToSummarize: [
					{ role: "assistant", content: "SECRET_TOKEN=abcd1234" } as never,
				],
			},
			settings: settingsWith({ path: root, redactPatterns: ["SECRET_TOKEN=[a-z0-9]+"] }),
			failureLogPath: failureLogIn(root),
		});
		assert.equal(res.status, "ok");
		const written = await fs.readFile(res.path as string, "utf-8");
		assert.ok(!written.includes("SECRET_TOKEN=abcd1234"), "raw secret should be replaced");
		assert.ok(written.includes("[REDACTED]"), "redaction marker should appear");
	} finally {
		await rmTmp(root);
	}
});
