// SPDX-License-Identifier: Apache-2.0
/**
 * Where this checkout's Anthers **organization** directory is — the folder holding the
 * repository, both wikis and the sibling repositories.
 *
 * The organization is the repository's parent, but only in the main checkout. A worktree
 * created by `make worktree` nests inside the repository at `.worktrees/<name>`, so a scan
 * that derives the organization as `join(REPO, "..")` lands on a directory with no `Anthers-*`
 * siblings from inside one — and `insideOrganization()` then answers false, which reads a moved
 * wiki as the correct-for-CI skip instead of the failure it is. That is the silent half of the
 * failure this module exists to prevent; see the warnings on `insideOrganization` and on the
 * vault resolvers in `scripts/econ-figures.ts`.
 *
 * 🚨 **Resolve the organization through git, never from a path.** `git rev-parse
 * --git-common-dir` names the main repository's `.git` from inside any worktree of it, so the
 * organization is that path's grandparent however the checkout is nested. A path that walks up a
 * fixed number of `..` is the bug above, in every file that has tried it.
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The main checkout's root, from anywhere inside any worktree of this repository.
 *
 * `--git-common-dir` answers relative to the directory it runs in for a linked worktree and as
 * an absolute path for the main checkout, so it is resolved before use rather than trusted.
 */
export function mainCheckoutRoot(cwd: string): string {
	const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd });
	if (result.exitCode !== 0) {
		throw new Error(
			`git rev-parse --git-common-dir failed in ${cwd}: ${result.stderr.toString().trim()}`,
		);
	}
	return resolve(cwd, dirname(result.stdout.toString().trim()));
}

/** The organization directory a checkout sits in — the main checkout's parent. */
export function organizationDir(cwd: string): string {
	return dirname(mainCheckoutRoot(cwd));
}

/**
 * Whether this checkout sits inside the Anthers organization, which decides whether a missing
 * wiki is a skip or a failure.
 *
 * ⭐ **This is the absent-versus-broken discriminator, and it detects the thing itself rather
 * than a proxy for it.** A CI runner and a contributor's clone hold the repository alone, so a
 * missing wiki there is simply absent and skipping is correct. A checkout sitting beside its
 * sibling repositories is on a machine where the wikis are *expected*, so a missing one there is
 * broken and has to say so. The marker is a sibling of the organization shape — `wiki-*` —
 * because the organization is exactly the directory that has them. 🚨 It catches the
 * *older* shape (`Anthers-*`) too, or the org-shape rename of 2026-10-15 (which renamed
 * every wiki to `wiki-{org}`) would have turned this into the same silent skip the path
 * couplings fired three times before: a check that reports correct absence as a defect is
 * a guard people learn to route around, and a check that reports real presence as
 * *nothing* is worse.
 */
export function insideOrganization(cwd: string): boolean {
	try {
		return readdirSync(organizationDir(cwd), { withFileTypes: true }).some(
			(e) =>
				e.isDirectory() &&
				(e.name.startsWith("wiki-") || e.name.startsWith("Anthers-")),
		);
	} catch {
		return false;
	}
}
