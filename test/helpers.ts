/**
 * Shared test helpers for the compaction-optimizer test suite.
 *
 * No framework: tests run under `node --import tsx --test` and use the
 * built-in `node:test` runner + `node:assert/strict`. The wrapper script
 * `scripts/test-compaction-optimizer.sh` orchestrates execution.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmp(prefix = "compopt-test-"): Promise<string> {
	return await fs.mkdtemp(join(tmpdir(), prefix));
}

export async function rmTmp(path: string): Promise<void> {
	await fs.rm(path, { recursive: true, force: true });
}

export async function writeFile(path: string, content: string): Promise<void> {
	await fs.writeFile(path, content, "utf-8");
}

export async function stat(path: string): Promise<{ mode: number; isFile: boolean; isDir: boolean }> {
	const s = await fs.stat(path);
	return {
		mode: s.mode & 0o777,
		isFile: s.isFile(),
		isDir: s.isDirectory(),
	};
}

export function captureNotify(): {
	notify: (m: string, t?: "info" | "warning" | "error") => void;
	calls: Array<{ message: string; type?: string }>;
} {
	const calls: Array<{ message: string; type?: string }> = [];
	return {
		calls,
		notify(message, type) {
			calls.push({ message, type });
		},
	};
}
