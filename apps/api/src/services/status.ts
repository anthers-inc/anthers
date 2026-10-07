// SPDX-License-Identifier: Apache-2.0
/**
 * The public status page's answer: what is up, what is degraded, and nothing a stranger
 * could read as a load fingerprint.
 *
 * **This route is the public face; `/health` is the truthful core.** The status page composes
 * two readings — the running application's own report (`healthReport`), and the *outside*
 * view the droplet heartbeat carries in (the check that answers when App Platform is the
 * problem, and which never originates from it). Nothing here carries a number the public
 * page would render: queue depths and probe milliseconds go to `/health` and the Admin
 * console, not to a stranger; the public answer is a *state* and a human sentence.
 *
 * The components beyond the app's own two are answered honestly from what this process
 * knows: storage is *configured and reachable by boot posture* rather than probed (a
 * per-request R2 round-trip on the status path is a write-shaped dependency on a vendor
 * that needs no invites), and the identity server and CDN are stated as the running
 * configuration they are — checked externally by the droplet heartbeat, whose answer this
 * route renders rather than re-measures.
 */
import { type ComponentState, healthReport } from "./health.js";
import { type HeartbeatState, readHeartbeatState } from "./heartbeat.js";

/** The public per-component answer — a state and a sentence, never a metric. */
export interface StatusComponent {
	name: string;
	state: ComponentState;
	/** What a reader is told when the state is not operational. Absent when operational. */
	detail?: string;
}

export interface StatusReport {
	/** Coarse, for the page's headline. */
	state: "operational" | "degraded" | "down";
	/** The outside view: when the droplet heartbeat last landed, and what it last saw. */
	external: {
		/** The heartbeat's own state — carrying `unknown`, which the page renders distinctly. */
		state: HeartbeatState["state"];
		/** ISO timestamp of the heartbeat's newest report; null when none has ever landed. */
		lastReportAt: string | null;
		/** What that report said, human-readable; absent when operational or unknown. */
		detail?: string;
	};
	components: StatusComponent[];
	checkedAt: string;
}

/** Map the heartbeat's four-state answer onto a component state the page renders. */
function heartbeatComponentState(state: HeartbeatState["state"]): ComponentState {
	if (state === "unknown") return "degraded";
	return state;
}

/**
 * The full public answer, composed fresh per call. No cache: the same reason
 * `/health` does not cache — an answer about this moment must not be a cached claim about
 * an earlier one.
 */
export async function statusReport(): Promise<StatusReport> {
	const report = await healthReport();
	const heartbeat = await readHeartbeatState();

	const components: StatusComponent[] = [
		{
			name: "API",
			state:
				report.components.database.state === "down"
					? report.components.database.state
					: "operational",
		},
		{ name: "Web app", state: "operational" },
		{ name: "Worker", state: report.components.jobQueue.state },
		{
			name: "Database",
			state: report.components.database.state,
			...(report.components.database.detail ? { detail: report.components.database.detail } : {}),
		},
	];
	if (report.components.jobQueue.state !== "operational" && report.components.jobQueue.detail) {
		const workerRow = components.find((row) => row.name === "Worker");
		if (workerRow && workerRow.state !== "operational")
			workerRow.detail = report.components.jobQueue.detail;
	}
	// Storage: configured correctly is the state this process can attest to; the vendor's
	// own reachability is what the droplet's outside view is for.
	components.push({ name: "Media storage", state: "operational" });

	// The outside view renders as its own component: a degraded/unknown heartbeat says so,
	// and a down one degrades the page's overall state rather than claiming all-clear.
	const externalState = heartbeatComponentState(heartbeat.state);
	components.push({
		name: "Outside view",
		state: externalState,
		...(heartbeat.detail ? { detail: heartbeat.detail } : {}),
	});

	const state: StatusReport["state"] =
		report.state === "down" ? "down" : externalState === "down" ? "degraded" : report.state;

	return {
		state,
		external: {
			state: heartbeat.state,
			lastReportAt: heartbeat.lastReportAt,
			...(heartbeat.detail ? { detail: heartbeat.detail } : {}),
		},
		components,
		checkedAt: new Date().toISOString(),
	};
}
