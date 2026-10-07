// SPDX-License-Identifier: Apache-2.0
/**
 * The droplet heartbeat — the outside view the status page renders.
 *
 * 🚨 **Why an outside view exists at all** (the design this carries): every check a process
 * makes about itself shares a failure domain with that process. When App Platform is the
 * problem — a bad deploy, a wedged build, a load balancer refusing requests — the hub's own
 * `/health` is unreachable *with everything else on it*, and a status page whose outage row
 * comes from the thing that is down renders nothing precisely when a reader needs it to say
 * something. So the check runs on the `anthers.social` droplet, a failure domain App
 * Platform does not share, and its verdict is carried *in* here rather than measured here.
 * If the hub is down, this page goes down with it — the honest cost of declining a
 * vendor-hosted status page — but the droplet's alert email still fires, and alerting was
 * never dependent on the page.
 *
 * **The state model is staleness, deliberately.** The ingest accepts one thing — "I checked
 * at this time, this is what I saw" — and the *reader* of the state decides health from
 * freshness: a heartbeat inside the window is the outside view; one outside it (or none
 * ever) is *unknown*, never *operational*. A monitor that has silently died must not leave
 * a page saying everything is fine forever, which is the failure staleness exists to catch.
 * The window is deliberately wider than the check interval: the point is to notice a dead
 * *monitor* in minutes and a dead *hub* in seconds, and the hub's outage is noticed by the
 * page being down itself regardless of this value.
 *
 * **The secret is one long random token, and it buys almost nothing on its own — the
 * rate limit and the payload cap are what make the route safe.** A guessed secret gets an
 * attacker nothing but a fake "all operational" row, which is the state the page shows
 * only when the *hub* is answering anyway (and a hub answering lies are the CSRF /
 * same-origin problem's, not this one's). The token lives in `.do/app.yaml` as a secret
 * (`HEARTBEAT_TOKEN`), set by the operator alongside every other secret.
 */

import { db } from "@anthers/db/client";
import { errorEvents } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

/** How long since the last report the outside view reads as *unknown* rather than current. */
const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // Ten minutes against a one-minute check cadence.

/** The verdict strings the droplet reports. Deliberately coarse — three states, page rule. */
export type HeartbeatVerdict = "up" | "down" | "degraded";

/** What the ingest is handed, as the droplet's script sends it. */
export interface HeartbeatReport {
	verdict: HeartbeatVerdict;
	/** What the check saw, in the droplet's words — capped, and rendered verbatim when non-null. */
	detail?: string;
	/** ISO timestamp the check *ran*, which may differ from when it arrived. */
	checkedAt?: string;
}

/** What the status service reads back — the outside view of the world. */
export interface HeartbeatState {
	state: "operational" | "degraded" | "down" | "unknown";
	/** ISO timestamp of the newest report; null when none has ever landed. */
	lastReportAt: string | null;
	/** What that report said, human-readable; absent when operational or unknown. */
	detail?: string;
}

/**
 * The key the heartbeat state lives under. 🚨 `error_events` is the wrong table for this and
 * the reason it is used anyway: the heartbeat is one row of org-side state with no natural
 * schema home, and the alternative was a whole table for one key-value pair. The
 * fingerprint carries a shape prefix — `heartbeat:` — so it can never collide with an
 * error fingerprint, and the row doubles as the store's own audit line (count, last-seen).
 */
const HEARTBEAT_FINGERPRINT = "heartbeat:droplet-outside-view";

/** Read the outside view, derived from staleness rather than trusting the verdict alone. */
export async function readHeartbeatState(): Promise<HeartbeatState> {
	try {
		const rows = await db
			.select()
			.from(errorEvents)
			.where(eq(errorEvents.fingerprint, HEARTBEAT_FINGERPRINT))
			.limit(1);
		const row = rows[0];
		if (!row?.lastSeenAt) {
			return { state: "unknown", lastReportAt: null };
		}
		const age = Date.now() - row.lastSeenAt.getTime();
		if (age > HEARTBEAT_STALE_MS) {
			return {
				state: "unknown",
				lastReportAt: row.lastSeenAt.toISOString(),
				detail: "The outside check has not reported recently.",
			};
		}
		const report = (row.sampleContext ?? {}) as HeartbeatReport;
		if (report.verdict === "down") {
			return {
				state: "down",
				lastReportAt: row.lastSeenAt.toISOString(),
				detail: report.detail ?? "The outside check reports the site is not answering.",
			};
		}
		if (report.verdict === "degraded") {
			return {
				state: "degraded",
				lastReportAt: row.lastSeenAt.toISOString(),
				detail: report.detail ?? "The outside check reports degraded responses.",
			};
		}
		return { state: "operational", lastReportAt: row.lastSeenAt.toISOString() };
	} catch (error) {
		// The outside view failing to read is its own "unknown", never a page crash.
		console.error("[heartbeat] read failed:", error instanceof Error ? error.message : error);
		return { state: "unknown", lastReportAt: null };
	}
}

/**
 * Record one heartbeat report. Called by the ingest route after auth; never throws — the
 * droplet's own email path carries the failure story if the hub cannot store the report.
 */
export async function recordHeartbeat(report: HeartbeatReport): Promise<void> {
	const context = {
		verdict: report.verdict,
		...(report.detail ? { detail: report.detail.slice(0, 300) } : {}),
		...(report.checkedAt ? { checkedAt: report.checkedAt } : {}),
	};
	const values = {
		fingerprint: HEARTBEAT_FINGERPRINT,
		source: "api",
		message: "droplet heartbeat",
		release: "",
		sampleContext: context,
	};
	try {
		await db
			.insert(errorEvents)
			.values({ ...values, topFrames: "" })
			.onConflictDoUpdate({
				target: errorEvents.fingerprint,
				set: { lastSeenAt: new Date(), sampleContext: context },
			});
	} catch (error) {
		console.error("[heartbeat] record failed:", error instanceof Error ? error.message : error);
	}
}
