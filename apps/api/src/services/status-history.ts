// SPDX-License-Identifier: Apache-2.0
/**
 * The record behind the status page's uptime bars and Past Incidents section — the one
 * writer of `status_history`, `status_incidents` and `status_incident_updates`.
 *
 * 🚨 **The sampler's transitions are the only writer; no route mutates these tables.**
 * `recordStatusSample` is called by `jobs/status-sample.ts` (every five minutes) with the
 * components of one composed status answer, and it does two things per component: tallies
 * the day bucket, and walks the component's incident window — opening one on the first
 * non-operational sample, recording each state transition as a dated update row,
 * escalating the window's worst severity, and resolving on the first operational sample.
 * This keeps the record a fact the machinery observed, never a claim a page wrote about
 * itself.
 *
 * **The display-name → history-key map is the deliberate fork point.** The status answer
 * renders display names; history rows key stable slugs so a rename in copy does not fork
 * a component's record. A display name missing from `HISTORY_COMPONENTS` is skipped
 * loudly rather than minting a new key by default — the edit that adds one is the
 * decision that a new history key is wanted.
 *
 * ⚠️ **Sampling granularity is the record's grain.** An outage shorter than the cadence
 * never reaches history at all, and both edges of an incident window land at sample
 * times; the minute-level alarm remains the droplet heartbeat's, whose outside check
 * runs on a 1-minute cron and emails on a verdict change. This record is the public
 * history, not the alerting path.
 */

import { db } from "@anthers/db/client";
import { statusHistory, statusIncidents, statusIncidentUpdates } from "@anthers/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ComponentState } from "./health.js";

/** The three states a tracked component answers in, as the health report names them. */
export type TrackedState = ComponentState;

/**
 * Display name → stable history key. 🚨 **The only fork point.** Keys are permanent
 * labels of recorded history: a display rename edits this map's value side, never the
 * key, and a key's retirement is a migration of its rows rather than a map edit. The key
 * for the outside check names what it is (`external-check`) rather than how it renders.
 */
export const HISTORY_COMPONENTS: Record<string, string> = {
	API: "api",
	"Web app": "web",
	Worker: "worker",
	Database: "database",
	"Media storage": "media-storage",
	Website: "external-check",
};

/** The inverse map, for read feeds that must carry the component's display name. */
function labelFor(component: string): string {
	for (const [name, key] of Object.entries(HISTORY_COMPONENTS)) {
		if (key === component) return name;
	}
	return component;
}

/** One sample as the sampler hands it: the composed answer's component rows, verbatim. */
export interface StatusSample {
	name: string;
	state: ComponentState;
	detail?: string;
}

/** The UTC `YYYY-MM-DD` day of a timestamp — the day-bucket convention every tally uses. */
function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

const SEVERITY_RANK: Record<TrackedState, number> = { operational: 0, degraded: 1, down: 2 };

/**
 * Record one sampling pass. Never throws — a failed sampling write is a gap in the
 * record, not an alert, and throwing would poison the worker's error tracker with the
 * sampling that exists to keep track of it. Deliveries are replay-tolerant rather than
 * exactly-once: a re-delivered pass' extra tally is one five-minute grain in a 288-grain
 * day, the honest cost of at-least-once delivery.
 */
export async function recordStatusSample(
	samples: StatusSample[],
	at: Date = new Date(),
): Promise<void> {
	try {
		const day = utcDay(at);
		for (const sample of samples) {
			const component = HISTORY_COMPONENTS[sample.name];
			if (!component) {
				// Loud, not fatal: the record's keys are a maintained list, and a new or
				// renamed component row missing from it is a map edit owed, not a crash.
				console.error(`[status-history] no history key for component "${sample.name}" — skipped`);
				continue;
			}
			await db
				.insert(statusHistory)
				.values({
					component,
					day,
					checks: 1,
					degraded: sample.state === "degraded" ? 1 : 0,
					down: sample.state === "down" ? 1 : 0,
				})
				.onConflictDoUpdate({
					target: [statusHistory.component, statusHistory.day],
					set: {
						checks: sql`${statusHistory.checks} + 1`,
						degraded:
							sample.state === "degraded"
								? sql`${statusHistory.degraded} + 1`
								: statusHistory.degraded,
						down: sample.state === "down" ? sql`${statusHistory.down} + 1` : statusHistory.down,
					},
				});
			await walkIncident(component, sample, at);
		}
	} catch (error) {
		console.error(
			"[status-history] sample recording failed:",
			error instanceof Error ? error.message : error,
		);
	}
}

/** The component's open incident window, if the sampler has one running. */
async function findOpenIncident(component: string) {
	const rows = await db
		.select()
		.from(statusIncidents)
		.where(and(eq(statusIncidents.component, component), isNull(statusIncidents.resolvedAt)))
		.orderBy(desc(statusIncidents.openedAt))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Walk one component's incident window from one sample. Transitions are recorded when
 * the state *changes* rather than on every sample, so the update timeline reads like the
 * incident's story — open, escalate or improve, resolve — not like the ticker it came
 * from. An operational sample with no open window touches nothing, which is the common
 * case and the reason the machinery is two queries on a healthy day.
 */
async function walkIncident(component: string, sample: StatusSample, at: Date): Promise<void> {
	if (sample.state === "operational") {
		const open = await findOpenIncident(component);
		if (!open) return;
		await db.update(statusIncidents).set({ resolvedAt: at }).where(eq(statusIncidents.id, open.id));
		await db
			.insert(statusIncidentUpdates)
			.values({ incidentId: open.id, at, severity: "operational", note: "" });
		return;
	}

	const open = await findOpenIncident(component);
	if (!open) {
		const [incident] = await db
			.insert(statusIncidents)
			.values({ component, severity: sample.state, openedAt: at })
			.returning();
		await db.insert(statusIncidentUpdates).values({
			incidentId: incident.id,
			at,
			severity: sample.state,
			note: sample.detail ?? "",
		});
		return;
	}

	// The window's stored severity is the worst it reached, never downgraded: a window
	// that reached `down` is an outage even when the next sample answered degraded.
	const worsened = SEVERITY_RANK[sample.state] > SEVERITY_RANK[open.severity as TrackedState];
	if (worsened) {
		await db
			.update(statusIncidents)
			.set({ severity: sample.state })
			.where(eq(statusIncidents.id, open.id));
	}
	if (worsened || sample.state !== open.severity) {
		// Record the transition — an escalation, or an improvement still inside the
		// window (down → degraded reads "recovered halfway", which the timeline owes).
		await db.insert(statusIncidentUpdates).values({
			incidentId: open.id,
			at,
			severity: sample.state,
			note: sample.detail ?? "",
		});
	}
}

/**
 * The read feed for the public page: every tracked component's last `windowDays` days as
 * a dense cell array (oldest first, `state: null` where nothing was recorded — the page
 * renders those cells empty rather than inventing an answer), plus availability over the
 * days that were recorded.
 */
export interface HistoryComponent {
	component: string;
	/** The display name the status answer renders this component's rows under. */
	name: string;
	/** Availability over the recorded days: (checks − degraded − down) / checks. Null with no samples at all. */
	uptimePct: number | null;
	/** Exactly `windowDays` cells, oldest first; `null` state is "nothing recorded this day". */
	days: { day: string; state: TrackedState | null }[];
}

export async function statusHistoryFeed(
	windowDays = 90,
	today: Date = new Date(),
): Promise<{ windowDays: number; since: string | null; components: HistoryComponent[] }> {
	// The window is `windowDays` calendar days ending today, so the oldest cell is day 0.
	const cutoffDay = utcDay(new Date(today.getTime() - (windowDays - 1) * 86_400_000));
	const rows = await db.select().from(statusHistory).where(gte(statusHistory.day, cutoffDay));

	const byComponent = new Map<
		string,
		Map<string, { worst: TrackedState; checks: number; lost: number }>
	>();
	for (const row of rows) {
		let perDay = byComponent.get(row.component);
		if (!perDay) {
			perDay = new Map();
			byComponent.set(row.component, perDay);
		}
		const worst: TrackedState =
			row.down > 0 ? "down" : row.degraded > 0 ? "degraded" : "operational";
		perDay.set(row.day, { worst, checks: row.checks, lost: row.degraded + row.down });
	}

	let since: string | null = null;
	const components: HistoryComponent[] = [...byComponent.entries()]
		.map(([component, perDay]) => {
			const days: HistoryComponent["days"] = [];
			let checks = 0;
			let lost = 0;
			for (let i = 0; i < windowDays; i++) {
				const day = utcDay(new Date(today.getTime() - (windowDays - 1 - i) * 86_400_000));
				const bucket = perDay.get(day);
				if (bucket) {
					days.push({ day, state: bucket.worst });
					checks += bucket.checks;
					lost += bucket.lost;
					if (since === null || day < since) since = day;
				} else {
					days.push({ day, state: null });
				}
			}
			return {
				component,
				name: labelFor(component),
				uptimePct: checks > 0 ? ((checks - lost) / checks) * 100 : null,
				days,
			};
		})
		// The page renders rows in the status answer's own order; the map's insertion
		// order is a byproduct — order the feed by the map's declared order instead.
		.sort((a, b) => {
			const keys = Object.values(HISTORY_COMPONENTS);
			return keys.indexOf(a.component) - keys.indexOf(b.component);
		});

	return { windowDays, since, components };
}

/** One incident with its dated updates, as the page renders it. */
export interface IncidentFeedEntry {
	id: number;
	component: string;
	/** The display name, as the page titles the incident. */
	name: string;
	/** The worst state the window reached. */
	severity: Exclude<TrackedState, "operational">;
	openedAt: string;
	/** Null while the incident is ongoing. */
	resolvedAt: string | null;
	updates: { at: string; severity: TrackedState; note: string }[];
}

/** How many incidents a page render answers with — the feed is a summary, not an archive. */
const INCIDENT_FEED_LIMIT = 50;

export async function statusIncidentFeed(
	windowDays = 90,
	today: Date = new Date(),
): Promise<IncidentFeedEntry[]> {
	const cutoff = new Date(today.getTime() - windowDays * 86_400_000);
	const rows = await db
		.select()
		.from(statusIncidents)
		// A resolved incident opened since the window's edge, or any ongoing one however
		// old — the page's "ongoing" answer must not expire out from under itself.
		.where(or(gte(statusIncidents.openedAt, cutoff), isNull(statusIncidents.resolvedAt)))
		.orderBy(desc(statusIncidents.openedAt))
		.limit(INCIDENT_FEED_LIMIT);
	if (rows.length === 0) return [];

	const updates = await db
		.select()
		.from(statusIncidentUpdates)
		.where(
			inArray(
				statusIncidentUpdates.incidentId,
				rows.map((r) => r.id),
			),
		)
		.orderBy(asc(statusIncidentUpdates.at));

	const byIncident = new Map<number, IncidentFeedEntry["updates"]>();
	for (const update of updates) {
		let list = byIncident.get(update.incidentId);
		if (!list) {
			list = [];
			byIncident.set(update.incidentId, list);
		}
		list.push({
			at: update.at.toISOString(),
			severity: update.severity as TrackedState,
			note: update.note,
		});
	}

	return rows.map((row) => ({
		id: row.id,
		component: row.component,
		name: labelFor(row.component),
		severity: row.severity as Exclude<TrackedState, "operational">,
		openedAt: row.openedAt.toISOString(),
		resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
		updates: byIncident.get(row.id) ?? [],
	}));
}

/**
 * The page's one history answer — the window of day states and the incident feed
 * composed together, the shape `GET /api/status/history` returns. Both reads are plain
 * selects over the two small tables the sampler maintains; nothing here is derived from
 * `/health`'s deepened numbers, because the record's grain is already the state word.
 */
export async function statusPageHistory(windowDays = 90): Promise<{
	windowDays: number;
	since: string | null;
	components: HistoryComponent[];
	incidents: IncidentFeedEntry[];
	generatedAt: string;
}> {
	const today = new Date();
	const [history, incidents] = await Promise.all([
		statusHistoryFeed(windowDays, today),
		statusIncidentFeed(windowDays, today),
	]);
	return { ...history, incidents, generatedAt: today.toISOString() };
}

/**
 * Retire the record older than the window. Best effort, logged, never thrown — a missed
 * prune is a row count, never a correctness question. Resolved incidents leave with
 * their updates (the updates' FK cascades); an ongoing one stays regardless of age,
 * because the page's "ongoing" answer must not expire out from under itself.
 */
export async function pruneStatusHistory(windowDays = 90, today: Date = new Date()): Promise<void> {
	try {
		const cutoffDay = utcDay(new Date(today.getTime() - windowDays * 86_400_000));
		await db.delete(statusHistory).where(lt(statusHistory.day, cutoffDay));
		const cutoff = new Date(today.getTime() - windowDays * 86_400_000);
		await db
			.delete(statusIncidents)
			.where(
				and(lt(statusIncidents.openedAt, cutoff), sql`${statusIncidents.resolvedAt} is not null`),
			);
	} catch (error) {
		console.error("[status-history] prune failed:", error instanceof Error ? error.message : error);
	}
}
