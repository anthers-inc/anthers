// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A legal hold stops the sweeps that would otherwise destroy what it names.
 *
 * The assertions here are all of the same shape and it is a deliberate one: they
 * check that **rows survived a sweep that ran**, by counting them directly, rather
 * than checking that some reader stopped returning them. That distinction is the
 * whole lesson of the sessions defect 51.05 records — `deleteExpiredSessions()` was
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
import { legalHolds, moderationReports, sessions, users } from "@anthers/db/schema";
import { RECORD_REDACTION_YEARS } from "@anthers/shared/constants";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { eraseAccount } from "../services/account-deletion.js";
import { deleteExpiredSessions } from "../services/auth.js";
import { isUnderHold, liftHold, placeHold, preservationExpiry } from "../services/legal-hold.js";
import { redactClosedModerationReports } from "../services/retention.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

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
const names = ["held", "free", "sess", "rep"].map((s) => `hold_${s}_${id}`);
const userIds: number[] = [];

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
			reason: "illegal",
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
		// the day the hold lifts rather than the deletion being silently cancelled.
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
		await db.execute(sql`DELETE FROM legal_holds WHERE reason LIKE '%fixture%'`);
		await db.execute(sql`DELETE FROM users WHERE username LIKE ${`hold_%_${id}`}`);
		expect(true).toBe(true);
	});
});
