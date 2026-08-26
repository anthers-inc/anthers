// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether a floor alert actually reached the mailbox, rather than whether we handed it to
 * a provider.
 *
 * 🚨 **The distinction this file exists for.** `escalated_at` has only ever meant *Resend
 * accepted the message* — a fact about our side of a network call. An alert the provider
 * accepted and then bounced is, from the point of view of the person who needed telling,
 * identical to one that was never sent; and until the message id was stored, nothing in
 * the app could tell those apart. These cases pin the reading of the provider's answer.
 *
 * The network call itself is deliberately NOT exercised — `emailDeliveryStatus`
 * early-returns under the test runner, on the same rule `sendEmail` follows, because a
 * suite whose outcome depends on a third party's latency is not testing our code. What is
 * worth pinning is the part with judgment in it: which events mean delivered, which mean
 * finished, and what happens to a name we have not seen before.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { abuseReports, moderationReports } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import { abuseEscalationMessageId } from "../services/abuse-reports.js";
import { classifyDeliveryEvent, sendEmail } from "../services/email.js";
import { reportEscalationMessageId } from "../services/moderation.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

describe("Reading the provider's answer", () => {
	it("treats a delivered message as delivered and finished", () => {
		const s = classifyDeliveryEvent("delivered");
		expect(s.delivered).toBe(true);
		expect(s.terminal).toBe(true);
	});

	it("counts opened and clicked as delivered, because they come after delivery", () => {
		// `last_event` reports only the most recent event, so a message somebody has read
		// no longer says "delivered". Reading that as undelivered would turn the best
		// possible outcome into an unresolved one.
		for (const event of ["opened", "clicked"]) {
			const s = classifyDeliveryEvent(event);
			expect(s.delivered).toBe(true);
			expect(s.terminal).toBe(true);
		}
	});

	it("treats a bounce or a complaint as finished and NOT delivered", () => {
		// 🚨 The case the whole feature exists for: the provider accepted it, so
		// `escalated_at` is stamped and the old reading would have called this a success.
		for (const event of ["bounced", "complained", "failed", "canceled"]) {
			const s = classifyDeliveryEvent(event);
			expect(s.delivered).toBe(false);
			expect(s.terminal).toBe(true);
		}
	});

	it("leaves an in-flight message unfinished, so a caller keeps asking", () => {
		for (const event of ["queued", "sent", "scheduled", "delivery_delayed"]) {
			const s = classifyDeliveryEvent(event);
			expect(s.delivered).toBe(false);
			expect(s.terminal).toBe(false);
		}
	});

	it("fails toward keep-asking on an event nobody has seen before", () => {
		// Resend can add a name at any time. Unknown must not read as success, and must
		// not read as finished either — the safe direction is to keep asking.
		const s = classifyDeliveryEvent("teleported");
		expect(s.delivered).toBe(false);
		expect(s.terminal).toBe(false);
	});
});

describe("The send result", () => {
	it("reports failure as an object rather than a bare false", async () => {
		// The test runner never sends, so this is the skip path — and the shape is the
		// point. A caller destructuring `{ sent }` gets false; a caller that forgot to
		// update would have seen a truthy object, which is the bug the type change forces
		// the compiler to prevent.
		const result = await sendEmail({ to: "nobody@example.com", subject: "x", html: "<p>x</p>" });
		expect(result.sent).toBe(false);
		expect(result.messageId).toBeNull();
	});
});

describe("Looking up a stored message id", () => {
	let abuseId: number;
	let reportId: number;

	beforeAll(async () => {
		const [a] = await db
			.insert(abuseReports)
			.values({
				url: "https://anthers.org/works/delivery-fixture",
				reason: "illegal",
				details: "delivery lookup fixture",
				escalatedAt: new Date(),
				escalationMessageId: "resend-fixture-abuse",
			})
			.returning({ id: abuseReports.id });
		abuseId = a.id;

		const [r] = await db
			.insert(moderationReports)
			.values({
				subjectType: "comment",
				subjectId: 909_001,
				reason: "sexual",
				details: "delivery lookup fixture",
				escalatedAt: new Date(),
				escalationMessageId: "resend-fixture-report",
			})
			.returning({ id: moderationReports.id });
		reportId = r.id;
	}, DB_SETUP_TIMEOUT);

	it("finds the id for each intake, which are separate tables with colliding ids", async () => {
		expect(await abuseEscalationMessageId(abuseId)).toBe("resend-fixture-abuse");
		expect(await reportEscalationMessageId(reportId)).toBe("resend-fixture-report");
	});

	it("returns null for a report whose alert never went", async () => {
		// Distinguishable on purpose from "sent, and the provider has an opinion" — the
		// route answers `not_escalated` for this case rather than an empty status.
		const [row] = await db
			.insert(abuseReports)
			.values({
				url: "https://anthers.org/works/delivery-fixture-2",
				reason: "spam",
				details: "never escalated",
			})
			.returning({ id: abuseReports.id });
		expect(await abuseEscalationMessageId(row.id)).toBeNull();
		await db.delete(abuseReports).where(eq(abuseReports.id, row.id));
	});

	it("removes the fixture", async () => {
		await db.delete(abuseReports).where(eq(abuseReports.id, abuseId));
		await db.delete(moderationReports).where(eq(moderationReports.id, reportId));
		await db.execute(sql`DELETE FROM abuse_reports WHERE details = 'delivery lookup fixture'`);
		expect(true).toBe(true);
	});
});
