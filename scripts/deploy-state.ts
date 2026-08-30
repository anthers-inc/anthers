// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reading a DigitalOcean deployment list, as a pure function.
 *
 * 🚨 **This exists because the interesting states are the ones you cannot reproduce on
 * demand.** `deploy-status.ts` gets its answer from a live API, and the states that
 * matter most — no ACTIVE deployment mid-rebuild, a deployment in flight for the wrong
 * SHA — last a few minutes and only during a deploy. On 2026-08-25 a fix for exactly
 * those states was written while one was observable and could not be *run* against it,
 * because the window closed first. A tool whose job is telling you whether production
 * is right should not have branches nobody has ever executed.
 *
 * So the decision is here, taking a list and a commit and returning what it sees, with
 * no doctl, no git and no printing. `deploy-status.ts` keeps the I/O and the exit codes.
 */

export type Deployment = {
	id: string;
	cause: string;
	phase: string;
	created_at: string;
	services?: { name?: string; source_commit_hash?: string }[];
	static_sites?: { name?: string; source_commit_hash?: string }[];
	workers?: { name?: string; source_commit_hash?: string }[];
	jobs?: { name?: string; source_commit_hash?: string }[];
};

/** Every component kind that can carry a `source_commit_hash`. */
export const COMPONENT_KINDS = ["services", "static_sites", "workers", "jobs"] as const;

/**
 * The phases App Platform reports while a deployment is still on its way up.
 *
 * 🚨 **These are why the script used to be confidently wrong for minutes after every
 * push.** It selected `phase === "ACTIVE"` and discarded the rest, so a deployment of
 * the *exact commit being compared against* was invisible — and it reported "the push
 * succeeded, nothing deployed" while that deployment was mid-flight. The hourly drift
 * watch turned that into a failing run and an email on 2026-08-25.
 */
export const IN_FLIGHT_PHASES = new Set([
	"PENDING_BUILD",
	"BUILDING",
	"PENDING_DEPLOY",
	"DEPLOYING",
]);

/** The distinct commit hashes a deployment's components were built from. */
export function commitsOf(deployment: Deployment): string[] {
	const out = new Set<string>();
	for (const kind of COMPONENT_KINDS) {
		for (const c of deployment[kind] ?? []) {
			if (c.source_commit_hash && c.source_commit_hash.length >= 7) out.add(c.source_commit_hash);
		}
	}
	return [...out];
}

export interface DeploySituation {
	/** The serving deployment, or null — which is NORMAL for part of every deploy. */
	active: Deployment | null;
	/** Distinct commits the ACTIVE deployment was built from. More than one is a partial failure. */
	liveCommits: string[];
	/** The deployment on its way up, if any. */
	inFlight: Deployment | null;
	inFlightCommits: string[];
	/**
	 * Is the thing deploying exactly the thing we asked about?
	 *
	 * ⚠️ **False when the in-flight deployment reports more than one commit.** A
	 * half-built deployment that happens to include the ref is not "the ref is
	 * deploying" — treating it as such would let a partial failure read as normal
	 * progress, which is the one reading that costs a real outage.
	 */
	inFlightIsRef: boolean;
}

/**
 * `owner/repo` out of a git remote URL, or "" when it is not a GitHub one.
 *
 * Handles both forms this repo is cloned with — `git@github.com:owner/repo.git` and
 * `https://github.com/owner/repo` — because the check runs on a laptop and on a runner
 * and the two disagree about which one they get.
 */
export function repoSlugFromRemote(url: string): string {
	return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? "";
}

/**
 * A GitHub Actions run, as the REST API reports it. Only the fields we read.
 *
 * 🚨 **This is the layer DigitalOcean cannot see, and not knowing about it is what made
 * the script confidently wrong.** Between a push to `release` and CI's `deploy` job
 * creating a DigitalOcean deployment there is a gap — on 2026-08-26 about six minutes,
 * because `deploy` waits on `test`, `browser`, `browser-media` and `images`. For that
 * whole window App Platform has nothing in flight, and the script read that as proof
 * that nothing was coming.
 */
export type WorkflowRun = {
	head_sha: string;
	/** queued · waiting · requested · pending · in_progress · completed */
	status: string;
	/** success · failure · cancelled · … — null while the run is unfinished. */ // lint-spelling: ignore — GitHub's own conclusion values
	conclusion: string | null;
	name?: string;
	html_url?: string;
};

/** Every status GitHub uses for a run that has not reached a conclusion. */
export const RUN_PENDING_STATUSES = new Set([
	"queued",
	"waiting",
	"requested",
	"pending",
	"in_progress",
]);

export interface CiSituation {
	/** A run for this exact commit that has not finished. The deploy may still be coming. */
	pending: WorkflowRun | null;
	/**
	 * A run for this commit that finished and did not succeed.
	 *
	 * ⭐ Worth separating from *no run at all*, because it turns the least useful message
	 * the script prints into the most useful one: not *"nothing deployed"* but *"CI ran
	 * for this commit and failed, which is why nothing deployed"*, with a link.
	 */
	failed: WorkflowRun | null;
}

/**
 * What GitHub's run list says about one commit. No I/O.
 *
 * ⚠️ **A run for a different commit is not evidence about this one and is ignored.** The
 * caller asks by `head_sha`, but the filter is applied here as well, because a caller
 * that forgets it would otherwise let an unrelated run in another branch explain away a
 * genuinely stale build — the same class of error as treating a half-built deployment as
 * normal progress.
 */
export function readWorkflowRuns(runs: WorkflowRun[], refFull: string): CiSituation {
	const mine = runs.filter((r) => r.head_sha === refFull);
	return {
		pending: mine.find((r) => RUN_PENDING_STATUSES.has(r.status)) ?? null,
		failed:
			mine.find(
				(r) => r.status === "completed" && r.conclusion !== null && r.conclusion !== "success",
			) ?? null,
	};
}

/** What the deployment list says, relative to one commit. No I/O, no opinions about exit codes. */
export function readDeployments(deployments: Deployment[], refFull: string): DeploySituation {
	const active = deployments.find((d) => d.phase === "ACTIVE") ?? null;
	const inFlight = deployments.find((d) => IN_FLIGHT_PHASES.has(d.phase)) ?? null;
	const inFlightCommits = inFlight ? commitsOf(inFlight) : [];
	return {
		active,
		liveCommits: active ? commitsOf(active) : [],
		inFlight,
		inFlightCommits,
		inFlightIsRef: inFlightCommits.length === 1 && inFlightCommits[0] === refFull,
	};
}
