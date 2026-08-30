// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The deployment states `deploy-status` has to tell apart.
 *
 * 🚨 **Every case here is one that only exists for a few minutes, during a deploy.** That
 * is the whole reason the file exists: on 2026-08-25 the drift watch failed and emailed,
 * because "no ACTIVE deployment" and "a deployment of this very commit is DEPLOYING" both
 * read to it as *"the push succeeded, nothing deployed"*. The fix was written while that
 * state was visible on the real API and could not be run against it, because the deploy
 * finished first. These fixtures are how those branches get exercised at all.
 */
import { describe, expect, it } from "bun:test";
import {
	branchName,
	commitsOf,
	type Deployment,
	promoteCommand,
	RUN_PENDING_STATUSES,
	readDeployments,
	readWorkflowRuns,
	repoSlugFromRemote,
	type WorkflowRun,
} from "./deploy-state.js";

const REF = "026ef6525812ad9371d3a74ce2b608866bba59ae";
const OLD = "1faf3948c43409c87b5b3ef1b5fb7f6f4d10bba9";

function deployment(phase: string, commits: string[], id = phase.toLowerCase()): Deployment {
	return {
		id,
		cause: "manual",
		phase,
		created_at: "2026-08-25T19:45:17Z",
		// Spread across kinds the way App Platform really does — api is a service, web a
		// static site, worker a worker, migrate a job — so a reader of this fixture sees
		// the shape the collector actually walks.
		services: commits[0] ? [{ name: "api", source_commit_hash: commits[0] }] : [],
		static_sites: commits[1] ? [{ name: "web", source_commit_hash: commits[1] }] : [],
		workers: [],
		jobs: [],
	};
}

describe("Collecting a deployment's commits", () => {
	it("returns one commit when every component built from the same thing", () => {
		expect(commitsOf(deployment("ACTIVE", [REF, REF]))).toEqual([REF]);
	});

	it("returns both when components disagree, so a partial failure cannot hide", () => {
		expect(commitsOf(deployment("ACTIVE", [REF, OLD])).sort()).toEqual([REF, OLD].sort());
	});

	it("ignores a component with no commit hash rather than inventing one", () => {
		expect(commitsOf(deployment("ACTIVE", []))).toEqual([]);
	});
});

describe("Mid-deploy, when there is no ACTIVE deployment at all", () => {
	// 🚨 The exact state that produced the false alarm: App Platform reports the previous
	// deployment as SUPERSEDED and the new one as DEPLOYING, and for a window there is
	// nothing ACTIVE. The old code exited 1 here before any comparison happened.
	const mid = [deployment("DEPLOYING", [REF, REF]), deployment("SUPERSEDED", [OLD, OLD], "old")];

	it("reports no active deployment without treating that as a verdict", () => {
		const s = readDeployments(mid, REF);
		expect(s.active).toBeNull();
		expect(s.liveCommits).toEqual([]);
	});

	it("recognizes that the commit deploying is the one we asked about", () => {
		expect(readDeployments(mid, REF).inFlightIsRef).toBe(true);
	});

	it("does NOT claim it when something else is deploying", () => {
		const s = readDeployments(mid, OLD);
		expect(s.inFlight).not.toBeNull();
		expect(s.inFlightIsRef).toBe(false);
	});
});

describe("An in-flight deployment that is only half built", () => {
	it("is never treated as the ref deploying, even when it contains the ref", () => {
		// One component on the new commit, one still on the old. Reading this as "the ref
		// is on its way" would let a partial failure look like ordinary progress — the one
		// misreading that costs an outage rather than an email.
		const s = readDeployments([deployment("BUILDING", [REF, OLD])], REF);
		expect(s.inFlightCommits).toHaveLength(2);
		expect(s.inFlightIsRef).toBe(false);
	});
});

describe("Every phase App Platform uses on the way up", () => {
	for (const phase of ["PENDING_BUILD", "BUILDING", "PENDING_DEPLOY", "DEPLOYING"]) {
		it(`counts ${phase} as in flight`, () => {
			expect(readDeployments([deployment(phase, [REF, REF])], REF).inFlight).not.toBeNull();
		});
	}

	for (const phase of ["SUPERSEDED", "ERROR", "CANCELED"]) {
		it(`does not count ${phase} as in flight`, () => {
			expect(readDeployments([deployment(phase, [REF, REF])], REF).inFlight).toBeNull();
		});
	}
});

describe("The ordinary steady state", () => {
	it("finds the serving commit and nothing in flight", () => {
		const s = readDeployments(
			[deployment("ACTIVE", [REF, REF]), deployment("SUPERSEDED", [OLD, OLD], "old")],
			REF,
		);
		expect(s.liveCommits).toEqual([REF]);
		expect(s.inFlight).toBeNull();
		expect(s.inFlightIsRef).toBe(false);
	});

	it("still reports a stale ACTIVE with nothing in flight — a real finding, not a window", () => {
		const s = readDeployments([deployment("ACTIVE", [OLD, OLD])], REF);
		expect(s.liveCommits).toEqual([OLD]);
		expect(s.inFlight).toBeNull();
		// Nothing is deploying, so nothing softens this. It is the case the watch exists for.
		expect(s.inFlightIsRef).toBe(false);
	});
});

describe("The layer DigitalOcean cannot see — CI's own run for the commit", () => {
	/*
	 * 🚨 This is the gap the earlier fix left behind, one layer along. Teaching the script
	 * about deployments already in flight AT DigitalOcean fixed the window after `deploy`
	 * runs; this is the window before it. On 2026-08-26 that was about six minutes, because
	 * `deploy` waits on `test`, `browser`, `browser-media` and `images` — and for all six of
	 * them the script printed "Nothing is in flight — this is a real stale build".
	 */
	const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
		head_sha: REF,
		status: "in_progress",
		conclusion: null,
		name: "CI",
		...over,
	});

	it("sees a run that has not finished, for every status GitHub uses before one has", () => {
		for (const status of [...RUN_PENDING_STATUSES]) {
			const seen = readWorkflowRuns([run({ status })], REF);
			expect(seen.pending?.status, status).toBe(status);
			expect(seen.failed).toBeNull();
		}
	});

	it("🚨 ignores a run for a different commit, which is not evidence about this one", () => {
		// The failure this prevents: an unrelated run on another branch explaining away a
		// genuinely stale build, which is the same shape of error as reading a half-built
		// deployment as normal progress.
		const seen = readWorkflowRuns([run({ head_sha: OLD })], REF);
		expect(seen.pending).toBeNull();
		expect(seen.failed).toBeNull();
	});

	it("⭐ separates a failed run from no run at all, because they need different answers", () => {
		// "CI ran for this commit and failed" is the most useful thing this branch can say,
		// and it was the one thing it could not say before.
		const failed = readWorkflowRuns(
			[run({ status: "completed", conclusion: "failure", html_url: "https://x/1" })],
			REF,
		);
		expect(failed.failed?.html_url).toBe("https://x/1");
		expect(failed.pending).toBeNull();

		expect(readWorkflowRuns([], REF)).toEqual({ pending: null, failed: null });
	});

	it("does not call a successful run a failure", () => {
		const seen = readWorkflowRuns([run({ status: "completed", conclusion: "success" })], REF);
		expect(seen.failed).toBeNull();
		expect(seen.pending).toBeNull();
	});

	it("prefers the unfinished run when an earlier one for the same commit failed", () => {
		// A re-run after a failure is the ordinary case, and reporting the old failure while
		// the new attempt is mid-flight would send somebody to a dead run.
		const seen = readWorkflowRuns(
			[run({ status: "completed", conclusion: "failure" }), run({ status: "in_progress" })],
			REF,
		);
		expect(seen.pending?.status).toBe("in_progress");
	});
});

describe("The commands this tool tells you to run", () => {
	/*
	 * 🚨 A recovery line that does not run is worse than none, because it teaches people to
	 * stop reading the output of the one tool whose job is being trusted about production.
	 * This shipped broken on 2026-08-29: the refs defaulted to remote-tracking names in the
	 * morning and the promote suggestion became `git push origin origin/main:origin/release`,
	 * which promotes nothing and would create a remote branch called `origin/release`.
	 */
	it("🚨 promotes with branch names, never with remote-tracking ones", () => {
		expect(promoteCommand("origin/main", "origin/release")).toBe("git push origin main:release");
		expect(promoteCommand("main", "release")).toBe("git push origin main:release");
		expect(promoteCommand("refs/heads/main", "refs/heads/release")).toBe(
			"git push origin main:release",
		);
	});

	it("strips only the leading remote, so a branch that contains one survives", () => {
		// `feature/origin-move` is a real branch name shape, and eating the middle of it
		// would produce a command that pushes somewhere nobody asked for.
		expect(branchName("feature/origin-move")).toBe("feature/origin-move");
		expect(branchName("origin/feature/origin-move")).toBe("feature/origin-move");
	});
});

describe("Finding the repository to ask about", () => {
	it("reads both remote forms, because a laptop and a runner disagree about which they get", () => {
		for (const url of [
			"git@github.com:anthers-inc/anthers.git",
			"https://github.com/anthers-inc/anthers.git",
			"https://github.com/anthers-inc/anthers",
			"  git@github.com:anthers-inc/anthers.git\n",
		]) {
			expect(repoSlugFromRemote(url), url).toBe("anthers-inc/anthers");
		}
	});

	it("returns nothing for a remote that is not GitHub, rather than a wrong guess", () => {
		expect(repoSlugFromRemote("git@gitlab.com:someone/thing.git")).toBe("");
		expect(repoSlugFromRemote("")).toBe("");
	});
});
