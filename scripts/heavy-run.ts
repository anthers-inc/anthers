// SPDX-License-Identifier: Apache-2.0
/**
 * The verify lane's machine-wide lock, TS side: a bare full `bun test` run.
 *
 * Two heavyweight verification suites running side by side oversubscribe the machine: the
 * suites already share nothing (every run brings its own database and its own private AT
 * Protocol network, per `scripts/session.ts`), so the red spec that passes in isolation is
 * CPU contention, not a data race — and the losing run is a spec that has nothing wrong
 * with it. `scripts/heavy-run.sh` wraps the lanes a make target can wrap (`make verify`,
 * the browser targets); this module covers the invocation that wraps nothing — a bare
 * `bun test` (which also covers `bun run test`), taken from the test preload
 * (`session-preload.ts`). Both scripts document the same lock and the same env variables;
 * change both sides together.
 *
 * **The scope of the lock is the deciding line, and nothing else is.** A run that names
 * test files after `bun test` is a scoped run — cheap, lock-free, and the reason parallel
 * iterating works; a run of flags only, or no arguments at all, is a full run and takes
 * the lock. The true command line is read from `/proc/self/cmdline`, because bun rewrites
 * `Bun.argv` inside a preload to the first test file it loads (see the probe history) —
 * the real invocation survives only in the kernel's record of the exec. `/proc` does not
 * exist everywhere: where the command line cannot be read, a run that cannot be PROVED
 * scoped is treated as full, the same fail-closed direction the push gate uses.
 *
 * The lock is libc's `flock` via `bun:ffi` (Bun 1.3 ships no `fs.flock`), `LOCK_EX`,
 * polled so a waiting run can say so. Held for this process's whole lifetime — the fd
 * stays open and the kernel releases the lock at exit, crashed or not. `CI` skips the
 * lock outright (ephemeral runners have no sibling sessions), and
 * `ANTHERS_HEAVY_RUN_HELD=1`, which `heavy-run.sh` exports, skips it when the run is
 * already inside a held lane (the full suite inside `make verify`): locking again there
 * would deadlock against the wrapper's own lock.
 */

import { mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Set by `scripts/heavy-run.sh` for the command it spans; the preload checks it and locks nothing. */
export const HELD_ENV = "ANTHERS_HEAVY_RUN_HELD";

/** Where a heavy-run lock lives when nothing has overridden it. `heavy-run.sh` names the same default. */
export const LOCK_DEFAULT = join(homedir(), ".cache", "anthers", "heavy-run.lock");

export function lockPath(): string {
	return process.env.ANTHERS_HEAVY_RUN_LOCK ?? LOCK_DEFAULT;
}

/**
 * The exec command line, `["bun", "test", …]`. The final entry may be empty (trailing NUL),
 * so empties are dropped — but a genuinely empty argument inside `bun test` is not a path
 * bun would load either, so the drop cannot flip a scoped run into being read as full.
 */
export function trueArgv(): string[] {
	try {
		return readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
	} catch {
		// No /proc (macOS, Windows): the invocation cannot be read, so full by default.
		return ["bun", "test"];
	}
}

/**
 * Whether this `bun test` run is a full one: the command is `test` (or the child of
 * `bun run test`, whose own process still runs `bun test`) and no argument names a test
 * file or directory. Flags only — `--only-failures`, `--silent`, `-t <name>` with no path —
 * count as full: without a path filter they load the whole tree, and a run that cannot be
 * proved scoped is treated as heavy.
 */
export function isFullUnitTestRun(argv: string[] = trueArgv()): boolean {
	if (argv[1] !== "test") return false;
	return !argv.slice(2).some((arg) => !arg.startsWith("-"));
}

/**
 * Take the verify lane's lock for this process's whole lifetime. Resolves when the lock is
 * held — or immediately, reported, when the run must not wait (CI, a lane already held,
 * or an environment with no lockable libc). Never throws: the lock is an optimization the
 * suites cannot depend on, and a failed acquire degrades to the side-by-side behavior.
 */
export async function holdUnitTestLock(
	log: (line: string) => void,
	options: { pollMs?: number } = {},
): Promise<void> {
	if (process.env[HELD_ENV] === "1") return;
	if (process.env.CI !== undefined) return;

	let flock: (fd: number, operation: number) => number;
	try {
		const { dlopen, FFIType } = await import("bun:ffi");
		const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		});
		flock = libc.symbols.flock;
	} catch (error) {
		log(
			`→ libc's flock is unavailable here, so this full run takes no verify-lane lock (${(error as Error).message.split("\n")[0]}) — heavy suites side by side may flake each other`,
		);
		return;
	}

	const path = lockPath();
	let fd: number;
	try {
		mkdirSync(dirname(path), { recursive: true });
		fd = openSync(path, "a");
	} catch (error) {
		log(
			`→ cannot open the verify lane's lock file at ${path}, so this full run takes no lock (${(error as Error).message})`,
		);
		return;
	}

	// POLLING, not a blocking flock: the event loop must stay alive to print the wait
	// report, and a waiting agent reading a silent 120 s as a hang is the exact failure
	// the push hook's per-step announcements exist to stop. The first blocked attempt
	// reports at once, then every poll — the same shape `heavy-run.sh` waits with.
	const LOCK_EX = 2;
	const LOCK_NB = 4;
	const pollMs = options.pollMs ?? 15_000;
	let waited = 0;
	if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		log(
			"→ another heavy run holds the verify lane — waiting (this report repeats every 15s); a scoped `bun test <path>` run never waits",
		);
		while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			await Bun.sleep(pollMs);
			waited += Math.round(pollMs / 1000);
			log(`→ the verify lane still held (${waited}s of waiting so far)`);
		}
	}
	// Deliberately never closed: the fd's open file description carries the lock until the
	// process exits, at which point the kernel releases it — however the process ends.
}
