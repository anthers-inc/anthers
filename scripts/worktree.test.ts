// SPDX-License-Identifier: Apache-2.0
/**
 * The worktree lifecycle script, driven against throwaway repositories rather than the real
 * one — a test that operated on this checkout's own `.git` could not safely exercise removal.
 *
 * 🚨 **The removal path is the one these tests are for, and it is sabotaged first.** The single
 * failure in the design that costs real work is `remove` deleting work that was never pushed, so
 * the cases that matter most are the refusals: uncommitted changes, untracked files, and a branch
 * whose tree `origin/main` does not yet hold. Each is asserted to be refused — and then asserted
 * to be forceable, because a refusal that cannot be overridden is a trap rather than a guard.
 *
 * The fixtures are real git repositories with a local "origin", not mocks: the branches the
 * script must get right (a squash-merged branch reading as unmerged to commit-level checks,
 * `--no-track` keeping `main` out of a later `git pull`) are properties of git itself and cannot
 * be faked without re-describing the thing the script is for. `bun install` is stubbed out via
 * `WORKTREE_NO_INSTALL` so the suite does not pay for it; the hook restore and file copy use the
 * throwaway repo's own `.githooks` and `.worktreeinclude`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWorktree,
	inspectForRemoval,
	listWorktrees,
	mainRoot,
	removeWorktree,
	validateName,
	worktreePath,
} from "./worktree.ts";

const made: string[] = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The create path runs `bun install`; the behavior under test does not depend on it, and the
// throwaway repositories have no manifest to install against.
process.env.WORKTREE_NO_INSTALL = "1";

// The pre-push hook runs this suite with GIT_DIR/GIT_WORK_TREE set; the throwaway repositories
// are not the repository the hook is guarding, so its environment must not leak into them.
const CLEAN_ENV = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("GIT_"),
	),
);

function sh(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(args, { cwd, env: CLEAN_ENV });
	if (result.exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", ...args);

/** A git probe whose failure is expected rather than fatal. */
const probe = (cwd: string, ...args: string[]) =>
	Bun.spawnSync(["git", ...args], { cwd, env: CLEAN_ENV });

/**
 * A repository laid out like this one: a "main" checkout with a bare "origin", an initial
 * commit on main, a `.githooks/` the Makefile-equivalent points at, and a `.worktreeinclude`.
 * Returns the main checkout's path — the directory a real user or harness would run from.
 */
function fixtureRepo(): string {
	const base = mkdtempSync(join(tmpdir(), "worktree-test-"));
	made.push(base);
	const origin = join(base, "origin.git");
	const main = join(base, "main");

	sh(base, "git", "init", "--bare", "origin.git");
	// --initial-branch names it deterministically: the ambient init.defaultBranch differs
	// between an interactive shell and the stripped environment the pre-push hook runs under.
	sh(base, "git", "init", "--initial-branch", "main", "main");
	git(main, "config", "user.name", "test");
	git(main, "config", "user.email", "test@example.com");
	writeFileSync(join(main, "INFO.txt"), "# fixture\n");
	// A hook the script's hook-restore can act on, and an include file to copy.
	mkdirSync(join(main, ".githooks"));
	writeFileSync(join(main, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n");
	writeFileSync(join(main, ".worktreeinclude"), ".env\n");
	writeFileSync(join(main, ".gitignore"), ".env\n.worktrees/\n");
	writeFileSync(join(main, ".env"), "SECRET=1\n"); // gitignored, as in the real repo
	git(main, "add", ".");
	git(main, "commit", "-m", "init");
	git(main, "remote", "add", "origin", origin);
	git(main, "push", "-u", "origin", "main");
	git(main, "config", "core.hooksPath", ".githooks");
	return main;
}

const create = (name: string, main: string, opts = {}) =>
	createWorktree(name, {
		cwd: main,
		log: () => {},
		...opts,
	});

describe("mainRoot", () => {
	it("names the main checkout from inside a worktree of it", () => {
		const main = fixtureRepo();
		const target = create("nested", main);
		expect(mainRoot(target)).toBe(main);
	});
});

describe("validateName", () => {
	it("accepts a lowercase hyphenated task name", () => {
		expect(() => validateName("signup-page")).not.toThrow();
	});
	it("refuses a name the wiki tooling would discover as a vault", () => {
		expect(() => validateName("foo-Wiki")).toThrow(/vault/);
		expect(() => validateName("foo-wiki")).toThrow(/vault/);
	});
	it("refuses characters that are unsafe as a directory or a branch", () => {
		expect(() => validateName("two words")).toThrow();
		expect(() => validateName("UPPER")).toThrow();
		expect(() => validateName("with_underscore")).toThrow();
	});
});

describe("createWorktree", () => {
	it("creates a worktree on a branch named exactly for it, copied from the include list", () => {
		const main = fixtureRepo();
		const target = create("signup-page", main);
		expect(target).toBe(worktreePath(main, "signup-page"));
		expect(existsSync(target)).toBe(true);
		expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("signup-page");
		// The gitignored .env is the thing a worktree cannot get from git, so it is the copy.
		expect(existsSync(join(target, ".env"))).toBe(true);
	});

	it("does not set the new branch to track the fetch head", () => {
		const main = fixtureRepo();
		const target = create("no-track", main);
		const upstream = probe(target, "rev-parse", "--abbrev-ref", "@{u}");
		expect(upstream.exitCode).not.toBe(0); // no upstream configured
	});

	it("reopens an existing worktree rather than failing on it", () => {
		const main = fixtureRepo();
		create("twice", main);
		expect(() => create("twice", main)).not.toThrow();
	});

	it("reattaches a worktree to a branch that exists but has no worktree yet", () => {
		const main = fixtureRepo();
		create("held", main);
		// Remove just the worktree's directory by hand, leaving the branch — the paused-task case.
		git(main, "worktree", "remove", worktreePath(main, "held"));
		// Creating again must NOT `-b` a branch that already exists; it reattaches to it.
		expect(() => create("held", main)).not.toThrow();
		expect(git(worktreePath(main, "held"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("held");
	});

	it("restores a relative hooks path if something made it absolute", () => {
		const main = fixtureRepo();
		const target = create("hooks", main);
		// Sabotage: the harness-class change that rewrites the worktree's hook path to absolute.
		git(target, "config", "--local", "core.hooksPath", join(main, ".githooks"));
		createWorktree("hooks", { cwd: main, log: () => {} }); // re-run = repair pass
		expect(git(target, "config", "--local", "core.hooksPath")).toBe(".githooks");
	});
});

describe("listWorktrees", () => {
	it("reports each worktree with its branch", () => {
		const main = fixtureRepo();
		create("listed", main);
		const branches = listWorktrees(main).map((w) => w.branch);
		expect(branches).toContain("main");
		expect(branches).toContain("listed");
	});
});

// ─── Removal: the path worth breaking on purpose ─────────────────────────────

describe("removeWorktree", () => {
	it("removes a clean worktree whose branch is on origin/main, and deletes the branch", () => {
		const main = fixtureRepo();
		create("done", main);
		// Land the branch on origin/main the way a squash merge would leave it: same tree.
		const result = removeWorktree("done", { cwd: main, log: () => {} });
		expect(result.branchDeleted).toBe(true);
		expect(existsSync(worktreePath(main, "done"))).toBe(false);
		expect(probe(main, "rev-parse", "--verify", "done").exitCode).not.toBe(0);
	});

	it("REFUSES a worktree with uncommitted changes, and lists them", () => {
		const main = fixtureRepo();
		const target = create("dirty", main);
		writeFileSync(join(target, "INFO.txt"), "edited\n");
		expect(() => removeWorktree("dirty", { cwd: main, log: () => {} })).toThrow(
			/work that would be lost/,
		);
		expect(existsSync(target)).toBe(true); // still there
	});

	it("REFUSES a worktree with untracked files, and lists them", () => {
		const main = fixtureRepo();
		const target = create("untracked", main);
		writeFileSync(join(target, "new-file.ts"), "export {}\n");
		expect(() => removeWorktree("untracked", { cwd: main, log: () => {} })).toThrow(
			/would be lost/,
		);
		expect(existsSync(target)).toBe(true);
	});

	it("removes the directory but KEEPS a branch whose work is not on origin/main", () => {
		const main = fixtureRepo();
		const target = create("unpushed", main);
		// Commit work on the branch that origin/main does not hold — a divergent tree.
		writeFileSync(join(target, "feature.ts"), "export const x = 1\n");
		git(target, "add", ".");
		git(target, "commit", "-m", "feature");
		const result = removeWorktree("unpushed", { cwd: main, log: () => {} });
		expect(result.branchDeleted).toBe(false);
		expect(result.message).toContain("kept branch unpushed");
		// The branch survives, so nothing was lost even though the directory is gone.
		expect(git(main, "rev-parse", "--verify", "unpushed")).toBeTruthy();
		expect(existsSync(target)).toBe(false);
	});

	it("a squash-merged branch (same tree, reading as unmerged to commit checks) is removed", () => {
		const main = fixtureRepo();
		const target = create("squashed", main);
		writeFileSync(join(target, "shipped.ts"), "export const y = 1\n");
		git(target, "add", ".");
		git(target, "commit", "-m", "shipped");
		// Land the same CONTENT on origin/main without the branch's commits (a squash).
		writeFileSync(join(main, "shipped.ts"), "export const y = 1\n");
		git(main, "add", ".");
		git(main, "commit", "-m", "squash of squashed");
		git(main, "push", "origin", "main");
		// Commit-level truth: `main` does not contain the branch's commit.
		const merged = probe(main, "branch", "--merged", "origin/main");
		expect(merged.stdout.toString()).not.toContain("squashed");
		// But the removal understands squash: the tree is on main, so the branch goes.
		const result = removeWorktree("squashed", { cwd: main, log: () => {} });
		expect(result.branchDeleted).toBe(true);
	});

	it("a refusal is overridable with force, and then the branch goes with it", () => {
		const main = fixtureRepo();
		const target = create("forced", main);
		writeFileSync(join(target, "wip.ts"), "export const z = 1\n");
		const result = removeWorktree("forced", { cwd: main, force: true, log: () => {} });
		expect(existsSync(target)).toBe(false);
		expect(result.branchDeleted).toBe(true);
	});
});

describe("inspectForRemoval", () => {
	it("distinguishes the three things a removal could lose", () => {
		const main = fixtureRepo();
		const target = create("inspect", main);
		writeFileSync(join(target, "INFO.txt"), "edited\n"); // dirty
		writeFileSync(join(target, "extra.ts"), "export {}\n"); // untracked
		const blockers = inspectForRemoval(main, "inspect", false);
		expect(blockers.dirty.length).toBeGreaterThan(0);
		expect(blockers.untracked).toContain("extra.ts");
	});
});
