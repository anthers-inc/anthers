// SPDX-License-Identifier: Apache-2.0
/**
 * The status record's machinery: day-bucket tallies, uptime percentages, and the incident
 * windows the sampler's transitions open, escalate and resolve. Everything walks the real
 * tables in this run's session database; the feeds are read back through the same
 * functions the public route serves.
 *
 * The suite runs in file order against shared rows, so each scenario owns its component's
 * keys and every later read states which earlier rows it is standing on — the arithmetic
 * in the feed test is arithmetic over this suite's own writes, not over a clean slate.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { statusHistory, statusIncidents, statusIncidentUpdates } from "@anthers/db/schema";
import {
	pruneStatusHistory,
	recordStatusSample,
	type StatusSample,
	statusHistoryFeed,
	statusIncidentFeed,
} from "../services/status-history";

/** A fixed "now" the whole suite samples and reads around, so day math never races midnight UTC. */
const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = "2026-10-15";
const EARLIER_DAY = "2026-10-14";

function sample(name: string, state: StatusSample["state"], detail?: string): StatusSample {
	return { name, state, ...(detail ? { detail } : {}) };
}

afterAll(async () => {
	// Every row these cases wrote, on success or failure: the three tables are this
	// suite's own in the session database, so a full wipe is the honest cleanup.
	await db.delete(statusIncidentUpdates);
	await db.delete(statusIncidents);
	await db.delete(statusHistory);
});

describe("recordStatusSample, the day tallies", () => {
	it("buckets one component's samples per UTC day, and tallies states independently of each other", async () => {
		await recordStatusSample([sample("Web app", "operational")], NOW);
		await recordStatusSample([sample("Web app", "degraded")], NOW);
		await recordStatusSample([sample("Web app", "operational")], NOW);
		// A different day, a different bucket row.
		await recordStatusSample([sample("Web app", "down")], new Date(`${EARLIER_DAY}T23:50:00Z`));

		const rows = await db.select().from(statusHistory);
		const today = rows.find((row) => row.component === "web" && row.day === DAY);
		expect(today).toMatchObject({ checks: 3, degraded: 1, down: 0 });
		const earlier = rows.find((row) => row.component === "web" && row.day === EARLIER_DAY);
		expect(earlier).toMatchObject({ checks: 1, degraded: 0, down: 1 });
	});

	it("tallies components independently of each other", async () => {
		// Worker's first row in this suite — the windows describe below builds on it.
		await recordStatusSample([sample("API", "operational"), sample("Worker", "degraded")], NOW);
		const rows = await db.select().from(statusHistory);
		expect(rows.find((row) => row.component === "api")?.degraded).toBe(0);
		expect(rows.find((row) => row.component === "worker")?.degraded).toBe(1);
	});

	it("skips a component with no history key, loudly, and records the rest", async () => {
		await recordStatusSample(
			[sample("Renamed Somewhere", "down"), sample("API", "operational")],
			NOW,
		);
		expect(
			await db
				.select()
				.from(statusHistory)
				.then((rows) => rows.some((row) => row.component === "renamed-somewhere")),
		).toBe(false);
		expect(
			await db
				.select()
				.from(statusHistory)
				.then((rows) => rows.some((row) => row.component === "api")),
		).toBe(true);
	});
});

describe("recordStatusSample, the incident windows", () => {
	it("opens on the first non-operational sample and resolves on the first operational one", async () => {
		const degradedAt = new Date("2026-10-15T10:00:00Z");
		const resolvedAt = new Date("2026-10-15T11:00:00Z");
		await recordStatusSample([sample("Worker", "operational")], NOW); // no window opens
		await recordStatusSample(
			[sample("Worker", "degraded", "The job queue is holding failed jobs.")],
			degradedAt,
		);
		// A repeated state records no transition and no update — the story, not the ticker.
		await recordStatusSample([sample("Worker", "degraded")], new Date("2026-10-15T10:05:00Z"));
		await recordStatusSample([sample("Worker", "operational")], resolvedAt);

		const feed = await statusIncidentFeed(90, NOW);
		const incident = feed.find(
			(entry) => entry.component === "worker" && entry.openedAt === degradedAt.toISOString(),
		);
		expect(incident).toBeDefined();
		expect(incident?.severity).toBe("degraded");
		expect(incident?.resolvedAt).toBe(resolvedAt.toISOString());
		expect(incident?.updates.map((update) => update.severity)).toEqual(["degraded", "operational"]);
		expect(incident?.updates[0]?.note).toBe("The job queue is holding failed jobs.");
	});

	it("escalates to down, keeps the worst severity, and records the improvement before the resolution", async () => {
		await recordStatusSample([sample("Database", "degraded")], new Date("2026-10-15T08:00:00Z"));
		await recordStatusSample(
			[sample("Database", "down", "The database is not answering.")],
			new Date("2026-10-15T08:05:00Z"),
		);
		await recordStatusSample([sample("Database", "degraded")], new Date("2026-10-15T08:10:00Z"));
		await recordStatusSample([sample("Database", "operational")], new Date("2026-10-15T08:15:00Z"));

		const feed = await statusIncidentFeed(90, NOW);
		const incident = feed.find(
			(entry) => entry.component === "database" && entry.resolvedAt !== null,
		);
		expect(incident?.severity).toBe("down");
		expect(incident?.updates.map((update) => update.severity)).toEqual([
			"degraded",
			"down",
			"degraded",
			"operational",
		]);
	});

	it("leaves an ongoing window open, and the feed answers it", async () => {
		await recordStatusSample([sample("Website", "down")], NOW);
		const feed = await statusIncidentFeed(90, NOW);
		const ongoing = feed.find((entry) => entry.component === "external-check");
		expect(ongoing?.resolvedAt).toBeNull();
	});
});

describe("the read feeds", () => {
	it("answers a dense day grid with nulls for unrecorded days, and availability over recorded days only", async () => {
		const feed = await statusHistoryFeed(90, NOW);
		const database = feed.components.find((component) => component.component === "database");
		expect(database?.days.length).toBe(90);
		expect(database?.days[89]?.day).toBe(DAY);
		// Today's worst state, standing on the escalation case above (two degraded
		// samples and one down in four recorded checks).
		expect(database?.days[89]?.state).toBe("down");
		expect(database?.days[0]?.state).toBeNull(); // 89 days before the record began
		// Three lost of four recorded checks for database: 25% uptime.
		expect(database?.uptimePct).toBeCloseTo(25, 5);
		// The earliest day this suite has recorded anything on ("Web app", earlier day).
		expect(feed.since).toBe(EARLIER_DAY);
	});
});

describe("pruneStatusHistory", () => {
	it("deletes recorded days past the window, and resolved incidents, keeping ongoing ones", async () => {
		await recordStatusSample(
			[sample("Media storage", "operational")],
			new Date("2026-06-01T00:00:00Z"),
		);
		await recordStatusSample([sample("Media storage", "operational")], NOW);
		await pruneStatusHistory(90, NOW);
		const days = await db.select().from(statusHistory);
		expect(days.find((row) => row.day === "2026-06-01")).toBeUndefined();
		expect(days.find((row) => row.day === DAY)).toBeDefined();

		// An OLD resolved incident goes, and its updates cascade with it; an ongoing
		// window however old does not, because the page's "ongoing" answer must not
		// expire out from under itself.
		const oldResolved = await db
			.insert(statusIncidents)
			.values({
				component: "api",
				severity: "down",
				openedAt: new Date("2026-05-01T00:00:00Z"),
				resolvedAt: new Date("2026-05-02T00:00:00Z"),
			})
			.returning();
		await db.insert(statusIncidentUpdates).values({
			incidentId: oldResolved[0].id,
			at: oldResolved[0].openedAt,
			severity: "down",
			note: "",
		});
		const oldOngoing = await db
			.insert(statusIncidents)
			.values({
				component: "api",
				severity: "down",
				openedAt: new Date("2026-04-01T00:00:00Z"),
			})
			.returning();
		await pruneStatusHistory(90, NOW);
		const incidents = await db.select().from(statusIncidents);
		expect(incidents.find((row) => row.id === oldResolved[0].id)).toBeUndefined();
		expect(incidents.find((row) => row.id === oldOngoing[0].id)).toBeDefined();
		const updates = await db.select().from(statusIncidentUpdates);
		expect(updates.find((row) => row.incidentId === oldResolved[0].id)).toBeUndefined();
	});
});
