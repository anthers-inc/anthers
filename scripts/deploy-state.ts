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
