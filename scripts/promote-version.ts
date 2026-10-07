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
 *    and the release-notes entries the version needs (this script; idempotent, so a
 *    re-run converges).
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
// `promote-version.test.ts` for `nextVersion`, so the bump flow must not execute on
// import — a test run would otherwise rewrite the committed version constant.
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

	const current = readCurrent();
	const pinIndex = process.argv.indexOf("--version");
	const next =
		pinIndex !== -1 ? (process.argv[pinIndex + 1] ?? fail("--version needs a value")) : undefined;
	const target = next ?? nextVersion(current);
	if (!/^\d{4}\.\d{1,2}\.\d+$/.test(target)) {
		fail(`next version "${target}" is not calver YYYY.M.N`);
	}
	if (target === current) {
		// Idempotent, not an error: the flow's step 1 already ran (a re-invocation after
		// the release-notes pass staged its entries, a resumed promote). Converging on
		// the same version is success — that is what makes the whole flow self-healing.
		console.log(`promote-version: APP_VERSION is already ${target} ✓`);
		process.exit(0);
	}

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

	console.log(`promote-version: ${current} → ${target}`);
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
