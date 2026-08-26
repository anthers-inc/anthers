// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether a floor alert actually reached the mailbox, rather than whether we handed it to
 * a provider.
 *
 * 🚨 **The distinction this file exists for.** `escalated_at` has only ever meant *Resend
 * accepted the message* — a fact about our side of a network call. An alert the provider
 * accepted and then bounced is, to the person who needed telling, identical to one never
 * sent, and until the delivery event was stored nothing in the app could tell them apart.
 *
 * ⭐ **The answer is pushed to us, not polled.** Asking Resend directly needs an API key
 * that can read mail, and production's is send-only — confirmed on 2026-08-26, when a
 * status lookup answered `401 — "This API key is restricted to only send emails"`.
 * Broadening it would have given the credential most exposed in production the power to
 * read every message we have ever sent, to answer a question the provider will simply
 * tell us. So these cases are about what happens when the webhook arrives.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { abuseReports, moderationReports } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import {
	classifyStoredEvent,
	deliveryForReport,
	normalizeEventName,
	recordDeliveryEvent,
} from "../services/delivery-events.js";
import { sendEmail } from "../services/email.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

describe("Reading a stored event", () => {
	it("treats a delivered message as delivered and finished", () => {
		const s = classifyStoredEvent("delivered", null);
		expect(s.delivered).toBe(true);
		expect(s.terminal).toBe(true);
	});

	it("counts opened and clicked as delivered, because they come after delivery", () => {
		// A message somebody has read has necessarily been delivered. Reading these as
		// anything else turns the best possible outcome into an unresolved one.
		for (const event of ["opened", "clicked"]) {
			const s = classifyStoredEvent(event, null);
			expect(s.delivered).toBe(true);
			expect(s.terminal).toBe(true);
		}
	});

	it("treats a bounce or a complaint as finished and NOT delivered", () => {
		// 🚨 The case the whole feature exists for: the provider accepted it, so
		// `escalated_at` is stamped and the old reading called this a success.
		for (const event of ["bounced", "complained", "failed", "canceled"]) {
			const s = classifyStoredEvent(event, null);
			expect(s.delivered).toBe(false);
			expect(s.terminal).toBe(true);
		}
	});

	it("leaves an in-flight message unfinished, so a caller keeps asking", () => {
		for (const event of ["queued", "sent", "scheduled", "delivery_delayed"]) {
			const s = classifyStoredEvent(event, null);
			expect(s.delivered).toBe(false);
			expect(s.terminal).toBe(false);
		}
	});

	it("fails toward keep-asking on an event nobody has seen before", () => {
		const s = classifyStoredEvent("teleported", null);
		expect(s.delivered).toBe(false);
		expect(s.terminal).toBe(false);
	});

	it("strips the provider's prefix", () => {
		expect(normalizeEventName("email.delivered")).toBe("delivered");
		expect(normalizeEventName("delivered")).toBe("delivered");
	});
});

describe("The send result", () => {
	it("reports failure as an object rather than a bare false", async () => {
		// The test runner never sends, so this is the skip path — and the shape is the
		// point. A caller that forgot to update would have seen a truthy object, which is
		// the bug the type change forces the compiler to prevent.
		const result = await sendEmail({ to: "nobody@example.com", subject: "x", html: "<p>x</p>" });
		expect(result.sent).toBe(false);
		expect(result.messageId).toBeNull();
	});
});

describe("Recording what the provider tells us", () => {
	let abuseId: number;
	let reportId: number;
	const ABUSE_MSG = `resend-fixture-abuse-${crypto.randomUUID().slice(0, 8)}`;
	const REPORT_MSG = `resend-fixture-report-${crypto.randomUUID().slice(0, 8)}`;

	beforeAll(async () => {
		const [a] = await db
			.insert(abuseReports)
			.values({
				url: "https://anthers.org/works/delivery-fixture",
				reason: "illegal",
				details: "delivery lookup fixture",
				escalatedAt: new Date(),
				escalationMessageId: ABUSE_MSG,
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
				escalationMessageId: REPORT_MSG,
			})
			.returning({ id: moderationReports.id });
		reportId = r.id;
	}, DB_SETUP_TIMEOUT);

	it("records a delivery against the right intake, which are separate tables", async () => {
		const at = new Date("2026-08-26T01:05:00.000Z");
		expect(
			await recordDeliveryEvent({ messageId: ABUSE_MSG, event: "delivered", occurredAt: at }),
		).toEqual({ matched: 1 });

		const got = await deliveryForReport("abuse", abuseId);
		expect(got.messageId).toBe(ABUSE_MSG);
		expect(got.status?.delivered).toBe(true);
		expect(got.status?.occurredAt).toBe(at.toISOString());

		// The in-app report has its own message and must be untouched by the other's event.
		expect((await deliveryForReport("report", reportId)).status).toBeNull();
	});

	it("does not let a late non-terminal event overwrite a terminal one", async () => {
		// 🚨 Webhook deliveries are not ordered. A `sent` arriving after a `delivered`
		// must not downgrade a known-good outcome to an unknown one — which is what a
		// naive last-write-wins would do, intermittently and unreproducibly.
		await recordDeliveryEvent({
			messageId: ABUSE_MSG,
			event: "sent",
			occurredAt: new Date("2026-08-26T01:06:00.000Z"),
		});
		expect((await deliveryForReport("abuse", abuseId)).status?.event).toBe("delivered");
	});

	it("lets a terminal event replace a non-terminal one", async () => {
		const at = new Date("2026-08-26T01:07:00.000Z");
		await recordDeliveryEvent({ messageId: REPORT_MSG, event: "queued", occurredAt: at });
		expect((await deliveryForReport("report", reportId)).status?.event).toBe("queued");

		await recordDeliveryEvent({ messageId: REPORT_MSG, event: "bounced", occurredAt: at });
		const got = await deliveryForReport("report", reportId);
		expect(got.status?.event).toBe("bounced");
		expect(got.status?.delivered).toBe(false);
		expect(got.status?.terminal).toBe(true);
	});

	it("matches nothing for an email no report names, which is the ordinary case", async () => {
		// ⚠️ Resend sends an event for EVERY email, and most are signup verifications. A
		// handler that treated an unmatched event as a failure would spend its life
		// reporting failures.
		expect(
			await recordDeliveryEvent({
				messageId: "an-id-belonging-to-a-signup-email",
				event: "delivered",
				occurredAt: new Date(),
			}),
		).toEqual({ matched: 0 });
	});

	it("reports a report whose alert never went as having no message at all", async () => {
		const [row] = await db
			.insert(abuseReports)
			.values({
				url: "https://anthers.org/works/delivery-fixture-2",
				reason: "spam",
				details: "never escalated",
			})
			.returning({ id: abuseReports.id });
		const got = await deliveryForReport("abuse", row.id);
		expect(got.messageId).toBeNull();
		expect(got.status).toBeNull();
		await db.delete(abuseReports).where(eq(abuseReports.id, row.id));
	});

	it("removes the fixture", async () => {
		await db.delete(abuseReports).where(eq(abuseReports.id, abuseId));
		await db.delete(moderationReports).where(eq(moderationReports.id, reportId));
		await db.execute(sql`DELETE FROM abuse_reports WHERE details = 'delivery lookup fixture'`);
		expect(true).toBe(true);
	});
});
