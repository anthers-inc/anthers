// SPDX-License-Identifier: Apache-2.0
/**
 * The arm ceremony's tests cover the correctness cores with real fixtures: the landing
 * lock's actual flock behavior, the projected-tip construction's merge order and
 * conflict refusal, the install gate's lockfile-content stamping, the re-arm receipt
 * rule, and the green-gate resolution of radar holds. The GitHub-facing steps
 * (preconditions, reconcile, the arm itself) are exercised by hand against the live
 * repository and recorded in the task body — faking a GitHub layer to test them would
 * test the shim, not the ceremony.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArmEvent,
	constructProjectedTip,
	holdLandingLock,
	installGate,
	isReusableReceipt,
	resolveGreenHolds,
} from "./arm.ts";
import {
	appendEvent,
	type LandingEvent,
	type RadarHoldEvent,
	readEvents,
	unresolvedHolds,
} from "./landing-log.ts";

let root: string;
let repo: string;
let log: string;
let headSha: Record<string, string>;

function arm(branch: string, pr: number, ts: string): ArmEvent {
	return {
		event: "arm",
		ts,
		pr,
		branch,
		head: headSha[branch] ?? "",
		projectedTip: `tip-of-${pr}`,
		reusedGate: false,
	};
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "arm-ceremony-test-"));
	repo = join(root, "repo");
	log = join(root, "events.jsonl");
	mkdirSync(repo, { recursive: true });
	git(["init", "-q", "-b", "main", "."], repo);
	git(["config", "user.email", "test@anthers.test"], repo);
	git(["config", "user.name", "test"], repo);
	write("package.json", "{}\n");
	write("bun.lock", "initial lock\n");
	write("base.txt", "base\n");
	write("shared.txt", "main's answer\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "base"], repo);
	// armed-a: orthogonal work that arms clean over main and the candidate.
	git(["checkout", "-qb", "armed-a"], repo);
	write("a.txt", "a's work\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "a"], repo);
	git(["checkout", "-q", "main"], repo);
	// armed-b: edits shared.txt, which the candidate also edits differently — the
	// construct-conflict case, refused at armed-b's merge into the projection.
	git(["checkout", "-qb", "armed-b"], repo);
	write("shared.txt", "armed-b's answer\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "b"], repo);
	git(["checkout", "-q", "main"], repo);
	// the candidate: edits shared.txt the other way.
	git(["checkout", "-qb", "candidate"], repo);
	write("shared.txt", "the candidate's answer\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "candidate"], repo);
	git(["checkout", "-q", "main"], repo);
	headSha = {
		main: capture(["rev-parse", "main"]),
		"armed-a": capture(["rev-parse", "armed-a"]),
		"armed-b": capture(["rev-parse", "armed-b"]),
		candidate: capture(["rev-parse", "candidate"]),
	};
	// The ceremony composes origin/* refs — it runs after its own fetch — so the
	// fixture gives it a real remote and pushes every branch whose head it names.
	const origin = join(root, "origin.git");
	mkdirSync(origin, { recursive: true });
	git(["init", "-q", "--bare", "."], origin);
	git(["remote", "add", "origin", origin], repo);
	for (const branch of ["main", "armed-a", "armed-b", "candidate"]) {
		git(["push", "-q", "origin", branch], repo);
	}
});

afterAll(() => {
	rmSync(root, { force: true, recursive: true });
});

function git(args: string[], cwd: string): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function capture(args: string[], cwd = repo): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function write(name: string, content: string): void {
	writeFileSync(join(repo, name), content);
}

describe("the arm ceremony", () => {
	test("constructProjectedTip composes origin/main, the armed entries in arm order, and the candidate", () => {
		const gatePath = join(root, "gate-order");
		const built = constructProjectedTip({
			cwd: repo,
			gatePath,
			armed: [arm("armed-a", 1, "2026-10-14T10:00:00.000Z")],
			candidateBranch: "candidate",
		});
		if (!("tip" in built))
			throw new Error(`construction conflicted unexpectedly: ${JSON.stringify(built)}`);
		expect(built.composition).toEqual(["origin/main", "armed-a (#1)", "candidate (candidate)"]);
		// The tip's content carries all three sides: a.txt from armed-a and shared.txt
		// from the candidate, over the base's package.json and bun.lock.
		const aTxt = spawnSync("git", ["show", `${built.tip}:a.txt`], { cwd: repo, encoding: "utf8" });
		expect(aTxt.stdout.trim()).toBe("a's work");
		const shared = spawnSync("git", ["show", `${built.tip}:shared.txt`], {
			cwd: repo,
			encoding: "utf8",
		});
		expect(shared.stdout.trim()).toBe("the candidate's answer");
		expect(existsSync(join(gatePath, ".git"))).toBe(true);
	});

	test("a textual collision the radar missed is refused at construction, naming the entry", () => {
		// A different gate path keeps this test's construction independent of the first
		// test's composed state — each run starts from origin/main by contract.
		const built = constructProjectedTip({
			cwd: repo,
			gatePath: join(root, "gate-order"),
			armed: [arm("armed-b", 2, "2026-10-14T10:01:00.000Z")],
			candidateBranch: "candidate",
		});
		if (!("conflict" in built))
			throw new Error(`expected a conflict, got a clean tip ${JSON.stringify(built)}`);
		// The two edits meet at whichever merge composes both sides — git reports the
		// collision at that merge, armed-b's or the candidate's — so the assertion is
		// about the refusal and the named collision, not the attribution git printed.
		expect(built.conflict.branch).toMatch(/armed-b|candidate/);
	});

	test("the install gate installs for real when the lockfile content moved, and reuses while it has not", () => {
		const gatePath = join(root, "gate-order");
		const cache = join(root, "arm-gate-cache");
		const first = installGate({ gatePath, armGateCache: cache });
		expect(first.install).toBe("real");
		expect(first.error).toBeUndefined();
		const second = installGate({ gatePath, armGateCache: cache });
		expect(second.install).toBe("reused");
		// Move the lockfile's content on an armed branch, push the moved head (the
		// ceremony composes origin/*), re-construct the tip, and the gate must not
		// claim the old install still holds.
		git(["checkout", "-q", "armed-a"], repo);
		write("bun.lock", "changed lock content\n");
		git(["commit", "-qam", "lock move"], repo);
		git(["push", "-q", "origin", "armed-a"], repo);
		const rebuilt = constructProjectedTip({
			cwd: repo,
			gatePath,
			armed: [arm("armed-a", 1, "2026-10-14T10:00:00.000Z")],
			candidateBranch: "candidate",
		});
		if (!("tip" in rebuilt)) throw new Error("reconstruction conflicted unexpectedly");
		const third = installGate({ gatePath, armGateCache: cache });
		expect(third.install).toBe("real");
	});

	test("the landing lock is held across acquires and released by the kernel, with wait and acquire events on the ledger", async () => {
		const first = await holdLandingLock((event) => appendEvent(event, { path: log }), {
			path: join(root, "landing.lock"),
		});
		expect(first).not.toBeNull();
		// Fire the second acquire without awaiting it — it queues on the first holder —
		// then release the first fd by hand, which is what a dying process's kernel
		// release looks like from the waiting side.
		const second = holdLandingLock((event) => appendEvent(event, { path: log }), {
			path: join(root, "landing.lock"),
			pollMs: 50,
		});
		await Bun.sleep(120);
		closeSync(first!);
		const acquired = await second;
		expect(acquired).not.toBeNull();
		const events = readEvents({ path: log }).events.filter(
			(event) => event.event === "lock-wait" || event.event === "lock-acquire",
		);
		expect(events.length).toBeGreaterThanOrEqual(3); // acquire 1; wait + acquire 2
		expect(events.some((event) => event.event === "lock-wait")).toBe(true);
	});

	test("the re-arm receipt skips the gate only when the pushed head and the tip both equal the last arm's", () => {
		const last: ArmEvent = {
			event: "arm",
			ts: "2026-10-14T10:00:00.000Z",
			pr: 1,
			branch: "b",
			head: "h1",
			projectedTip: "t1",
			reusedGate: false,
		};
		expect(isReusableReceipt(last, "h1", "t1")).toBe(true);
		expect(isReusableReceipt(last, "h2", "t1")).toBe(false);
		expect(isReusableReceipt(last, "h1", "t2")).toBe(false);
		expect(isReusableReceipt(undefined, "h1", "t1")).toBe(false);
	});

	test("a green gate resolves the radar holds that named this entry, and only those", () => {
		const holdForThis: Omit<RadarHoldEvent, "ts"> = {
			event: "radar-hold",
			id: "hold-this",
			finding: {
				a: { pr: 7, branch: "candidate", head: "h" },
				b: { pr: 9, branch: "armed-x", head: "h" },
				paths: ["x"],
			},
			blocking: true,
		};
		const holdForOther: Omit<RadarHoldEvent, "ts"> = {
			event: "radar-hold",
			id: "hold-other",
			finding: {
				a: { pr: 8, branch: "other", head: "h" },
				b: { pr: 9, branch: "armed-x", head: "h" },
				paths: ["y"],
			},
			blocking: true,
		};
		appendEvent(holdForThis, { path: log });
		appendEvent(holdForOther, { path: log });
		expect(unresolvedHolds(readEvents({ path: log }).events)).toHaveLength(2);
		resolveGreenHolds(7, [], { path: log });
		const events: LandingEvent[] = readEvents({ path: log }).events;
		expect(unresolvedHolds(events)).toHaveLength(1);
		expect(unresolvedHolds(events)[0]?.id).toBe("hold-other");
		expect(
			events.some((event) => event.event === "hold-resolution" && event.holdId === "hold-this"),
		).toBe(true);
	});
});
