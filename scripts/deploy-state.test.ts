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
import { commitsOf, type Deployment, readDeployments } from "./deploy-state.js";

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
