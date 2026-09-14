// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-push hook runs the whole suite unless it can PROVE a push changes only markdown.
 *
 * 🚨 **The fast path is a way for the gate to run less, so every test here that matters is one
 * where it must refuse.** The hook has already turned itself off once by treating "git told me
 * nothing" as "there is nothing to check", and a markdown-only shortcut is the same shape of
 * mistake with more ways to make it: a rename that reports only its new `.md` name, a base
 * commit the remote has that this clone does not, a diff that comes back empty. Each of those
 * must land on `make verify`.
 *
 * These drive the real `.githooks/pre-push` against a throwaway repository, with a stub `make`
 * on `PATH` that records the target it was asked for — so nothing here runs the suite, and
 * nothing depends on this checkout's own branches.
 *
 * The second half keeps `make verify-docs` honest: a guard under `scripts/` that reads the
 * repository's markdown and is missing from that target would pass a documentation push that
 * the full suite would have refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK = join(REPO_ROOT, ".githooks", "pre-push");
const ZERO = "0".repeat(40);

let dir: string;
let repo: string;
let stubBin: string;
let makeLog: string;

function git(...args: string[]): string {
	const res = Bun.spawnSync(
		["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
	return res.stdout.toString().trim();
}

/** Commit `files` (path → content, or null to delete) on the current branch; returns the SHA. */
function commit(files: Record<string, string | null>): string {
	for (const [path, content] of Object.entries(files)) {
		if (content === null) git("rm", "-q", path);
		else {
			writeFileSync(join(repo, path), content);
			git("add", path);
		}
	}
	git("commit", "-q", "-m", "change");
	return git("rev-parse", "HEAD");
}

/** Run the hook with these ref lines on stdin; report which `make` target it ran, if any. */
function push(stdin: string, makeExit = 0): { exitCode: number; target: string | null } {
	writeFileSync(makeLog, "");
	const res = Bun.spawnSync(["sh", HOOK, "origin", "git@example.invalid:repo.git"], {
		cwd: repo,
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PATH: `${stubBin}:${process.env.PATH}`,
			STUB_MAKE_EXIT: String(makeExit),
		},
	});
	const logged = readFileSync(makeLog, "utf8").trim();
	return { exitCode: res.exitCode, target: logged === "" ? null : logged };
}

const line = (local: string, remote: string, ref = "refs/heads/topic") =>
	`${ref} ${local} ${ref} ${remote}\n`;

let base: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pre-push-hook-"));
	repo = join(dir, "repo");
	stubBin = join(dir, "bin");
	makeLog = join(dir, "make.log");
	Bun.spawnSync(["mkdir", "-p", repo, stubBin]);
	writeFileSync(
		join(stubBin, "make"),
		`#!/bin/sh\nprintf '%s' "$*" > "${makeLog}"\nexit "$STUB_MAKE_EXIT"\n`,
	);
	chmodSync(join(stubBin, "make"), 0o755);

	git("init", "-q", "-b", "main");
	git("config", "user.email", "hook-test@example.invalid");
	git("config", "user.name", "Hook Test");
	base = commit({ "code.ts": "export const a = 1;\n", "README.md": "# Repo\n" });
	git("update-ref", "refs/remotes/origin/main", base);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the markdown-only fast path", () => {
	it("runs verify-docs for a new branch that changes only markdown", () => {
		git("checkout", "-q", "-b", "docs-new", base);
		const tip = commit({ "README.md": "# Repo\n\nMore.\n", "GUIDE.md": "Hello.\n" });
		expect(push(line(tip, ZERO))).toEqual({ exitCode: 0, target: "verify-docs" });
	});

	it("runs verify-docs for markdown pushed onto a tip the remote already has", () => {
		git("checkout", "-q", "-b", "docs-existing", base);
		const tip = commit({ "README.md": "# Repo\n\nAgain.\n" });
		expect(push(line(tip, base))).toEqual({ exitCode: 0, target: "verify-docs" });
	});

	it("fails the push when verify-docs fails", () => {
		git("checkout", "-q", "-b", "docs-red", base);
		const tip = commit({ "README.md": "# Repo\n\nRed.\n" });
		expect(push(line(tip, base), 2)).toEqual({ exitCode: 1, target: "verify-docs" });
	});
});

describe("everything else runs the whole suite", () => {
	it("a push that touches code as well as markdown", () => {
		git("checkout", "-q", "-b", "mixed", base);
		const tip = commit({ "README.md": "# Mixed\n", "code.ts": "export const a = 2;\n" });
		expect(push(line(tip, base)).target).toBe("verify");
	});

	it("deleting a code file, even with nothing else in the push", () => {
		git("checkout", "-q", "-b", "delete-code", base);
		const tip = commit({ "code.ts": null });
		expect(push(line(tip, base)).target).toBe("verify");
	});

	it("renaming code to markdown, which a rename-aware diff would report as markdown only", () => {
		git("checkout", "-q", "-b", "rename", base);
		git("mv", "code.ts", "code.md");
		git("commit", "-q", "-m", "rename");
		const tip = git("rev-parse", "HEAD");
		expect(push(line(tip, base)).target).toBe("verify");
	});

	it("a remote tip this clone has never fetched", () => {
		git("checkout", "-q", "-b", "unknown-base", base);
		const tip = commit({ "README.md": "# Unknown\n" });
		expect(push(line(tip, "1234567890abcdef1234567890abcdef12345678")).target).toBe("verify");
	});

	it("a new branch when there is no origin/main to measure it from", () => {
		git("checkout", "-q", "-b", "no-origin", base);
		const tip = commit({ "README.md": "# No origin\n" });
		git("update-ref", "-d", "refs/remotes/origin/main");
		try {
			expect(push(line(tip, ZERO)).target).toBe("verify");
		} finally {
			git("update-ref", "refs/remotes/origin/main", base);
		}
	});

	it("a push with nothing new in it, where an empty diff proves nothing", () => {
		expect(push(line(base, base)).target).toBe("verify");
	});

	it("two refs where only one is markdown", () => {
		git("checkout", "-q", "-b", "two-docs", base);
		const docs = commit({ "README.md": "# Two\n" });
		git("checkout", "-q", "-b", "two-code", base);
		const code = commit({ "code.ts": "export const a = 3;\n" });
		const stdin = line(docs, base, "refs/heads/two-docs") + line(code, base, "refs/heads/two-code");
		expect(push(stdin).target).toBe("verify");
	});

	it("an empty ref list, which is not the same as nothing to push", () => {
		expect(push("").target).toBe("verify");
	});

	it("still skips a push of nothing but deletions", () => {
		expect(push(line(ZERO, base))).toEqual({ exitCode: 0, target: null });
	});
});

describe("make verify-docs", () => {
	const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
	const recipe = makefile.match(/^verify-docs:.*\n((?:\t.*\n)+)/m)?.[1] ?? "";

	it("exists, so the hook's fast path has something to run", () => {
		expect(recipe).toContain("bun test");
	});

	it("includes every guard under scripts/ that reads the repository's markdown", async () => {
		const tracked = Bun.spawnSync(["git", "ls-files", "*.md"], { cwd: REPO_ROOT })
			.stdout.toString()
			.trim()
			.split("\n");
		const guards = [...new Bun.Glob("scripts/*.test.ts").scanSync({ cwd: REPO_ROOT })].filter(
			(f) => !f.endsWith("pre-push-hook.test.ts"),
		);
		const readers: string[] = [];
		for (const guard of guards) {
			const source = await Bun.file(join(REPO_ROOT, guard)).text();
			if (source.includes("ls-files") || tracked.some((md) => source.includes(md))) {
				readers.push(guard);
			}
		}
		// A glob that matched nothing would make the loop below vacuous.
		expect(readers.length).toBeGreaterThan(0);
		for (const reader of readers) {
			expect(recipe, `${reader} reads markdown but is not in verify-docs`).toContain(reader);
		}
	});
});
