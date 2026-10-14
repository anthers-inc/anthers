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
 * **Tiers.** Since the push gate routes by destination (2026-10-11), a push to a task
 * branch asks the suite less than a push to `main` or `release`: the fast tier runs
 * everything but Playwright, whose suites are CI's responsibility. A stamp carries the
 * tier that ran. **A full stamp satisfies any tier, and a fast stamp satisfies only a
 * fast push** — the direction that matters is that a cheaper run can never stand in for
 * a dearer one, which is why `requiredTier` defaults to `verify`. A head that first ran
 * fast and then ran full carries both markers in its file: writes append, so the file
 * answers with the dearest suite that has ever passed at that head. A stamp file whose
 * content names neither marker is trusted for nothing — every doubt fails closed.
 *
 * **The stamp is keyed on the head, and only a tracked-clean tree may write one.** The
 * hook verifies the pushed COMMIT, and a hand run in a worktree with uncommitted changes
 * verified that commit plus whatever was dirty — different tree, no stamp. Untracked
 * files are deliberately tolerated (`--porcelain -uno`): they are outside every tracked
 * tree, and nothing a stamp consumer trusts is computed over them. The pushing session
 * does not have to be the one that pushed later; heads are immutable, so the stamp says
 * what its content is regardless of who rereads it.
 *
 * Stamps live under the repository's shared `cache/verify-stamps/<head>` (tests override with
 * `ANTHERS_VERIFY_STAMPS`) and are trusted for 24 hours — a window, not a proof: the
 * verified content never changes, but the environment around it can. Everything fails
 * closed: a missing, stale, unreadable or unrecognized stamp is the same as no stamp,
 * and the hook runs the suite. `check` answers by its exit code; the hook must never
 * read further than that.
 */

import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { repoCacheDir } from "./repo-cache.ts";

function defaultStampDir(options: { cwd?: string } = {}): string {
	return join(repoCacheDir(options), "verify-stamps");
}

export const STAMP_WINDOW_MINUTES = 24 * 60;

/** Which suite a stamp records, or which a check must be satisfied by. */
export type StampTier = "verify" | "verify-fast";

export interface StampOptions {
	/** Directory stamps live in (tests override the default). */
	dir?: string;
	/** Now, overridable for tests. */
	now?: Date;
	/** cwd whose HEAD and tracked state are read (defaults to this process's). */
	cwd?: string;
	/** For `writeStamp`, the tier that ran (defaults to `verify`); for the CLI, see `main`. */
	tier?: StampTier;
	/** For `checkStamp`, the tier the caller needs (defaults to `verify`, the strict side). */
	requiredTier?: StampTier;
	log?: (line: string) => void;
}

/** The markers' exact texts — neither is a substring of the other, so a content read names its tier. */
export const FULL_STAMP_MARKER = "make verify green at ";
export const FAST_STAMP_MARKER = "make verify-fast green at ";

function stampDir(options: StampOptions): string {
	return options.dir ?? process.env.ANTHERS_VERIFY_STAMPS ?? defaultStampDir(options);
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
	// behind, the mtime is the freshness the check reads, and an append is what lets a
	// head upgrade its stamp — a head that ran fast and then ran full carries both
	// markers, and answers the dearest check either would.
	const fd = openSync(file, "a");
	const tier = options.tier ?? "verify";
	writeFileSync(fd, `${(options.now ?? new Date()).toISOString()} make ${tier} green at ${head}\n`);
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
	/** Why the stamp was not trusted: nothing there, older than the window, content naming no tier, or a tier that does not satisfy the required one. */
	reason?: "missing" | "expired" | "unrecognized" | "insufficient";
}

export function checkStamp(head: string | undefined, options: StampOptions = {}): StampCheck {
	const file = head ? stampFileFor(head, options) : "";
	if (!file || !existsSync(file)) return { ok: false, reason: "missing" };
	const writtenAt = statSync(file).mtime;
	const ageMinutes = ((options.now ?? new Date()).getTime() - writtenAt.getTime()) / 60_000;
	if (ageMinutes > STAMP_WINDOW_MINUTES) return { ok: false, reason: "expired", writtenAt };
	try {
		const content = readFileSync(file, "utf8");
		const hasFull = content.includes(FULL_STAMP_MARKER);
		const hasFast = content.includes(FAST_STAMP_MARKER);
		// A full stamp satisfies any tier; a fast stamp satisfies only a fast check. Content
		// naming neither marker is trusted for nothing — fail closed on every doubt.
		if (!hasFull && !hasFast) return { ok: false, reason: "unrecognized", writtenAt };
		const requiredTier = options.requiredTier ?? "verify";
		const ok = requiredTier === "verify-fast" ? hasFull || hasFast : hasFull;
		return ok ? { ok: true, writtenAt } : { ok: false, reason: "insufficient", writtenAt };
	} catch {
		// An unreadable stamp is the same as no stamp.
		return { ok: false, reason: "unrecognized", writtenAt };
	}
}

/** The skip message's human half: how old the stamp is, as the stamp-check will print it. */
export function stampAge(writtenAt: Date, now: Date = new Date()): string {
	const minutes = Math.max(1, Math.round((now.getTime() - writtenAt.getTime()) / 60_000));
	return minutes < 90
		? `${minutes} minute${minutes === 1 ? "" : "s"} ago`
		: `${Math.round(minutes / 60)} hours ago`;
}

async function main(): Promise<number> {
	const [command, head, tier] = process.argv.slice(2);
	if (command === "check") {
		// The required tier defaults to `verify`, the strict side: a caller that passes no
		// tier is asking what the full suite's gate would ask.
		const requiredTier: StampTier = tier === "verify-fast" ? "verify-fast" : "verify";
		const result = checkStamp(head, { requiredTier });
		if (!result.ok) return 1;
		const written = result.writtenAt ? stampAge(result.writtenAt) : "";
		console.log(`green ${written}`.trim());
		return 0;
	}
	if (command === "write") {
		// CI runs the suite's steps directly (never `make verify`) and its runners are
		// ephemeral — a stamp on a runner would live seconds and mean nothing; skip quietly.
		if (process.env.CI !== undefined) return 0;
		// For `write`, the tier is the argument right after the command: `write verify-fast`.
		const stampTier: StampTier = head === "verify-fast" ? "verify-fast" : "verify";
		writeStamp({ tier: stampTier, log: (line) => console.error(line) });
		// Never a nonzero exit: the stamp is an optimization a green suite must not depend on.
		return 0;
	}
	console.error(
		"usage: bun run scripts/verify-stamp.ts write [verify|verify-fast] | check <head> [verify|verify-fast]",
	);
	return 64;
}

if (import.meta.main) {
	process.exit(await main());
}
