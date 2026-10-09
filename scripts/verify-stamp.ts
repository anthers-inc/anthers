// SPDX-License-Identifier: Apache-2.0
/**
 * The verify stamp — the record that `make verify` already ran green at a given head, so
 * the pre-push hook does not buy a second ticket in the same load-flake lottery.
 *
 * The incident that paid for this: a push's hook verify failed and the identical `make
 * verify` run by hand minutes later passed completely (258 browser specs green), because
 * the first run collided with sibling sessions' suites — so the push paid for the suite
 * twice, and the first payment bought a load flake. When a hand run has verified exactly
 * the tree a push is about to send, re-verifying it adds nothing but a second chance to
 * flake.
 *
 * **The stamp is keyed on the head, and only a tracked-clean tree may write one.** The
 * hook verifies the pushed COMMIT, and a hand run in a worktree with uncommitted changes
 * verified that commit plus whatever was dirty — different tree, no stamp. Untracked
 * files are deliberately tolerated (`--porcelain -uno`): they are outside every tracked
 * tree, and nothing a stamp consumer trusts is computed over them. The pushing session
 * does not have to be the one that pushed later; heads are immutable, so the stamp says
 * what its content is regardless of who rereads it.
 *
 * Stamps live under `~/.cache/anthers/verify-stamps/<head>` (tests override with
 * `ANTHERS_VERIFY_STAMPS`) and are trusted for 24 hours — a window, not a proof: the
 * verified content never changes, but the environment around it can. Everything fails
 * closed: a missing, stale or unreadable stamp is the same as no stamp, and the hook runs
 * the suite. `check` answers by its exit code; the hook must never read further than that.
 */

import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STAMP_DIR_DEFAULT = join(homedir(), ".cache", "anthers", "verify-stamps");
export const STAMP_WINDOW_MINUTES = 24 * 60;

export interface StampOptions {
	/** Directory stamps live in (tests override the default). */
	dir?: string;
	/** Now, overridable for tests. */
	now?: Date;
	/** cwd whose HEAD and tracked state are read (defaults to this process's). */
	cwd?: string;
	log?: (line: string) => void;
}

function stampDir(options: StampOptions): string {
	return options.dir ?? process.env.ANTHERS_VERIFY_STAMPS ?? STAMP_DIR_DEFAULT;
}

export function stampFileFor(head: string, options: StampOptions = {}): string {
	return join(stampDir(options), head);
}

/**
 * git's view of `options.cwd`, or "" when the command fails. The environment carries no
 * `GIT_*` variables: `git` exports them to a hook, and inside a pre-push hook's verify
 * (where the suite that runs this file lives) `GIT_DIR` is an absolute path into ANOTHER
 * checkout's worktree gitdir — the same trap `scripts/pre-push-hook.test.ts` documents the
 * hook's own scrub for. A stamp read from the wrong tree would be worse than no stamp.
 */
function gitEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function git(args: string[], options: StampOptions): string {
	const result = spawnSync("git", args, { cwd: options.cwd, encoding: "utf8", env: gitEnv() });
	return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * Stamp a green run, when the tree that ran it is a head's exact content. Returns whether
 * a stamp was written — false is normal (dirty tree, no repository) and never fatal. The
 * CI skip is the CLI's decision, not this function's: a library function that answers its
 * environment differently under the test runner is a test that can never exercise it
 * (this file's tests failed in CI for exactly that), and the CLI entry is the only write
 * path the suite and hook reach anyway.
 */
export function writeStamp(options: StampOptions = {}): boolean {
	const head = git(["rev-parse", "HEAD"], options);
	if (!head) {
		options.log?.("→ no commit here, so nothing to stamp the verify against");
		return false;
	}
	// Tracked cleanliness only — untracked files are outside the pushed tree, and the
	// docblock carries why tolerating them is the choice (a worktree with a stale pid file
	// must still be able to stamp its green run).
	if (git(["status", "--porcelain", "-uno"], options) !== "") {
		options.log?.(
			"→ verify passed, but tracked files are uncommitted here, so no stamp is written — the push verifies the commit, not this checkout's tree",
		);
		return false;
	}

	const dir = stampDir(options);
	const file = stampFileFor(head, options);
	mkdirSync(dir, { recursive: true });
	// Open-then-write instead of truncate: a re-entrant run can never leave a half file
	// behind, and the mtime is the freshness the check reads.
	const fd = openSync(file, "a");
	writeFileSync(fd, `${(options.now ?? new Date()).toISOString()} make verify green at ${head}\n`);
	closeSync(fd);
	pruneExpiredStamps(options);
	return true;
}

/**
 * Green verifies stamp one file per head, and nothing is ever trusted past the window — so
 * prune what has expired while writing, and the directory stays as large as the last two
 * days of pushes. Readdir failures are silently survivable; pruning is hygiene, not gating.
 */
function pruneExpiredStamps(options: StampOptions): void {
	const dir = stampDir(options);
	const now = options.now ?? new Date();
	try {
		for (const name of readdirSync(dir)) {
			try {
				const ageMinutes = (now.getTime() - statSync(join(dir, name)).mtime.getTime()) / 60_000;
				if (ageMinutes > STAMP_WINDOW_MINUTES) rmSync(join(dir, name), { force: true });
			} catch {
				// One unreadable stamp never blocks pruning the others.
			}
		}
	} catch {
		// A missing directory has nothing to prune.
	}
}

export interface StampCheck {
	ok: boolean;
	/** When a stamp was found (fresh or not), its timestamp — the message a skip prints. */
	writtenAt?: Date;
	/** Why the stamp was not trusted: nothing there, or older than the window. */
	reason?: "missing" | "expired";
}

export function checkStamp(head: string | undefined, options: StampOptions = {}): StampCheck {
	const file = head ? stampFileFor(head, options) : "";
	if (!file || !existsSync(file)) return { ok: false, reason: "missing" };
	const writtenAt = statSync(file).mtime;
	const ageMinutes = ((options.now ?? new Date()).getTime() - writtenAt.getTime()) / 60_000;
	if (ageMinutes > STAMP_WINDOW_MINUTES) return { ok: false, reason: "expired", writtenAt };
	return { ok: true, writtenAt };
}

/** The skip message's human half: how old the stamp is, as the stamp-check will print it. */
export function stampAge(writtenAt: Date, now: Date = new Date()): string {
	const minutes = Math.max(1, Math.round((now.getTime() - writtenAt.getTime()) / 60_000));
	return minutes < 90
		? `${minutes} minute${minutes === 1 ? "" : "s"} ago`
		: `${Math.round(minutes / 60)} hours ago`;
}

async function main(): Promise<number> {
	const [command, head] = process.argv.slice(2);
	if (command === "check") {
		const result = checkStamp(head);
		if (!result.ok) return 1;
		const written = result.writtenAt ? stampAge(result.writtenAt) : "";
		console.log(`green ${written}`.trim());
		return 0;
	}
	if (command === "write") {
		// CI runs the suite's steps directly (never `make verify`) and its runners are
		// ephemeral — a stamp on a runner would live seconds and mean nothing; skip quietly.
		if (process.env.CI !== undefined) return 0;
		writeStamp({ log: (line) => console.error(line) });
		// Never a nonzero exit: the stamp is an optimization a green suite must not depend on.
		return 0;
	}
	console.error("usage: bun run scripts/verify-stamp.ts write | check <head>");
	return 64;
}

if (import.meta.main) {
	process.exit(await main());
}
