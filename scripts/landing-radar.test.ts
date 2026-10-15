// SPDX-License-Identifier: Apache-2.0
/**
 * The radar's tests run real `git merge-tree` calls against real fixture repositories —
 * the conflict parser's contract is pinned on the local git's output format, so the
 * integration tests are the re-pinning notice that file's docblock asks for. GitHub is
 * never contacted (prs are injected, `useGh` off), and nothing is fetched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, type RadarRunEvent, readEvents } from "./landing-log.ts";
import {
	authorityMode,
	type GhPr,
	inFlightEntries,
	pairwise,
	RADAR_HOLD_BLOCKING,
	type RadarReport,
	radarCli,
	runRadar,
} from "./landing-radar.ts";

let root: string;
let repo: string;
let log: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "landing-radar-test-"));
	repo = join(root, "repo");
	log = join(root, "events.jsonl");
	mkdirSync(repo, { recursive: true });
	git(["init", "-q", "-b", "main", "."], repo);
	git(["config", "user.email", "test@anthers.test"], repo);
	git(["config", "user.name", "test"], repo);
	// The base everyone shares.
	write(repo, "file.txt", "base line\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "base"], repo);
	// Both sides of the collision must have touched the file — one side's edit merges
	// cleanly onto an untouched base, which is the negative case the cleaner branch
	// already covers.
	git(["checkout", "-qb", "conflicter"], repo);
	write(repo, "file.txt", "conflicter line\n");
	git(["commit", "-qam", "conflicter"], repo);
	// A branch that never collides: its own file only.
	git(["checkout", "-q", "main"], repo);
	write(repo, "file.txt", "main line\n");
	git(["commit", "-qam", "main edit"], repo);
	git(["checkout", "-qb", "cleaner"], repo);
	write(repo, "clean.txt", "clean and alone\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "cleaner"], repo);
	// Worktrees so each branch is an in-flight *local* entry; the primary worktree
	// checkout is main, so main is in the set too.
	git(["checkout", "-q", "main"], repo);
	git(["worktree", "add", "-q", join(root, "wt-conflicter"), "conflicter"], repo);
	git(["worktree", "add", "-q", join(root, "wt-cleaner"), "cleaner"], repo);
});

afterAll(() => {
	rmSync(root, { force: true, recursive: true });
});

function git(args: string[], cwd: string): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function write(cwd: string, name: string, content: string): void {
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, name), content);
}

function capture(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function radar(options: Partial<Parameters<typeof runRadar>[0]> = {}): RadarReport {
	return runRadar({ cwd: repo, fetch: false, useGh: false, logPath: log, ...options });
}

describe("the radar", () => {
	test("the authority is shadow until the flip commit edits the constant", () => {
		expect(RADAR_HOLD_BLOCKING).toBe(false);
		expect(authorityMode()).toBe("shadow");
	});

	test("a colliding entry is a finding against every entry whose history edited the same file, and clean pairs are findings-less", () => {
		const report = radar({ mode: "blocking" });
		expect(report.mode).toBe("blocking");
		const branches = report.entries.map((entry) => entry.branch).sort();
		expect(branches).toEqual(["cleaner", "conflicter", "main"]);
		expect(report.errors).toEqual([]);
		// Both findings name files both sides edited from the shared base: conflicter
		// against main (direct edit/edits on file.txt) and conflicter against cleaner
		// (cleaner inherited main's edit in its history). cleaner against main is clean.
		expect(report.findings).toHaveLength(2);
		const onMain = report.findings.find((finding) => finding.b.branch === "main")!;
		expect(onMain.a.branch).toBe("conflicter");
		expect(onMain.paths).toEqual(["file.txt"]);
		const onCleaner = report.findings.find((finding) => finding.b.branch === "conflicter")!;
		expect(onCleaner.a.branch).toBe("cleaner");
		expect(onCleaner.paths).toEqual(["file.txt"]);
	});

	test("the same pair is one finding regardless of entry order — the report is symmetric", () => {
		const conflicter = { branch: "conflicter", head: capture(["rev-parse", "conflicter"], repo) };
		const main = { branch: "main", head: capture(["rev-parse", "main"], repo) };
		const forward = pairwise([conflicter, main], repo);
		const reverse = pairwise([main, conflicter], repo);
		expect(forward.findings).toHaveLength(1);
		expect(reverse.findings).toHaveLength(1);
		expect(forward.findings[0]!.paths).toEqual(reverse.findings[0]!.paths);
	});

	test("a pair whose heads cannot be tested is an error in the report, never a silent clean", () => {
		const missing = { branch: "ghost", head: "0".repeat(40) };
		const real = { branch: "cleaner", head: capture(["rev-parse", "cleaner"], repo) };
		const result = pairwise([{ ...real }, { ...missing }], repo);
		expect(result.errors).toHaveLength(1);
		expect(result.findings).toHaveLength(0);
		expect(result.errors[0]!.a.branch).toBe("cleaner");
		expect(result.errors[0]!.message).toContain("not something we can merge");
	});

	test("the in-flight union prefers the worktree's head for a branch both sides name, and keeps the pr", () => {
		const prs: GhPr[] = [
			{ number: 700, headRefName: "shared-branch", headRefOid: "a".repeat(40) },
			{ number: 701, headRefName: "remote-only", headRefOid: "b".repeat(40) },
		];
		const worktree = [{ branch: "shared-branch", head: "c".repeat(40) }];
		const union = inFlightEntries(prs, worktree);
		expect(union).toHaveLength(2); // shared-branch (both sides) and remote-only (pr side only)
		const shared = union.find((entry) => entry.branch === "shared-branch")!;
		expect(shared.head).toBe("c".repeat(40));
		expect(shared.pr).toBe(700);
		const remoteOnly = union.find((entry) => entry.branch === "remote-only")!;
		expect(remoteOnly.head).toBe("b".repeat(40));
	});

	test("armed entries carry their arm-order rank from the ledger", () => {
		appendEvent(
			{
				event: "arm",
				ts: "2026-10-14T10:00:00.000Z",
				pr: 42,
				branch: "cleaner",
				head: "head-42",
				projectedTip: "tip-a",
				reusedGate: false,
			},
			{ path: log },
		);
		appendEvent(
			{
				event: "arm",
				ts: "2026-10-14T10:01:00.000Z",
				pr: 43,
				branch: "conflicter",
				head: "head-43",
				projectedTip: "tip-b",
				reusedGate: false,
			},
			{ path: log },
		);
		const report = radar({
			prs: [
				{ number: 42, headRefName: "cleaner", headRefOid: "1".repeat(40) },
				{ number: 43, headRefName: "conflicter", headRefOid: "2".repeat(40) },
			],
		});
		const cleaner = report.entries.find((entry) => entry.branch === "cleaner")!;
		const conflicter = report.entries.find((entry) => entry.branch === "conflicter")!;
		expect(cleaner.armedRank).toBe(1);
		expect(conflicter.armedRank).toBe(2);
		// main has no pr and no arm, so no rank.
		const main = report.entries.find((entry) => entry.branch === "main")!;
		expect(main.armedRank).toBeNull();
	});

	// The CLI records every run on the ledger under its scope — `hand` when the caller
	// passes none, `probe` when the finisher's probe does — and refuses an unknown
	// scope before running anything.
	test("the CLI records its run under --scope, or as a hand run by default, and refuses an unknown scope before running anything", () => {
		const readLedger = () =>
			readEvents({ path: log }).events.filter(
				(event): event is RadarRunEvent => event.event === "radar-run",
			);
		expect(
			radarCli(["--no-fetch"], { logPath: log, runOptions: { cwd: repo, useGh: false } }),
		).toBe(0);
		const hand = readLedger().at(-1);
		expect(hand?.scope).toBe("hand");
		expect(
			radarCli(["--no-fetch", "--scope", "probe"], {
				logPath: log,
				runOptions: { cwd: repo, useGh: false },
			}),
		).toBe(0);
		const probe = readLedger().at(-1);
		expect(probe?.scope).toBe("probe");
		expect(probe?.entries.length).toBeGreaterThan(0);
		const before = readLedger().length;
		expect(
			radarCli(["--no-fetch", "--scope", "everywhere"], {
				logPath: log,
				runOptions: { cwd: repo, useGh: false },
			}),
		).toBe(64);
		expect(readLedger().length).toBe(before);
	});
});
