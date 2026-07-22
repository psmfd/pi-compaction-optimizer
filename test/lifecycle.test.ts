/**
 * Lifecycle integration coverage the fake-pi harness previously never
 * exercised (#783, from the #781 review): the `agent_settled` proactive
 * trigger — including the armSelfCompact ordering hazard (the self-flag
 * must NOT arm when ctx.compact is absent, or the next unrelated fire
 * skips the veto) — and `session_shutdown` state clearing.
 *
 * timing.* is USER-LAYER ONLY, so settings are written under a temp $HOME
 * (POSIX os.homedir() honors it), the same pattern events.test.ts uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../index.ts";
import * as phaseState from "../shared/phase-state.ts";

interface FakePi {
	handlers: Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>;
	on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void;
	fire: (name: string, event: unknown, ctx: unknown) => Promise<unknown[]>;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
	return {
		handlers,
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		async fire(name, event, ctx) {
			const list = handlers.get(name) ?? [];
			const out: unknown[] = [];
			for (const h of list) out.push(await h(event, ctx));
			return out;
		},
	};
}

/** Run `fn` with $HOME pointed at a temp dir carrying user-layer settings. */
async function withUserSettings<T>(
	settings: Record<string, unknown>,
	fn: (cwd: string) => Promise<T>,
): Promise<T> {
	const home = await fs.mkdtemp(join(tmpdir(), "compopt-lifecycle-home-"));
	const cwd = await fs.mkdtemp(join(tmpdir(), "compopt-lifecycle-cwd-"));
	await fs.mkdir(join(home, ".pi", "agent"), { recursive: true });
	await fs.writeFile(
		join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({ extensionSettings: { compactionOptimizer: settings } }),
	);
	const prevHome = process.env.HOME;
	process.env.HOME = home;
	try {
		return await fn(cwd);
	} finally {
		process.env.HOME = prevHome;
		await fs.rm(home, { recursive: true, force: true });
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

function makeCtx(
	cwd: string,
	sessionId: string,
	opts: { compact?: (o: { onError: () => void }) => void } = {},
): unknown {
	return {
		cwd,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => false },
		model: { provider: "omlx", contextWindow: 100_000, id: "omlx/test" },
		getContextUsage: () => ({ tokens: 90_000 }),
		signal: undefined,
		...(opts.compact ? { compact: opts.compact } : {}),
	};
}

/** Fresh-boundary phase state: task type changed this turn, no fan-out. */
function armBoundary(sessionId: string): void {
	phaseState.noteTurnEnd(sessionId, 5);
	phaseState.publishTaskType(sessionId, "code-edit");
}

const TIMING_ON = { timing: { enabled: true } };

test("agent_settled: proactive boundary compaction fires ctx.compact and arms the self-flag", async () => {
	const sid = "lifecycle-fire";
	await withUserSettings(TIMING_ON, async (cwd) => {
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			armBoundary(sid);
			const compactCalls: Array<{ onError: () => void }> = [];
			const ctx = makeCtx(cwd, sid, { compact: (o) => compactCalls.push(o) });
			await pi.fire("agent_settled", {}, ctx);
			assert.equal(compactCalls.length, 1, "ctx.compact invoked once");
			assert.equal(phaseState.consumeSelfCompact(sid), true, "self-flag armed before compact()");
			// The onError callback disarms — re-arm and exercise it.
			phaseState.armSelfCompact(sid);
			compactCalls[0].onError();
			assert.equal(phaseState.consumeSelfCompact(sid), false, "onError disarms the flag");
		} finally {
			phaseState.clearSession(sid);
		}
	});
});

test("agent_settled: no callable ctx.compact means the self-flag is NEVER armed (#781 ordering hazard)", async () => {
	const sid = "lifecycle-no-compact";
	await withUserSettings(TIMING_ON, async (cwd) => {
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			armBoundary(sid);
			await pi.fire("agent_settled", {}, makeCtx(cwd, sid));
			// An armed-but-unconsumed flag would silently skip the veto on the
			// next unrelated compaction fire — the exact hazard the #781 review
			// fixed by checking compact() callability BEFORE arming.
			assert.equal(phaseState.consumeSelfCompact(sid), false, "flag not armed without compact()");
		} finally {
			phaseState.clearSession(sid);
		}
	});
});

test("agent_settled: disabled timing never fires even at a perfect boundary", async () => {
	const sid = "lifecycle-disabled";
	await withUserSettings({ timing: { enabled: false } }, async (cwd) => {
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			armBoundary(sid);
			const compactCalls: unknown[] = [];
			await pi.fire("agent_settled", {}, makeCtx(cwd, sid, { compact: (o) => compactCalls.push(o) }));
			assert.equal(compactCalls.length, 0);
			assert.equal(phaseState.consumeSelfCompact(sid), false);
		} finally {
			phaseState.clearSession(sid);
		}
	});
});

test("session_shutdown: clears phase state (self-flag, deferrals) for the session", async () => {
	const sid = "lifecycle-shutdown";
	await withUserSettings(TIMING_ON, async (cwd) => {
		try {
			const pi = makeFakePi();
			await factory(pi as never);
			phaseState.armSelfCompact(sid);
			phaseState.noteDeferral(sid);
			phaseState.noteDeferral(sid);
			assert.equal(phaseState.deferralCount(sid), 2);
			await pi.fire("session_shutdown", {}, makeCtx(cwd, sid));
			assert.equal(phaseState.deferralCount(sid), 0, "deferral counter dropped");
			assert.equal(phaseState.consumeSelfCompact(sid), false, "self-flag dropped");
		} finally {
			phaseState.clearSession(sid);
		}
	});
});
