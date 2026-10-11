// SPDX-License-Identifier: Apache-2.0
/**
 * The version half of a promote: compute the next calver version, bump the committed
 * `APP_VERSION` constant, and print the commands for the rest of the flow.
 *
 * 🚨 **The version is a committed constant rather than a git-derived value, and that is
 * what makes this flow safe to run anywhere.** The web bundle is built on App Platform's
 * own clone of the branch — a clone whose git state nobody here controls (it carries no
 * guarantee of tags, and its shape can change without notice) — so `git describe` at
 * build time would silently produce a footer reading `unknown` on the day it goes
 * wrong. The bump lives in a PR to `main` instead: the tag CI applies and the version the
 * footer renders agree by construction, because both come from the same commit.
 *
 * The full promote flow, in order:
 *
 * 1. `bun run scripts/promote-version.ts` — compute the next version, write the bump
 *    and the release-notes entries the version needs (this script; the target is
 *    computed from the constant as `HEAD` carries it, so a re-run of a resumed promote
 *    converges on the same version rather than bumping twice).
 * 2. Open a PR for the bump — **its commit carries the version and the new release's
 *    release-notes entry together**, because CI's deploy job refuses a release whose
 *    version has no entry (`scripts/release-notes-audit.ts` runs before the deploy).
 *    Let CI go green, merge to `main`.
 * 3. Promote `main` to `release` from a detached worktree at `origin/main` — the
 *    documented flow, never a bare `git push origin main:release` from a stale local.
 * 4. CI's deploy job audits the notes, deploys, tags the deployed commit
 *    `v<APP_VERSION>`, and publishes the raw release notes on the tag.
 * 5. `make deploy-status` reports the running version beside the deployment state.
 *
 * ⚠️ **The bump is its own PR, deliberately not pushed by this script.** Merging to
 * `main` is gated on CI's five required checks, and a script that pushed directly
 * would race that gate. A human runs step 3 when the PR is green — promoting is
 * Parker's call, not a script's.
 *
 * Usage:
 *   bun run scripts/promote-version.ts [--check] [--version YYYY.M.N]
 *
 * --check       exit 1 if the constant is missing or malformed — no writes; this is
 *               what `make verify` runs so a mangled bump never reaches a promote.
 * --version     pin the next version instead of computing it, for the rare promote
 *               that needs to skip numbers (a pulled release, a re-promote).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const VERSION_FILE = "packages/shared/src/version.ts";
const VERSION_EXPORT = "export const APP_VERSION = ";

function fail(message: string): never {
	console.error(`promote-version: ${message}`);
	process.exit(1);
}

/** Read the committed version constant. */
function readCurrent(): string {
	let source: string;
	try {
		source = readFileSync(VERSION_FILE, "utf8");
	} catch {
		return fail(`could not read ${VERSION_FILE}`);
	}
	const line = source.split("\n").find((l) => l.startsWith(VERSION_EXPORT));
	if (!line) return fail(`no "${VERSION_EXPORT}" line in ${VERSION_FILE}`);
	const match = line.match(/"([^"]+)"/);
	if (!match) return fail(`the APP_VERSION line does not carry a quoted string`);
	return match[1];
}

/**
 * The version constant as `HEAD` carries it — the baseline a promote computes its target
 * from, not the working tree's. The working tree of a resumed promote already carries the
 * interrupted session's bump, and computing nextVersion from that double-bumps: the first
 * run writes `.22` from a `.21` committed constant, a re-run reads `.22` still unreleased
 * and writes `.23`, a number this promote then publishes while its release-notes entry
 * names `.22`. The committed constant is the one thing an interrupted session cannot have
 * moved, so it is the only honest baseline.
 */
function readCommitted(): string {
	let out: string;
	try {
		const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
		}).trim();
		out = execFileSync("git", ["show", `HEAD:${VERSION_FILE}`], {
			encoding: "utf8",
			cwd: toplevel,
		});
	} catch (error) {
		return fail(
			`${VERSION_FILE} is not readable at HEAD (run from the repository) — ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const line = out.split("\n").find((l) => l.startsWith(VERSION_EXPORT));
	if (!line) return fail(`no "${VERSION_EXPORT}" line at HEAD:${VERSION_FILE}`);
	const match = line.match(/"([^"]+)"/);
	if (!match) return fail(`the APP_VERSION line at HEAD does not carry a quoted string`);
	return match[1];
}

/**
 * The bump decision, pure for tests and shared by the script's only path. `committed` is
 * the baseline nextVersion computes from; `working` is the tree's constant, which is the
 * committed value on a clean tree and the interrupted session's bump on a resumed one.
 * `pinned` replaces the computed target outright (--version), for the rare promote that
 * must skip a pulled release's number — and is deliberate by construction, so it also
 * writes over a stray constant where the unpinned path refuses.
 */
export type BumpPlan =
	| { action: "no-op"; target: string }
	| { action: "write"; target: string }
	| { action: "refuse"; target: string; committed: string; working: string };

export function bumpPlan(
	committed: string,
	working: string,
	pinned?: string,
	today?: Date,
): BumpPlan {
	const target = pinned ?? nextVersion(committed, today);
	// Already at the promote's target in the working tree: the bump is written (a
	// re-invocation of an interrupted promote) — converging is success, not an error.
	if (target === working) return { action: "no-op", target };
	// Without a pin, a tree that disagrees with both HEAD and this promote's target is a
	// constant edit no step of this flow wrote or will write. Bumping over it would
	// publish a version neither the entries nor a release was composed for, so refuse
	// with the way out (restore the computed target, or pin one deliberately). With a
	// pin, the operator has named the version deliberately: write it.
	if (working !== committed && pinned === undefined) {
		return { action: "refuse", target, committed, working };
	}
	return { action: "write", target };
}

/** The next calver version, given today's date and the current constant. */
export function nextVersion(current: string, today = new Date()): string {
	const match = current.match(/^(\d{4})\.(\d{1,2})\.(\d+)$/);
	if (!match) {
		throw new Error(`"${current}" is not calver YYYY.M.N`);
	}
	const [, year, month, patch] = match;
	const thisYear = today.getFullYear();
	const thisMonth = today.getMonth() + 1;
	// First promote of a new month: month component rolls, patch resets. Same month:
	// patch increments. A later release re-promoting the same month keeps counting
	// patch rather than skipping, so a pulled release never strands a number.
	if (Number(year) === thisYear && Number(month) === thisMonth) {
		return `${thisYear}.${thisMonth}.${Number(patch) + 1}`;
	}
	// A new year or month — or a constant that has fallen behind real time, which is
	// not an error: a promote in March after a January release rolls to March.0.
	return `${thisYear}.${thisMonth}.0`;
}

// 🚨 Everything below runs only as a script. The module is imported by
// `promote-version.test.ts` for `nextVersion` and `bumpPlan`, so the bump flow must not
// execute on import — a test run would otherwise rewrite the committed version constant.
if (import.meta.main) {
	// --check: no writes, exit 1 on a malformed constant. The deploy job composes a
	// git tag from this string, and a tag with a space or a `v` fails there rather
	// than here.
	if (process.argv.includes("--check")) {
		const current = readCurrent();
		const shape = /^\d{4}\.\d{1,2}\.\d+$/;
		if (!shape.test(current)) {
			fail(`APP_VERSION "${current}" is not calver YYYY.M.N`);
		}
		console.log(`promote-version: APP_VERSION ${current} ✓`);
		process.exit(0);
	}

	const working = readCurrent();
	const pinIndex = process.argv.indexOf("--version");
	const pinned =
		pinIndex !== -1 ? (process.argv[pinIndex + 1] ?? fail("--version needs a value")) : undefined;
	const committed = readCommitted();
	const plan = (() => {
		try {
			return bumpPlan(committed, working, pinned);
		} catch (error) {
			return fail(`HEAD's APP_VERSION is bad: ${(error as Error).message}`);
		}
	})();
	if (!/^\d{4}\.\d{1,2}\.\d+$/.test(plan.target)) {
		fail(`next version "${plan.target}" is not calver YYYY.M.N`);
	}
	if (plan.action === "no-op") {
		// Idempotent, not an error: the flow's step 1 already ran (a re-invocation after
		// the release-notes pass staged its entries, a resumed promote). Converging on
		// the same version is success — that is what makes the whole flow self-healing.
		console.log(`promote-version: APP_VERSION is already ${plan.target} ✓`);
		process.exit(0);
	}
	if (plan.action === "refuse") {
		fail(
			`the working tree's APP_VERSION is ${plan.working}, where HEAD carries ${plan.committed}, ` +
				`and this promote computes ${plan.target}. Restore the constant to ${plan.target} and run ` +
				`this again, or pin a deliberately different version with --version.`,
		);
	}
	const target = plan.target;

	// Write the bump: replace the constant's line, preserving everything around it.
	const source = readFileSync(VERSION_FILE, "utf8");
	const updated = source.replace(
		new RegExp(`(${VERSION_EXPORT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"[^"]+"`),
		`$1"${target}"`,
	);
	if (updated === source) {
		fail(`could not rewrite the APP_VERSION line in ${VERSION_FILE}`);
	}
	writeFileSync(VERSION_FILE, updated);

	console.log(`promote-version: ${working} → ${target}`);
	console.log("");
	console.log("Next steps — the bump and its release-notes entry are one PR:");
	console.log("  1. Run the /promote command, or by hand:");
	console.log("     a. Write the new release's entry into apps/web/src/content/release-notes.ts");
	console.log("        (the anthers-release-notes skill's pass), and backfill any version the");
	console.log("        audit names: bun run scripts/release-notes-audit.ts");
	console.log("     b. Commit both on this branch, open a PR, wait for CI's five checks.");
	console.log("  2. Merge, then promote from a detached worktree at origin/main:");
	console.log("     git worktree add --detach .worktrees/promote origin/main");
	console.log("     git push origin HEAD:refs/heads/release   # from inside that worktree");
	console.log(`  3. CI's deploy job audits the notes, deploys, and tags the commit v${target}.`);
	console.log("  4. Watch the run on release; deploy-status reports the version from there.");
}
