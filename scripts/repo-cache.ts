// SPDX-License-Identifier: Apache-2.0
/**
 * The repository's shared cache — the one directory every worktree and every session
 * resolves for pipeline state: the heavy-run lock, the verify stamps, the landing
 * ledger and lock, the arm-gate scratch cache.
 *
 * It lives at `cache/` in the main checkout, gitignored, so the pipeline's state is
 * encapsulated inside the project that owns it rather than scattered under the user's
 * home cache (Parker, 2026-10-14 — the same reasoning that keeps temp files and
 * screenshots out of /tmp). The property that decides its location is not the
 * filesystem but the repository: this state must span every worktree and every
 * session, because a per-worktree lock serializes nothing and a stamp minted in one
 * worktree answers a push from another — which is why the resolution goes through
 * git's common dir, the one path git guarantees is shared by every worktree, and
 * lands at its parent's `cache/`.
 *
 * There is deliberately no fallback to a home-directory cache: every consumer here
 * assumes a checkout already (rev-parse a HEAD, merge-tree branches), so a caller
 * outside a repository has lost more than its cache, and silently materializing state
 * under the user's home would recreate exactly the scattering this module exists to
 * close. Tests never rely on this default — they pass explicit paths, as they did
 * before this module existed.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Git's environment, stripped of `GIT_*` variables — the same trap `verify-stamp`'s
 * `gitEnv` documents: a resolver spawned from a hook must not inherit a `GIT_DIR`
 * that points into another checkout's worktree, or cache state could be read from or
 * written to the wrong tree.
 */
function gitEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

/** The repository's shared `cache/` directory. Throws when git cannot answer — no resolver outside a checkout is a legitimate caller. */
export function repoCacheDir(options: { cwd?: string } = {}): string {
	const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: options.cwd ?? process.cwd(),
		encoding: "utf8",
		env: gitEnv(),
	});
	if (result.status !== 0 || !(result.stdout ?? "").trim()) {
		const reason =
			(result.stderr || result.stdout || "no output").split("\n").filter(Boolean)[0] ?? "";
		throw new Error(
			`the repository's shared cache could not be resolved (git common dir failed: ${reason.slice(0, 120)})`,
		);
	}
	return join(result.stdout.trim(), "..", "cache");
}
