// SPDX-License-Identifier: Apache-2.0
/**
 * The verify stamp's contract, unit-tested and driven for real through the CLI.
 *
 * The stamp is the pre-push hook's reason to SKIP the suite, so every test that matters is
 * one where the stamp must not exist: a dirty tracked tree, a stale stamp, an unknown head.
 * A stamp the hook wrongly trusts is a gate that turns itself off — the same category of
 * failure as the empty-ref-list skip that once let a lint-red main accept a push. The
 * Makefile assertions keep the plumbing (`verify` → `heavy-run.sh` → `verify-inner`, the
 * stamp write at the end) from decaying separately, since nothing else pairs the pieces.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkStamp, stampAge, stampFileFor, writeStamp } from "./verify-stamp.ts";

const REPO_ROOT = join(import.meta.dir, "..");

let dir: string;
let repo: string;
let stamps: string;

const SANDBOX_ENV = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !key.startsWith("GIT_") && key !== "CI" && key !== "ANTHERS_VERIFY_STAMPS",
	),
);

function git(...args: string[]): string {
	const res = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		env: SANDBOX_ENV,
	});
	if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
	return res.stdout.toString().trim();
}

function commit(file: string, content: string): string {
	const abs = join(repo, file);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	git("add", file);
	git("commit", "-q", "-m", "change");
	return git("rev-parse", "HEAD");
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "verify-stamp-"));
	repo = join(dir, "repo");
	stamps = join(dir, "stamps");
	mkdirSync(repo);
	Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		env: SANDBOX_ENV,
	});
	git("config", "user.email", "stamp-test@example.invalid");
	git("config", "user.name", "Stamp Test");
	commit("code.ts", "export const initial = true;\n");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writeStamp", () => {
	it("stamps a clean tracked tree at its head", async () => {
		const head = commit("code.ts", "export const a = 1;\n");
		expect(writeStamp({ cwd: repo, dir: stamps })).toBe(true);
		const file = stampFileFor(head, { dir: stamps });
		expect(await Bun.file(file).exists()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain(head);
	});

	it("does not stamp a tree with uncommitted tracked changes", () => {
		const head = commit("code.ts", "export const a = 2;\n");
		writeFileSync(join(repo, "code.ts"), "export const a = 3;\n");
		expect(writeStamp({ cwd: repo, dir: stamps })).toBe(false);
		expect(existsSync(stampFileFor(head, { dir: stamps }))).toBe(false);
	});

	it("stamps around untracked files, which the pushed tree never carries", () => {
		// Coming out of the dirty test above: restore the tracked file and leave only an
		// untracked scratch file behind — untracked is tolerated, and the tracked-clean
		// property is the deciding one, not the whole status.
		git("checkout", "-q", "code.ts");
		writeFileSync(join(repo, "scratch.pid"), "untracked\n");
		expect(writeStamp({ cwd: repo, dir: stamps })).toBe(true);
	});

	it("writes nothing when there is no commit beneath the cwd", () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "verify-stamp-none-"));
		try {
			expect(writeStamp({ cwd: elsewhere, dir: stamps })).toBe(false);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("prunes stamps older than the window while writing, so the directory cannot grow forever", () => {
		const staleFile = join(stamps, `${"0".repeat(40)}stale`);
		writeFileSync(staleFile, "expired\n");
		// Backdate past the window (24 hours: utimes takes an atime and an mtime).
		const yesterday = new Date(Date.now() - 25 * 60 * 60_000);
		Bun.spawnSync(["touch", "-d", yesterday.toISOString(), staleFile]);
		writeStamp({ cwd: repo, dir: stamps });
		expect(existsSync(staleFile)).toBe(false);
	});
});

describe("checkStamp", () => {
	it("answers ok for a fresh stamp", () => {
		const head = commit("code.ts", "export const fresh = true;\n");
		writeStamp({ cwd: repo, dir: stamps });
		const check = checkStamp(head, { dir: stamps });
		expect(check.ok).toBe(true);
	});

	it("answers missing for an unknown head", () => {
		expect(checkStamp("0".repeat(40), { dir: stamps })).toMatchObject({
			ok: false,
			reason: "missing",
		});
	});

	it("answers expired when the stamp is older than the window", () => {
		const head = commit("code.ts", "export const stale = true;\n");
		writeStamp({ cwd: repo, dir: stamps });
		const later = new Date(Date.now() + (25 * 60 + 1) * 60_000);
		expect(checkStamp(head, { dir: stamps, now: later })).toMatchObject({
			ok: false,
			reason: "expired",
		});
	});

	it("answers nothing-ok for an empty head rather than guessing", () => {
		expect(checkStamp("", { dir: stamps })).toMatchObject({ ok: false, reason: "missing" });
	});
});

describe("stampAge", () => {
	const now = new Date("2026-10-09T12:00:00Z");
	it("counts minutes while the wait is short", () => {
		expect(stampAge(new Date(now.getTime() - 5 * 60_000), now)).toBe("5 minutes ago");
	});
	it("crosses to hours past an hour and a half", () => {
		expect(stampAge(new Date(now.getTime() - 120 * 60_000), now)).toBe("2 hours ago");
	});
});

describe("the CLI the hook calls", () => {
	it("check exits 0 only when a fresh stamp exists", async () => {
		const head = commit("code.ts", "export const cli = true;\n");
		writeStamp({ cwd: repo, dir: stamps });
		const ok = Bun.spawnSync(
			[process.execPath, "run", join(REPO_ROOT, "scripts", "verify-stamp.ts"), "check", head],
			{
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...SANDBOX_ENV, ANTHERS_VERIFY_STAMPS: stamps },
			},
		);
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toContain("green");

		const unknown = Bun.spawnSync(
			[
				process.execPath,
				"run",
				join(REPO_ROOT, "scripts", "verify-stamp.ts"),
				"check",
				"0".repeat(40),
			],
			{
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...SANDBOX_ENV, ANTHERS_VERIFY_STAMPS: stamps },
			},
		);
		expect(unknown.exitCode).toBe(1);
	});

	it("write stamps the cwd's head through the CLI", () => {
		const head = commit("code.ts", "export const cliWrite = true;\n");
		const res = Bun.spawnSync(
			[process.execPath, "run", join(REPO_ROOT, "scripts", "verify-stamp.ts"), "write"],
			{
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...SANDBOX_ENV, ANTHERS_VERIFY_STAMPS: stamps },
			},
		);
		expect(res.exitCode).toBe(0);
		expect(existsSync(stampFileFor(head, { dir: stamps }))).toBe(true);
	});
});

describe("the Makefile's plumbing", () => {
	const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
	const recipe = (target: string) =>
		makefile.match(new RegExp(`^${target}:.*\\n((?:\\t.*\\n)+)`, "m"))?.[1] ?? "";

	it("routes verify through the heavy-run wrapper into an inner body", () => {
		expect(recipe("verify")).toContain("heavy-run.sh");
		expect(recipe("verify")).toContain("verify-inner");
	});

	it("verify-inner still runs the whole suite, and stamps at the end", () => {
		const inner = recipe("verify-inner");
		for (const step of [
			"typecheck",
			"lint",
			"econ:figures",
			"lex:check",
			"db:snapshots",
			"promote-version",
			"bun test",
			"playwright test",
		]) {
			expect(inner).toContain(step);
		}
		expect(inner.indexOf("bun test")).toBeLessThan(inner.indexOf("playwright test"));
		expect(inner.trimEnd().endsWith("verify-stamp.ts write")).toBe(true);
	});

	it("the browser targets route through the same lock", () => {
		for (const target of ["test-e2e", "test-e2e-ui", "test-gauntlet"]) {
			expect(recipe(target)).toContain("heavy-run.sh");
			expect(recipe(target)).toContain(`${target}-inner`);
		}
	});

	it("heavy-run.sh and heavy-run.ts name the same lock path and env default", async () => {
		const sh = readFileSync(join(REPO_ROOT, "scripts", "heavy-run.sh"), "utf8");
		const ts = await Bun.file(join(REPO_ROOT, "scripts", "heavy-run.ts")).text();
		const lock = ".cache/anthers/heavy-run.lock";
		expect(sh.replace(/['"${}]/g, "")).toContain(lock);
		expect(ts).toContain('".cache", "anthers", "heavy-run.lock"');
		for (const env of ["ANTHERS_HEAVY_RUN_HELD", "ANTHERS_HEAVY_RUN_LOCK"]) {
			expect(sh).toContain(env);
			expect(ts).toContain(env);
		}
	});
});
