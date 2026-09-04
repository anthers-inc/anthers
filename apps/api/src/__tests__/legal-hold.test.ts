// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A legal hold stops the sweeps that would otherwise destroy what it names.
 *
 * The assertions here are all of the same shape and it is a deliberate one: they
 * check that **rows survived a sweep that ran**, by counting them directly, rather
 * than checking that some reader stopped returning them. That distinction is the
 * whole lesson of the sessions defect Privacy Policy records — `deleteExpiredSessions()` was
 * exported and called from nowhere for months while every reader filtered expired
 * sessions out anyway, so a read-side test would have passed throughout. A sweep
 * that does not run and a sweep that correctly skips look identical from the
 * outside; the way to tell them apart is to run the sweep and count.
 *
 * So each case here does three things in order: prove the sweep destroys the thing
 * when there is no hold, place a hold, and prove the same sweep leaves it. Without
 * the first step a passing test proves only that the sweep is inert.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	attentionDaily,
	attentionEvents,
	legalHolds,
	moderationReports,
	sessions,
	users,
} from "@anthers/db/schema";
import { RECORD_REDACTION_YEARS } from "@anthers/shared/constants";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { pruneAttention } from "../jobs/prune-attention.js";
import { eraseAccount } from "../services/account-deletion.js";
import { deleteExpiredSessions } from "../services/auth.js";
import { isUnderHold, liftHold, placeHold, preservationExpiry } from "../services/legal-hold.js";
import { redactClosedModerationReports } from "../services/retention.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<number> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, username))
		.limit(1);
	return row.id;
}

const id = crypto.randomUUID().slice(0, 8);
const names = ["held", "free", "sess", "rep", "attc", "attfree", "attheld"].map(
	(s) => `hold_${s}_${id}`,
);
const userIds: number[] = [];

/**
 * Two UTC days well outside the window any other suite seeds into.
 *
 * The attention prune is global — it sweeps every day older than its cutoff, not just
 * this fixture's — so a day shared with `attention-retention.test.ts` would let a hold
 * placed here decide whether that suite's rows survive. Distinct days keep the two
 * suites from arguing about the same rollup.
 */
function daysAgo(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const FREE_DAY = daysAgo(200);
const HELD_DAY = daysAgo(201);

/** A back-dated viewing record. The endpoint always stamps `now()`, so this goes in raw. */
async function seedAttention(userId: number, day: string) {
	await db.execute(sql`
		INSERT INTO attention_events (user_id, creator_id, work_id, event_type, duration_seconds, created_at)
		VALUES (${userId}, ${userIds[4]}, NULL, 'watch', 60, ${`${day}T12:00:00Z`})
	`);
}

/** Raw rows for one person, counted directly rather than through any reader. */
async function countAttention(userId: number): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(attentionEvents)
		.where(eq(attentionEvents.userId, userId));
	return row.n;
}

/** A timestamp comfortably past the redaction cutoff, so a report is sweepable now. */
function longAgo(): Date {
	const d = new Date();
	d.setFullYear(d.getFullYear() - (RECORD_REDACTION_YEARS + 1));
	return d;
}

async function seedExpiredSession(userId: number) {
	await db.insert(sessions).values({
		token: `hold-test-${crypto.randomUUID()}`,
		userId,
		ipAddress: "198.51.100.7",
		userAgent: "hold-test",
		expiresAt: new Date(Date.now() - 60_000),
	});
}

/**
 * Only the seeded, already-expired rows. Signing up mints a live session, and
 * counting that too would make "the sweep left one" indistinguishable from "the
 * sweep deleted the expired one and the live one remains" — which is the wrong
 * assertion in both directions.
 */
async function countSessions(userId: number): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(sessions)
		.where(and(eq(sessions.userId, userId), eq(sessions.userAgent, "hold-test")));
	return row.n;
}

/** A closed, long-settled report with the reporter's words on it — sweepable. */
async function seedRedactableReport(reporterId: number, subjectId: number): Promise<number> {
	const [row] = await db
		.insert(moderationReports)
		.values({
			subjectType: "comment",
			subjectId,
			reporterId,
			reason: "spam",
			details: "the reporter's own words",
			status: "dismissed",
			resolvedAt: longAgo(),
			createdAt: longAgo(),
			// Already escalated, so the floor sweep leaves it alone and this test is
			// measuring redaction rather than racing an alert.
			escalatedAt: new Date(),
		})
		.returning({ id: moderationReports.id });
	return row.id;
}

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username LIKE ${`hold_%_${id}`}`);
	for (const name of names) userIds.push(await signUp(name));
}, DB_SETUP_TIMEOUT);

describe("The hold itself", () => {
	it("is a state, not a delete — lifting leaves the record of what was held", async () => {
		const { holdId } = await placeHold({
			subjectType: "user",
			subjectId: userIds[1],
			reason: "fixture",
		});
		expect(await isUnderHold("user", userIds[1])).toBe(true);

		expect(await liftHold(holdId)).toBe(true);
		expect(await isUnderHold("user", userIds[1])).toBe(false);

		const [row] = await db.select().from(legalHolds).where(eq(legalHolds.id, holdId));
		expect(row).toBeDefined();
		expect(row.liftedAt).not.toBeNull();
		expect(row.reason).toBe("fixture");

		// Lifting twice must not rewrite when the preservation actually ended.
		expect(await liftHold(holdId)).toBe(false);
	});

	it("refuses a hold nobody can explain", async () => {
		await expect(
			placeHold({ subjectType: "user", subjectId: userIds[1], reason: "   " }),
		).rejects.toThrow();
	});

	it("stops applying once its own clock runs out", async () => {
		await placeHold({
			subjectType: "work",
			subjectId: 987_654,
			reason: "expired fixture",
			expiresAt: new Date(Date.now() - 1000),
		});
		expect(await isUnderHold("work", 987_654)).toBe(false);
	});

	it("dates a preservation one year out, per § 2258A(h)", () => {
		const now = new Date("2026-08-25T00:00:00.000Z");
		expect(preservationExpiry(now).toISOString()).toBe("2027-08-25T00:00:00.000Z");
	});
});

describe("Account deletion", () => {
	it("erases an account when nothing holds it", async () => {
		const target = userIds[1];
		const result = await eraseAccount(target);
		expect(result.erased).toBe(true);
		const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, target));
		expect(row).toBeUndefined();
	});

	it("leaves a held account alone, and leaves the deletion pending", async () => {
		const target = userIds[0];
		await placeHold({
			subjectType: "user",
			subjectId: target,
			reason: "CyberTipline report, § 2258A(h)",
			expiresAt: preservationExpiry(),
		});
		await db
			.update(users)
			.set({ deletionRequestedAt: new Date(Date.now() - 60_000) })
			.where(eq(users.id, target));

		const result = await eraseAccount(target);
		expect(result.erased).toBe(false);

		// The row survives — and the request survives with it, so the account is erased
		// the day the hold lifts rather than the deletion being silently canceled.
		const [row] = await db
			.select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
			.from(users)
			.where(eq(users.id, target));
		expect(row).toBeDefined();
		expect(row.deletionRequestedAt).not.toBeNull();
	});
});

describe("The session prune", () => {
	it("destroys an expired session's IP address when nothing holds the account", async () => {
		const target = userIds[2];
		await seedExpiredSession(target);
		expect(await countSessions(target)).toBeGreaterThan(0);

		await deleteExpiredSessions();
		expect(await countSessions(target)).toBe(0);
	});

	it("keeps a held account's expired sessions, because the IP is the evidence", async () => {
		const target = userIds[3];
		await seedExpiredSession(target);
		await placeHold({ subjectType: "user", subjectId: target, reason: "preservation fixture" });

		await deleteExpiredSessions();
		expect(await countSessions(target)).toBe(1);
	});
});

describe("The redaction sweep", () => {
	it("blanks a settled report's personal detail when nothing holds it", async () => {
		const reportId = await seedRedactableReport(userIds[2], 555_001);
		await redactClosedModerationReports();

		const [row] = await db
			.select({ details: moderationReports.details, reporterId: moderationReports.reporterId })
			.from(moderationReports)
			.where(eq(moderationReports.id, reportId));
		expect(row.details).toBe("");
		expect(row.reporterId).toBeNull();
	});

	it("leaves a held report's words and reporter intact — a redaction is a destruction", async () => {
		const reportId = await seedRedactableReport(userIds[2], 555_002);
		await placeHold({ subjectType: "report", subjectId: reportId, reason: "preservation fixture" });

		await redactClosedModerationReports();

		const [row] = await db
			.select({
				details: moderationReports.details,
				reporterId: moderationReports.reporterId,
				redactedAt: moderationReports.redactedAt,
			})
			.from(moderationReports)
			.where(eq(moderationReports.id, reportId));
		expect(row.details).toBe("the reporter's own words");
		expect(row.reporterId).not.toBeNull();
		expect(row.redactedAt).toBeNull();
	});
});

describe("The attention prune", () => {
	it("destroys a viewing history when nothing holds the account", async () => {
		const target = userIds[5];
		await seedAttention(target, FREE_DAY);
		expect(await countAttention(target)).toBe(1);

		await pruneAttention({ retentionDays: 30 });
		expect(await countAttention(target)).toBe(0);
	});

	it("keeps a held account's viewing history, and the whole day with it", async () => {
		const held = userIds[6];
		const bystander = userIds[5];
		// A second person active on the SAME day, to pin down which unit the sweep skips.
		await seedAttention(held, HELD_DAY);
		await seedAttention(bystander, HELD_DAY);
		await placeHold({ subjectType: "user", subjectId: held, reason: "attention fixture" });

		const result = await pruneAttention({ retentionDays: 30 });

		expect(await countAttention(held)).toBe(1);
		// 🚨 The bystander's row survives too, and that is correct rather than sloppy. The
		// rollup upsert writes `excluded` rather than adding, so aggregating a day from
		// part of its rows and later re-aggregating from the rest overwrites the creator's
		// total with the smaller figure — the same overwrite `attention-retention.test.ts`
		// pins in its idempotence case. A day is pruned whole or not at all.
		expect(await countAttention(bystander)).toBe(1);
		expect(result.daysHeld).toBeGreaterThanOrEqual(1);

		// And the day was never rolled up, so no partial total was written for it.
		const daily = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(attentionDaily)
			.where(and(eq(attentionDaily.creatorId, userIds[4]), eq(attentionDaily.day, HELD_DAY)));
		expect(daily[0].n).toBe(0);
	});
});

describe("Cleanup", () => {
	it("removes the fixture", async () => {
		await db
			.delete(moderationReports)
			.where(
				and(
					eq(moderationReports.subjectType, "comment"),
					sql`${moderationReports.subjectId} IN (555001, 555002)`,
				),
			);
		// Holds are keyed by a bare integer with no foreign key, so deleting the users
		// below leaves them behind — and a stale active hold on a recycled subject id
		// would silently suspend a sweep in some later run.
		await db.delete(legalHolds).where(inArray(legalHolds.subjectId, userIds));
		await db.execute(sql`DELETE FROM legal_holds WHERE reason LIKE '%fixture%'`);
		await db.delete(attentionDaily).where(eq(attentionDaily.creatorId, userIds[4]));
		await db.execute(sql`DELETE FROM users WHERE username LIKE ${`hold_%_${id}`}`);
		expect(true).toBe(true);
	});
});
