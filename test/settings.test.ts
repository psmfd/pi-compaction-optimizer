/**
 * Settings layer tests — project-layer allowlist boundary.
 *
 * Acceptance criteria covered (PR1, #208):
 *   - Project layer can override `mode`, `hybrid.*`, `fileTracker.*`, `archive.enabled`.
 *   - Project layer is rejected with a notify warning for `archive.path`,
 *     `archive.ephemeralBehavior`, `archive.redactPatterns`.
 *   - User layer accepts absolute and `~`-rooted `archive.path`.
 *   - Defaults materialize when both layers are silent.
 *   - Malformed JSON in either layer degrades to defaults without throwing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { loadSettings, DEFAULTS } from "../lib/settings.ts";
import { captureNotify, makeTmp, rmTmp, writeFile } from "./helpers.ts";

async function setupLayers(opts: {
	user?: unknown;
	project?: unknown;
}): Promise<{ cwd: string; userPath: string; cleanup: () => Promise<void> }> {
	const root = await makeTmp("compopt-settings-");
	const userPath = join(root, "user-settings.json");
	const projectDir = join(root, "proj");
	await fs.mkdir(join(projectDir, ".pi"), { recursive: true });
	if (opts.user !== undefined) {
		await writeFile(userPath, JSON.stringify(opts.user, null, 2));
	}
	if (opts.project !== undefined) {
		await writeFile(join(projectDir, ".pi/settings.json"), JSON.stringify(opts.project, null, 2));
	}
	return {
		cwd: projectDir,
		userPath,
		cleanup: () => rmTmp(root),
	};
}

test("defaults materialize when both layers are silent", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.mode, "hybrid");
		assert.equal(out.fileTracker.maxReadFiles, 50);
		assert.equal(out.archive.enabled, true);
		assert.equal(out.archive.ephemeralBehavior, "skip");
		assert.deepEqual(out.archive.redactPatterns, []);
	} finally {
		await cleanup();
	}
});

test("defaults expose measured hybrid thresholds (#244, ADR-0107)", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.hybrid.maxMessages, 500);
		assert.equal(out.hybrid.maxTokens, 200_000);
		assert.equal(out.hybrid.maxTokensFraction, 1.0);
		assert.equal(out.hybrid.minToolCallRatio, 0.3);
		assert.equal(out.hybrid.maxOrphanAssistantTokens, 30_000);
	} finally {
		await cleanup();
	}
});

test("defaults expose timing.* off-by-default when-policy (#677, ADR-0109)", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.timing.enabled, false);
		assert.deepEqual(out.timing.providers, ["omlx"]);
		assert.equal(out.timing.deferCeilingFraction, 0.9);
		assert.equal(out.timing.proactiveAtFraction, 0.75);
		assert.equal(out.timing.maxDeferrals, 10);
		assert.equal(out.timing.boundaryWindowTurns, 1);
	} finally {
		await cleanup();
	}
});

test("user layer may enable timing.*; project layer is rejected wholesale (ADR-0109)", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		user: {
			extensionSettings: {
				compactionOptimizer: { timing: { enabled: true, maxDeferrals: 3 } },
			},
		},
		project: {
			extensionSettings: {
				compactionOptimizer: { timing: { enabled: false, providers: ["evil"] } },
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.timing.enabled, true, "user layer wins; project rejected");
		assert.equal(out.timing.maxDeferrals, 3);
		assert.deepEqual(out.timing.providers, ["omlx"], "project providers rejected");
		const warnings = cap.calls.filter((c) => c.type === "warning");
		assert.ok(
			warnings.some((c) => c.message.includes("timing.enabled")),
			`expected reject notify for timing.enabled; got ${JSON.stringify(warnings)}`,
		);
		assert.ok(warnings.some((c) => c.message.includes("timing.providers")));
	} finally {
		await cleanup();
	}
});

test("DEFAULT_PREVIOUS_SUMMARY_MAX_CHARS stays in sync with DEFAULTS (#253, #781)", async () => {
	const { DEFAULT_PREVIOUS_SUMMARY_MAX_CHARS } = await import("../lib/deterministic-summary.ts");
	assert.equal(DEFAULT_PREVIOUS_SUMMARY_MAX_CHARS, DEFAULTS.hybrid.previousSummaryMaxChars);
});

test("project-layer wrong-typed values for allowlisted keys are dropped with notify (#781)", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					mode: "hybird",
					hybrid: { maxTokens: "not-a-number" },
					archive: { enabled: "false" },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.hybrid.maxTokens, 200_000, "string maxTokens must not reach the merge");
		assert.equal(out.archive.enabled, true, "string 'false' must not reach archive.enabled");
		assert.equal(out.mode, "hybrid", "typo'd project mode must be dropped");
		const warnings = cap.calls.filter((c) => c.type === "warning");
		assert.ok(warnings.some((c) => c.message.includes("hybrid.maxTokens") && c.message.includes("wrong value type")));
		assert.ok(warnings.some((c) => c.message.includes("archive.enabled") && c.message.includes("wrong value type")));
		assert.ok(warnings.some((c) => c.message.includes("mode") && c.message.includes("wrong value type")));
	} finally {
		await cleanup();
	}
});

test("user-layer unknown mode falls back to default with notify (#781)", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		user: {
			extensionSettings: { compactionOptimizer: { mode: "hybird" } },
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.mode, "hybrid");
		assert.ok(
			cap.calls.some((c) => c.type === "warning" && /unknown mode 'hybird'/.test(c.message)),
			`expected unknown-mode notify; got ${JSON.stringify(cap.calls)}`,
		);
	} finally {
		await cleanup();
	}
});

test("defaults expose hybrid.maxOutputTokens=8000 (#254, ADR-0108)", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.hybrid.maxOutputTokens, 8_000);
	} finally {
		await cleanup();
	}
});

test("project layer can set hybrid.maxOutputTokens; clamped to [2000, 100000] (ADR-0108)", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					hybrid: { maxOutputTokens: 1 },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.hybrid.maxOutputTokens, 2_000);
		const warnings = cap.calls.filter((c) => c.type === "warning");
		assert.ok(
			warnings.some(
				(c) => c.message.includes("hybrid.maxOutputTokens") && c.message.includes("clamped"),
			),
			`expected clamp notify for hybrid.maxOutputTokens; got ${JSON.stringify(warnings)}`,
		);
	} finally {
		await cleanup();
	}
});

test("project layer can set hybrid.maxTokensFraction; clamped to [0, 5] (ADR-0107)", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					hybrid: { maxTokensFraction: 99 },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.hybrid.maxTokensFraction, 5);
		const warnings = cap.calls.filter((c) => c.type === "warning");
		assert.ok(
			warnings.some(
				(c) => c.message.includes("hybrid.maxTokensFraction") && c.message.includes("clamped"),
			),
			`expected clamp notify for hybrid.maxTokensFraction; got ${JSON.stringify(warnings)}`,
		);
	} finally {
		await cleanup();
	}
});

test("user layer accepts absolute archive.path", async () => {
	const abs = "/var/tmp/some-archive";
	const { cwd, userPath, cleanup } = await setupLayers({
		user: { extensionSettings: { compactionOptimizer: { archive: { path: abs } } } },
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.archive.path, abs);
	} finally {
		await cleanup();
	}
});

test("user layer expands ~-rooted archive.path", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({
		user: { extensionSettings: { compactionOptimizer: { archive: { path: "~/custom-archive" } } } },
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.archive.path, join(homedir(), "custom-archive"));
	} finally {
		await cleanup();
	}
});

test("project layer overrides allowlisted keys", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					mode: "hybrid",
					hybrid: { maxMessages: 12 },
					fileTracker: { maxReadFiles: 7 },
					archive: { enabled: false },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.mode, "hybrid");
		assert.equal(out.hybrid.maxMessages, 12);
		assert.equal(out.fileTracker.maxReadFiles, 7);
		assert.equal(out.archive.enabled, false);
	} finally {
		await cleanup();
	}
});

test("project layer clamps hybrid.* values out of safe range with notify", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					hybrid: {
						maxMessages: 999999,
						minToolCallRatio: -0.5,
						maxOrphanAssistantTokens: -10,
						maxTokens: 50000,
						previousSummaryMaxChars: 999999, // exceeds 100_000 max
					},
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.hybrid.maxMessages, 2000);
		assert.equal(out.hybrid.minToolCallRatio, 0);
		assert.equal(out.hybrid.maxOrphanAssistantTokens, 0);
		assert.equal(out.hybrid.maxTokens, 50000);
		assert.equal(out.hybrid.previousSummaryMaxChars, 100000);
		const warnings = cap.calls.filter((c) => c.type === "warning");
		assert.ok(
			warnings.some((c) => c.message.includes("hybrid.maxMessages") && c.message.includes("clamped")),
			`expected clamp notify for hybrid.maxMessages; got ${JSON.stringify(warnings)}`,
		);
		assert.ok(
			warnings.some((c) => c.message.includes("hybrid.minToolCallRatio")),
			"expected clamp notify for hybrid.minToolCallRatio",
		);
		assert.ok(
			warnings.some((c) => c.message.includes("hybrid.previousSummaryMaxChars")),
			"expected clamp notify for hybrid.previousSummaryMaxChars (#253)",
		);
	} finally {
		await cleanup();
	}
});

// #253 — verify the new setting is wired through default + allowlist.
test("defaults expose hybrid.previousSummaryMaxChars=500 (#253)", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.hybrid.previousSummaryMaxChars, 500);
	} finally {
		await cleanup();
	}
});

test("project layer allows hybrid.previousSummaryMaxChars=0 (drop section) (#253)", async () => {
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					hybrid: { previousSummaryMaxChars: 0 },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath });
		assert.equal(out.hybrid.previousSummaryMaxChars, 0);
	} finally {
		await cleanup();
	}
});

test("project layer rejects fileTracker.dropPatterns (ReDoS surface)", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					fileTracker: { dropPatterns: ["(a+)+$"] },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.deepEqual(out.fileTracker.dropPatterns, []);
		assert.ok(
			cap.calls.some((c) => c.message.includes("fileTracker.dropPatterns")),
			"expected warning naming fileTracker.dropPatterns",
		);
	} finally {
		await cleanup();
	}
});

test("deepMerge refuses __proto__ pollution attempts (raw-JSON own-property)", async () => {
	const root = await makeTmp("compopt-settings-proto-");
	const userPath = join(root, "user.json");
	const projectDir = join(root, "proj");
	await fs.mkdir(join(projectDir, ".pi"), { recursive: true });
	// Hand-crafted JSON: `__proto__` here is an OWN property (JS object-literal
	// `__proto__:` would set the prototype and JSON.stringify drops it; we want
	// the on-disk byte sequence to contain the literal `__proto__` key).
	await writeFile(
		userPath,
		'{"extensionSettings":{"compactionOptimizer":{"__proto__":{"polluted":true},"hybrid":{"__proto__":{"alsoPolluted":true}}}}}',
	);
	try {
		await loadSettings({ cwd: projectDir, userSettingsPath: userPath });
		const probe: Record<string, unknown> = {};
		assert.equal(
			(probe as { polluted?: boolean }).polluted,
			undefined,
			"Object.prototype was polluted via __proto__ at top level",
		);
		assert.equal(
			(probe as { alsoPolluted?: boolean }).alsoPolluted,
			undefined,
			"Object.prototype was polluted via nested __proto__",
		);
	} finally {
		await rmTmp(root);
	}
});

test("malformed JSON degrades to defaults and emits a notify warning", async () => {
	const cap = captureNotify();
	const root = await makeTmp("compopt-settings-bad-");
	const userPath = join(root, "user.json");
	const projectDir = join(root, "proj");
	await fs.mkdir(join(projectDir, ".pi"), { recursive: true });
	await writeFile(userPath, "{ not valid json");
	await writeFile(join(projectDir, ".pi/settings.json"), "}}}");
	try {
		const out = await loadSettings({
			cwd: projectDir,
			userSettingsPath: userPath,
			notify: cap.notify,
		});
		assert.equal(out.mode, "hybrid");
		assert.ok(
			cap.calls.some((c) => c.type === "warning" && /malformed/.test(c.message)),
			`expected a malformed-settings warning; got ${JSON.stringify(cap.calls)}`,
		);
	} finally {
		await rmTmp(root);
	}
});

test("project layer rejects archive.path with notify warning", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					archive: { path: "/Users/victim/.ssh/authorized_keys" },
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		// archive.path falls back to default — not the malicious value.
		assert.notEqual(out.archive.path, "/Users/victim/.ssh/authorized_keys");
		assert.equal(out.archive.path, DEFAULTS.archive.path.replace("~", homedir()));
		const warned = cap.calls.find(
			(c) => c.message.includes("archive.path") && c.type === "warning",
		);
		assert.ok(warned, `expected a warning naming archive.path; got: ${JSON.stringify(cap.calls)}`);
	} finally {
		await cleanup();
	}
});

test("project layer rejects archive.ephemeralBehavior and archive.redactPatterns", async () => {
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					archive: {
						ephemeralBehavior: "tmp",
						redactPatterns: ["evil-pattern"],
					},
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.archive.ephemeralBehavior, "skip");
		assert.deepEqual(out.archive.redactPatterns, []);
		const eph = cap.calls.find((c) => c.message.includes("archive.ephemeralBehavior"));
		const red = cap.calls.find((c) => c.message.includes("archive.redactPatterns"));
		assert.ok(eph, "expected warning for archive.ephemeralBehavior");
		assert.ok(red, "expected warning for archive.redactPatterns");
	} finally {
		await cleanup();
	}
});

test("project layer cannot escalate via deep allowlisted parent (archive.* still rejects)", async () => {
	// Sanity: even though `archive.enabled` is allowlisted, sibling keys are not.
	const cap = captureNotify();
	const { cwd, userPath, cleanup } = await setupLayers({
		project: {
			extensionSettings: {
				compactionOptimizer: {
					archive: {
						enabled: false,
						path: "/etc/passwd",
					},
				},
			},
		},
	});
	try {
		const out = await loadSettings({ cwd, userSettingsPath: userPath, notify: cap.notify });
		assert.equal(out.archive.enabled, false); // allowlisted key applied
		assert.notEqual(out.archive.path, "/etc/passwd"); // sibling rejected
		assert.ok(cap.calls.some((c) => c.message.includes("archive.path")));
	} finally {
		await cleanup();
	}
});

test("malformed JSON in either layer degrades to defaults (no-notify smoke)", async () => {
	const root = await makeTmp("compopt-settings-bad2-");
	const userPath = join(root, "user.json");
	const projectDir = join(root, "proj");
	await fs.mkdir(join(projectDir, ".pi"), { recursive: true });
	await writeFile(userPath, "{ not valid json");
	await writeFile(join(projectDir, ".pi/settings.json"), "}}}");
	try {
		const out = await loadSettings({ cwd: projectDir, userSettingsPath: userPath });
		assert.equal(out.mode, "hybrid");
	} finally {
		await rmTmp(root);
	}
});
