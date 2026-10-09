// SPDX-License-Identifier: Apache-2.0
/**
 * The heavy-run lock's deciding logic, and the shell wrapper that holds it.
 *
 * What the lock is and why it exists is `scripts/heavy-run.ts`'s docblock. Here the tests
 * pin the classification (full vs scoped is the whole of the lock's fairness), the shell
 * wrapper's actual waiting behavior against a live holder, and the env var that keeps the
 * full `bun test` inside a held lane from deadlocking on its own parent's lock.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HELD_ENV,
	holdUnitTestLock,
	isFullUnitTestRun,
	LOCK_DEFAULT,
	lockPath,
} from "./heavy-run.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const WRAPPER = join(REPO_ROOT, "scripts", "heavy-run.sh");

const argv = (...args: string[]) => ["bun", "test", ...args];

/** Blocks until a lock file is actually held by another process (probes on a fresh fd). */
function waitForHolder(path: string): void {
	for (let i = 0; i < 100; i++) {
		const probe = Bun.spawnSync(
			["sh", "-c", `exec 8>>"${path}"; if flock -x -n 8; then exit 10; fi; exit 1`],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		// Exit 10 = the probe got the lock, so the lane is still free; 1 = held.
		if (probe.exitCode === 1) return;
		Bun.sleepSync(20);
	}
	throw new Error("the test holder never acquired the lock");
}

describe("isFullUnitTestRun", () => {
	it("a bare bun test is full", () => {
		expect(isFullUnitTestRun(argv())).toBe(true);
	});

	it("flags only are still a full run", () => {
		expect(isFullUnitTestRun(argv("--only-failures"))).toBe(true);
		expect(isFullUnitTestRun(argv("--only-failures", "--silent"))).toBe(true);
	});

	it("a run that names a test file is scoped, and scoped runs stay cheap", () => {
		expect(isFullUnitTestRun(argv("apps/api/src/__tests__/account-fixture.test.ts"))).toBe(false);
		expect(isFullUnitTestRun(argv("apps/api"))).toBe(false);
	});

	it("a name pattern is read as scoped too (it executes matching tests only)", () => {
		expect(isFullUnitTestRun(argv("-t", "the name"))).toBe(false);
	});

	it("another bun command is never this lock's business", () => {
		expect(isFullUnitTestRun([])).toBe(false);
		expect(isFullUnitTestRun(["bun", "run", "verify"])).toBe(false);
	});
});

describe("lockPath", () => {
	it("answers the shared default when nothing overrides it", () => {
		// Same default as heavy-run.sh names; the Makefile plumbing test in
		// verify-stamp.test.ts asserts the two files agree.
		expect(LOCK_DEFAULT).toContain(join(".cache", "anthers"));
		expect(LOCK_DEFAULT).toContain("heavy-run.lock");
	});

	it("answers the env override, which is how tests isolate lock state", () => {
		expect(lockPath()).toBe(process.env.ANTHERS_HEAVY_RUN_LOCK ?? LOCK_DEFAULT);
	});
});

describe("heavy-run.sh", () => {
	let dir: string;
	let lock: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "heavy-run-sh-"));
		lock = join(dir, "heavy-run.lock");
		writeFileSync(lock, "");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function run(
		target: string,
		extraEnv: Record<string, string> = {},
	): { exitCode: number; stderr: string; env: string } {
		const envLog = join(dir, "env.log");
		const res = Bun.spawnSync(
			[
				"sh",
				WRAPPER,
				"sh",
				"-c",
				// The env report comes last, after the target, so an `exit` inside it cannot
				// hide the answer; the rc travels with it.
				`${target}\nrc=$?\nprintf '%s' "\${ANTHERS_HEAVY_RUN_HELD-unset}" > "${envLog}"\nexit "$rc"`,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ANTHERS_HEAVY_RUN_LOCK: lock, ...extraEnv },
			},
		);
		const readEnv = Bun.spawnSync(["cat", envLog]);
		return {
			exitCode: res.exitCode ?? -1,
			stderr: res.stderr.toString(),
			env: readEnv.stdout.toString().trim(),
		};
	}

	it("runs immediately when the lane is free", () => {
		const res = run("sleep 0.05");
		expect(res.exitCode).toBe(0);
		expect(res.stderr).not.toContain("waiting");
	});

	it("waits for a live holder to release the lock, and tells the watcher it is waiting", () => {
		// A holder that grabs the lock and holds it 600ms: the wrapper must queue and gain
		// the lane, not fail or run degraded.
		const holder = Bun.spawn(
			["sh", "-c", `exec 9>>"${lock}"; flock -x -w 5 9; sleep 0.6; exit 0`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		waitForHolder(lock);
		const started = Date.now();
		const res = run("exit 0");
		const waitedMs = Date.now() - started;
		holder.unref?.();
		expect(res.exitCode).toBe(0);
		expect(waitedMs).toBeGreaterThan(300);
		expect(res.stderr).toContain("another heavy run holds the verify lane");
		expect(res.stderr).toContain("waiting");
	});

	it("exports the held-marker env var into the command it runs", () => {
		const res = run("exit 0");
		expect(res.env).toBe("1");
	});

	it("refuses an empty command with the usage line, flock or no flock", () => {
		const res = Bun.spawnSync(["sh", WRAPPER], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ANTHERS_HEAVY_RUN_LOCK: lock },
		});
		expect(res.exitCode).toBe(64);
		expect(res.stderr.toString()).toContain("usage");
	});

	it("chmod-checks nothing the repo relies on — the Makefile invokes it through sh", () => {
		const makefile = Bun.spawnSync(["grep", "-n", "heavy-run.sh", join(REPO_ROOT, "Makefile")])
			.stdout.toString()
			.trim();
		expect(makefile).toContain("sh scripts/heavy-run.sh");
	});

	it("the script exists at the path the Makefile names", () => {
		chmodSync(WRAPPER, 0o755);
		expect(Bun.spawnSync(["test", "-x", WRAPPER]).exitCode).toBe(0);
	});
});

describe("holdUnitTestLock — the preload's path over a bare bun test", () => {
	let lock: string;

	beforeAll(() => {
		lock = join(mkdtempSync(join(tmpdir(), "heavy-run-hold-")), "heavy-run.lock");
		writeFileSync(lock, "");
	});

	afterAll(() => {
		rmSync(join(lock, ".."), { recursive: true, force: true });
	});

	// The function reads process.env directly, so each test sets what it asserts on and
	// restores afterwards; a leaked env var here would skip real full runs' locks for the
	// whole suite.
	async function withEnv<T>(
		env: Record<string, string | undefined>,
		body: () => Promise<T>,
	): Promise<T> {
		const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
		try {
			for (const [key, value] of Object.entries(env)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			return await body();
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	it("skips entirely when the lane is already held above this run", async () => {
		const lines: string[] = [];
		await withEnv({ [HELD_ENV]: "1" }, () =>
			holdUnitTestLock((line) => lines.push(line), { pollMs: 50 }),
		);
		expect(lines).toEqual([]);
	});

	it("waits for a live holder, reports the wait, and then holds the lane itself", async () => {
		// A holder that grabs the lock and releases it after 700ms; the hold's poll is short
		// here so the test stays under a second.
		const holder = Bun.spawn(
			["sh", "-c", `exec 9>>"${lock}"; flock -x -w 10 9; sleep 0.7; exit 0`],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		waitForHolder(lock);
		const lines: string[] = [];
		const startedAt = Date.now();
		await withEnv({ [HELD_ENV]: undefined, CI: undefined, ANTHERS_HEAVY_RUN_LOCK: lock }, () =>
			holdUnitTestLock((line) => lines.push(line), { pollMs: 100 }),
		);
		expect(Date.now() - startedAt > 400).toBe(true);
		expect(lines.some((line) => line.includes("another heavy run holds the verify lane"))).toBe(
			true,
		);
		holder.unref?.();
	});
});
