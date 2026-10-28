// SPDX-License-Identifier: Apache-2.0
/**
 * The failed-mail surface — a send the app intended that the provider did not complete,
 * and the bounce that arrives after acceptance.
 *
 * 🚨 **The three assertions the design turns on.** One: an email SUPPRESSED by the person's
 * delivery mode must never read as a failure — the panel reads the ledger, and this suite
 * proves the suppressed case writes no row there at all. Two: a send whose provider
 * ACCEPTED and whose recipient then bounced is recorded against the row by the webhook
 * matching on the provider's message id. Three: the admin route answers all three lists
 * and nothing else's rows.
 *
 * The receipt half of the webhook matching rides the same `recordDeliveryEvent`; its
 * rows live in `outbound_emails` and its assertions are at the bottom of the file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { notifications, outboundEmails, users } from "@anthers/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";
import app from "../index";
import { recordDeliveryEvent } from "../services/delivery-events.js";
import { notify } from "../services/notifications.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

let adminCookie = "";

let suppressedUserId = 0;

// A notification intended-but-unsent (the failure shape) — written directly so the test
// does not need a provider that refuses on cue.
const FAILED_MSG = `fm-notif-${crypto.randomUUID().slice(0, 8)}`;
let failedMailId = 0;

// A receipt refused, and a receipt bounced-after-acceptance.
const BOUNCED_MSG = `fm-receipt-${crypto.randomUUID().slice(0, 8)}`;
let refusedReceiptId = 0;
let bouncedReceiptId = 0;

async function adminSession(): Promise<string> {
	const admin = await createAdminFixture(`fm_admin_${RUN}`);
	return admin.cookie;
}

beforeAll(async () => {
	adminCookie = await adminSession();

	// A person whose delivery mode suppresses social email (the NOT-a-failure case).
	const suppressed = await createAccount(`fm_suppressed_${RUN}`);
	suppressedUserId = suppressed.userId;
	// The wildcard app-only map — the old boolean's meaning — written directly, since the
	// point is the row state rather than the setter.
	await db.execute(sql`
		INSERT INTO user_preferences (user_id, notification_delivery)
		VALUES (${suppressedUserId}, ${JSON.stringify({ "*": "app" })}::jsonb)
		ON CONFLICT (user_id) DO UPDATE SET notification_delivery = ${JSON.stringify({ "*": "app" })}::jsonb
	`);

	// The suppressed row: an activity kind in a mapped group with the wildcard saying app.
	await notify({
		userId: suppressedUserId,
		category: "activity",
		kind: "comment_reply",
		title: `Suppressed ${RUN}`,
		dedupeKey: `fm-suppressed:${RUN}`,
	});

	// An intended-but-failed mail, written the way the service writes it: the in-app record,
	// then the ledger row that exists because the send was decided on and did not land.
	await db.insert(notifications).values({
		userId: suppressedUserId,
		category: "essential",
		kind: "test_essential_fm",
		title: `Intended but unsent ${RUN}`,
		dedupeKey: `fm-failed:${RUN}`,
	});
	const [failedMail] = await db
		.insert(outboundEmails)
		.values({
			dedupeKey: `notification:fm-failed:${RUN}`,
			kind: "notification",
			userId: suppressedUserId,
			recipient: `fm_failed_${RUN}@example.com`,
			subject: `Intended but unsent ${RUN}`,
			detail: { notificationKind: "test_essential_fm", category: "essential" },
			messageId: FAILED_MSG,
		})
		.returning({ id: outboundEmails.id });
	failedMailId = failedMail.id;

	// The refused receipt.
	const [refused] = await db
		.insert(outboundEmails)
		.values({
			dedupeKey: `fm-refused-receipt:${RUN}`,
			kind: "receipt",
			userId: suppressedUserId,
			recipient: `fm_refused_${RUN}@example.com`,
			detail: { receiptKind: "purchase", role: "buyer" },
		})
		.returning({ id: outboundEmails.id });
	refusedReceiptId = refused.id;

	// The accepted receipt, which the webhook's bounce will land against.
	const [bounced] = await db
		.insert(outboundEmails)
		.values({
			dedupeKey: `fm-bounced-receipt:${RUN}`,
			kind: "receipt",
			userId: suppressedUserId,
			recipient: `fm_bounced_${RUN}@example.com`,
			detail: { receiptKind: "purchase", role: "buyer" },
			sentAt: new Date(),
			messageId: BOUNCED_MSG,
		})
		.returning({ id: outboundEmails.id });
	bouncedReceiptId = bounced.id;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	const noteIds = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(like(notifications.dedupeKey, "fm-%"));
	if (noteIds.length > 0)
		await db.delete(notifications).where(
			inArray(
				notifications.id,
				noteIds.map((n) => n.id),
			),
		);
	const receiptIds = [refusedReceiptId, bouncedReceiptId].filter((n) => n > 0);
	if (receiptIds.length > 0)
		await db.delete(outboundEmails).where(inArray(outboundEmails.id, receiptIds));
	// The notifications this suite wrote leave their ledger rows behind deliberately — a
	// suppressed send has none — so the ones that exist are cleaned by their key prefix.
	await db.delete(outboundEmails).where(like(outboundEmails.dedupeKey, "notification:fm-%"));
	await db.delete(users).where(eq(users.id, suppressedUserId));
});

describe("the intent discriminator", () => {
	it("a SUPPRESSED social send writes no ledger row — not a failure", async () => {
		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `fm-suppressed:${RUN}`));
		// The in-app record stands; the email was never wanted, so nothing was recorded.
		expect(row).toBeDefined();
		const mails = await db
			.select({ id: outboundEmails.id })
			.from(outboundEmails)
			.where(eq(outboundEmails.dedupeKey, `notification:fm-suppressed:${RUN}`));
		expect(mails).toHaveLength(0);
	});

	it("an intended-but-failed mail is the panel's failure state", async () => {
		const [row] = await db.select().from(outboundEmails).where(eq(outboundEmails.id, failedMailId));
		expect(row.kind).toBe("notification");
		expect(row.sentAt).toBeNull();
	});
});

describe("the webhook matching", () => {
	it("a bounce against a notification's message id lands on its ledger row", async () => {
		const at = new Date();
		const { matched } = await recordDeliveryEvent({
			messageId: FAILED_MSG,
			event: "bounced",
			occurredAt: at,
		});
		expect(matched).toBeGreaterThanOrEqual(1);
		const [row] = await db.select().from(outboundEmails).where(eq(outboundEmails.id, failedMailId));
		expect(row.deliveryEvent).toBe("bounced");
		expect(row.deliveryEventAt?.toISOString()).toBe(at.toISOString());
	});

	it("a non-terminal event does NOT overwrite the bounce", async () => {
		await recordDeliveryEvent({
			messageId: FAILED_MSG,
			event: "sent",
			occurredAt: new Date(),
		});
		const [row] = await db.select().from(outboundEmails).where(eq(outboundEmails.id, failedMailId));
		expect(row.deliveryEvent).toBe("bounced");
	});

	it("a bounce against a receipt's message id lands on its row", async () => {
		const at = new Date();
		await recordDeliveryEvent({ messageId: BOUNCED_MSG, event: "bounced", occurredAt: at });
		const [row] = await db
			.select()
			.from(outboundEmails)
			.where(eq(outboundEmails.id, bouncedReceiptId));
		expect(row.deliveryEvent).toBe("bounced");
	});

	it("an event for an email no row names matches nothing, which is the ordinary case", async () => {
		expect(
			await recordDeliveryEvent({
				messageId: `fm-unmatched-${RUN}`,
				event: "delivered",
				occurredAt: new Date(),
			}),
		).toEqual({ matched: 0 });
	});
});

describe("the admin surface", () => {
	it("lists the intended-but-unsent notification, the refused receipt and the bounce — and not the suppressed one", async () => {
		const res = await req("/api/admin/failed-mail", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			failedNotes: { id: number; title: string }[];
			refusedReceipts: { id: number }[];
			bouncedOrWorse: { id: number; deliveryEvent: string }[];
		};
		expect(body.failedNotes.some((n) => n.title === `Intended but unsent ${RUN}`)).toBe(true);
		expect(body.refusedReceipts.some((r) => r.id === refusedReceiptId)).toBe(true);
		const bounce = body.bouncedOrWorse.find((r) => r.id === bouncedReceiptId);
		expect(bounce?.deliveryEvent).toBe("bounced");
		// The suppressed notice — in-app mail suppressed by the delivery map — is in NEITHER
		// list, because no ledger row was ever written for it.
		expect(body.failedNotes.some((n) => n.title === `Suppressed ${RUN}`)).toBe(false);
	});
});
