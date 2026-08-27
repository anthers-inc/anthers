// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retention — the three-year redaction of personal detail in safety and copyright
 * records.
 *
 * Most of what matters here is what must **not** happen, which is the shape the
 * Hub warns is least likely to be covered. A sweep that redacted too much would
 * fail silently and irreversibly: nothing errors, nothing is missing from a page,
 * and the deleted contact details do not come back. So the cases below are
 * weighted toward the guards rather than the happy path.
 *
 * - A settled record past three years loses its contact details and **keeps
 *   everything the repeat-infringer record and an appeal are made of.**
 * - A record inside three years is untouched.
 * - A notice with a **live suit** is never redacted, at any age.
 * - A notice still working through the process is never redacted, at any age.
 * - An **open** report is never redacted, at any age.
 * - The sweep is idempotent — `redactedAt` keeps it off rows it has done.
 * - `moderation_actions` is not swept at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	type DmcaNoticeStatus,
	dmcaNotices,
	moderationActions,
	moderationReports,
	users,
	works,
} from "@anthers/db/schema";
import { RECORD_REDACTION_YEARS } from "@anthers/shared/constants";
import { eq, sql } from "drizzle-orm";
import {
	redactClosedModerationReports,
	redactionCutoff,
	redactSettledDmcaNotices,
	runRetentionSweep,
} from "../services/retention";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `ret_creator_${run}`;
const reporterName = `ret_reporter_${run}`;

let creatorId: number;
let reporterId: number;
let workId: number;
const createdNotices: number[] = [];
const createdReports: number[] = [];

/** Comfortably past the clock. */
function longAgo(): Date {
	const d = new Date();
	d.setFullYear(d.getFullYear() - (RECORD_REDACTION_YEARS + 1));
	return d;
}

/** Comfortably inside it. */
function recently(): Date {
	const d = new Date();
	d.setMonth(d.getMonth() - 2);
	return d;
}

async function makeNotice(opts: {
	status: DmcaNoticeStatus;
	receivedAt: Date;
	finalizedAt?: Date | null;
	suitFiledAt?: Date | null;
	withCounterNotice?: boolean;
}) {
	const [row] = await db
		.insert(dmcaNotices)
		.values({
			workId,
			workTitle: "A fixture Work",
			complainantName: "Rights Holder",
			complainantEmail: "holder@example.com",
			complainantAddress: "9 Claim Lane, Anytown, US",
			complainantPhone: "555-0199",
			copyrightedWorkDescription: "My original game.",
			infringingMaterialDescription: "That work is a copy of it.",
			goodFaithStatement: "Good faith.",
			authorizationStatement: "Authorized.",
			fairUseConsidered: true,
			attestationTextSnapshot: "The attestation as shown.",
			status: opts.status,
			receivedAt: opts.receivedAt,
			finalizedAt: opts.finalizedAt ?? null,
			finalizedReason: opts.finalizedAt ? "no_counter_notice" : "",
			suitFiledAt: opts.suitFiledAt ?? null,
			buyersRefunded: 2,
			counterNotice: opts.withCounterNotice
				? {
						subscriberName: "A Creator",
						subscriberAddress: "1 Creator Way, Anytown, US",
						subscriberPhone: "555-0111",
						jurisdictionConsent: "I consent.",
						goodFaithStatement: "Mistake.",
						attestationTextSnapshot: "The counter-attestation as shown.",
						filedAt: opts.receivedAt.toISOString(),
					}
				: null,
		})
		.returning();
	createdNotices.push(row.id);
	return row;
}

async function makeReport(opts: { status: string; createdAt: Date; resolvedAt?: Date | null }) {
	const [row] = await db
		.insert(moderationReports)
		.values({
			subjectType: "work",
			// A distinct subject per report — the unique index is on
			// (reporter, subjectType, subjectId), so reusing one would collide.
			subjectId: Math.floor(Math.random() * 1_000_000) + 9_000_000,
			reporterId,
			reason: "spam",
			details: "Here is exactly what I saw and why it upset me.",
			status: opts.status,
			createdAt: opts.createdAt,
			resolvedAt: opts.resolvedAt ?? null,
		})
		.returning();
	createdReports.push(row.id);
	return row;
}

async function reloadNotice(id: number) {
	const [row] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, id)).limit(1);
	return row;
}

async function reloadReport(id: number) {
	const [row] = await db
		.select()
		.from(moderationReports)
		.where(eq(moderationReports.id, id))
		.limit(1);
	return row;
}

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${reporterName})`);
	const [creator] = await db
		.insert(users)
		.values({
			username: creatorName,
			email: `${creatorName}@example.com`,
			passwordHash: "x",
			emailVerified: true,
			isCreator: true,
		})
		.returning({ id: users.id });
	creatorId = creator.id;
	const [reporter] = await db
		.insert(users)
		.values({
			username: reporterName,
			email: `${reporterName}@example.com`,
			passwordHash: "x",
			emailVerified: true,
		})
		.returning({ id: users.id });
	reporterId = reporter.id;

	const work = await insertWork({ creatorId, type: "game", title: `Retention fixture ${run}` });
	workId = work.id;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	for (const id of createdNotices) await db.delete(dmcaNotices).where(eq(dmcaNotices.id, id));
	for (const id of createdReports)
		await db.delete(moderationReports).where(eq(moderationReports.id, id));
	await db.delete(works).where(eq(works.id, workId));
	await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${reporterName})`);
});

describe("the cutoff", () => {
	it("is RECORD_REDACTION_YEARS before now", () => {
		const now = new Date(2030, 5, 15);
		const cutoff = redactionCutoff(now);
		expect(cutoff.getFullYear()).toBe(2030 - RECORD_REDACTION_YEARS);
		expect(cutoff.getMonth()).toBe(5);
		expect(cutoff.getDate()).toBe(15);
	});
});

describe("DMCA notices past the clock", () => {
	it("loses every contact detail on both sides, and keeps the record", async () => {
		const before = await makeNotice({
			status: "restored",
			receivedAt: longAgo(),
			finalizedAt: longAgo(),
			withCounterNotice: true,
		});

		const result = await redactSettledDmcaNotices();
		expect(result.redacted).toBeGreaterThanOrEqual(1);

		const after = await reloadNotice(before.id);
		// Gone.
		expect(after?.complainantName).toBe("");
		expect(after?.complainantEmail).toBe("");
		expect(after?.complainantAddress).toBe("");
		expect(after?.complainantPhone).toBe("");
		expect(after?.counterNotice?.subscriberName).toBe("");
		expect(after?.counterNotice?.subscriberAddress).toBe("");
		expect(after?.counterNotice?.subscriberPhone).toBe("");
		expect(after?.redactedAt).toBeTruthy();

		// 🚨 Kept — this half is the point. § 512(i) needs the pattern and an appeal
		// needs the decision, so a sweep that took these too would satisfy privacy by
		// destroying the safe harbour.
		expect(after?.workId).toBe(workId);
		expect(after?.workTitle).toBe("A fixture Work");
		expect(after?.status).toBe("restored");
		expect(after?.buyersRefunded).toBe(2);
		expect(after?.copyrightedWorkDescription).toBe("My original game.");
		expect(after?.attestationTextSnapshot).toBe("The attestation as shown.");
		// The counter-notice survives as a record of having been filed.
		expect(after?.counterNotice?.attestationTextSnapshot).toBe("The counter-attestation as shown.");
	});

	it("leaves a notice inside the window completely alone", async () => {
		const before = await makeNotice({
			status: "restored",
			receivedAt: recently(),
			finalizedAt: recently(),
		});
		await redactSettledDmcaNotices();
		const after = await reloadNotice(before.id);
		expect(after?.complainantAddress).toBe("9 Claim Lane, Anytown, US");
		expect(after?.redactedAt).toBeNull();
	});

	it("never redacts a notice with a live suit, however old", async () => {
		const before = await makeNotice({
			status: "restored",
			receivedAt: longAgo(),
			finalizedAt: longAgo(),
			suitFiledAt: longAgo(),
		});
		await redactSettledDmcaNotices();
		const after = await reloadNotice(before.id);
		// Destroying a party's contact details while they are in front of a federal
		// court is the one version of this that could do real harm.
		expect(after?.complainantAddress).toBe("9 Claim Lane, Anytown, US");
		expect(after?.redactedAt).toBeNull();
	});

	it("never redacts a notice still working through the process", async () => {
		for (const status of ["received", "screening", "actioned", "counter_noticed"] as const) {
			const before = await makeNotice({ status, receivedAt: longAgo() });
			await redactSettledDmcaNotices();
			const after = await reloadNotice(before.id);
			expect(after?.complainantAddress).toBe("9 Claim Lane, Anytown, US");
			expect(after?.redactedAt).toBeNull();
		}
	});

	it("redacts an actioned notice once it has been finalized", async () => {
		const before = await makeNotice({
			status: "actioned",
			receivedAt: longAgo(),
			finalizedAt: longAgo(),
		});
		await redactSettledDmcaNotices();
		const after = await reloadNotice(before.id);
		expect(after?.complainantAddress).toBe("");
	});

	it("dates the clock from the LAST thing that happened, not from receipt", async () => {
		// Received four years ago but only settled last month: still inside the
		// window, because the clock cannot be run down by letting a notice sit.
		const before = await makeNotice({
			status: "restored",
			receivedAt: longAgo(),
			finalizedAt: recently(),
		});
		await redactSettledDmcaNotices();
		const after = await reloadNotice(before.id);
		expect(after?.complainantAddress).toBe("9 Claim Lane, Anytown, US");
		expect(after?.redactedAt).toBeNull();
	});

	it("is idempotent — a redacted row is not swept again", async () => {
		await makeNotice({ status: "withdrawn", receivedAt: longAgo(), finalizedAt: longAgo() });
		const first = await redactSettledDmcaNotices();
		expect(first.redacted).toBeGreaterThanOrEqual(1);
		const second = await redactSettledDmcaNotices();
		expect(second.redacted).toBe(0);
	});
});

describe("moderation reports past the clock", () => {
	it("drops the reporter's words and identity, and keeps the report", async () => {
		const before = await makeReport({
			status: "resolved",
			createdAt: longAgo(),
			resolvedAt: longAgo(),
		});
		const result = await redactClosedModerationReports();
		expect(result.redacted).toBeGreaterThanOrEqual(1);

		const after = await reloadReport(before.id);
		expect(after?.details).toBe("");
		expect(after?.reporterId).toBeNull();
		expect(after?.redactedAt).toBeTruthy();
		// The subject's history survives — that is what the record is for.
		expect(after?.reason).toBe("spam");
		expect(after?.status).toBe("resolved");
		expect(after?.subjectType).toBe("work");
	});

	it("never redacts an OPEN report, however old", async () => {
		// An unlooked-at three-year-old report is a queue failure, not a retention
		// case — and blanking the reporter would destroy unfinished work.
		const before = await makeReport({ status: "open", createdAt: longAgo() });
		await redactClosedModerationReports();
		const after = await reloadReport(before.id);
		expect(after?.details).not.toBe("");
		expect(after?.redactedAt).toBeNull();
	});

	it("leaves a recently closed report alone", async () => {
		const before = await makeReport({
			status: "dismissed",
			createdAt: recently(),
			resolvedAt: recently(),
		});
		await redactClosedModerationReports();
		const after = await reloadReport(before.id);
		expect(after?.details).not.toBe("");
		expect(after?.redactedAt).toBeNull();
	});
});

describe("what the sweep does not touch", () => {
	it("leaves moderation_actions alone entirely", async () => {
		// Our own record — our operator, our note, no member of the public's contact
		// details — and the thing that answers an appeal. Deliberately not swept.
		const [action] = await db
			.insert(moderationActions)
			.values({
				subjectType: "work",
				subjectId: workId,
				action: "hide",
				actorId: creatorId,
				actorRole: "operator",
				reason: "dmca",
				note: "An operator's note from long ago.",
				createdAt: longAgo(),
			})
			.returning();

		await runRetentionSweep();

		const [after] = await db
			.select()
			.from(moderationActions)
			.where(eq(moderationActions.id, action.id))
			.limit(1);
		expect(after?.note).toBe("An operator's note from long ago.");
		expect(after?.actorId).toBe(creatorId);

		await db.delete(moderationActions).where(eq(moderationActions.id, action.id));
	});
});
