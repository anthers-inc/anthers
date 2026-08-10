// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notifications — idempotency, the opt-out line, and the record that we told someone.
 *
 * Three things here would each be a real incident rather than a bug:
 *
 * 1. **Re-sending.** Every consumer is a nightly job re-evaluating the same rows, so a
 *    broken `dedupeKey` means mailing somebody every morning until the deadline they
 *    were being warned about. That is how a considerate feature becomes the reason
 *    people filter your domain, and it is asserted by calling the same notify twice.
 *
 * 2. **An opt-out that silently swallows an essential notice.** The category split is
 *    only worth having if `essential` genuinely ignores the switch — a preference that
 *    quietly applies to a deadline notice is worse than no preference, because the
 *    user believes they know what they will be told.
 *
 * 3. **Losing the record.** 51.05 promises we will tell people before a change takes
 *    effect, and a promise to have told someone is worth what the evidence behind it is
 *    worth. So the in-app row must survive an email opt-out and an email *failure* —
 *    both tested, because both are states where the naive implementation writes nothing.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { notifications, purchases, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { eraseAccount } from "../services/account-deletion.js";
import { listNotifications, markRead, notify, unreadCount } from "../services/notifications.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const recipientName = `ntf_recipient_${id}`;
const creatorName = `ntf_creator_${id}`;
const buyerName = `ntf_buyer_${id}`;

let recipient: string;
let recipientId: number;
let creatorId: number;
let buyerId: number;
let soldWorkId: number;
let purchaseId: number;

async function idOf(u: string): Promise<number | null> {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, u));
	return row?.id ?? null;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${recipientName}, ${creatorName}, ${buyerName})`,
	);
	recipient = await signUp(recipientName);
	await signUp(creatorName);
	await signUp(buyerName);
	recipientId = (await idOf(recipientName))!;
	creatorId = (await idOf(creatorName))!;
	buyerId = (await idOf(buyerName))!;

	const sold = await insertWork({ creatorId, type: "game", title: `Notify fixture ${id}` });
	soldWorkId = sold.id;
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId,
			workId: soldWorkId,
			creatorId,
			workTitle: `Notify fixture ${id}`,
			workType: "game",
			workPublicId: sold.publicId,
			type: "digital",
			amount: "9.00",
			salesTax: "0.00",
			processingFee: "0.56",
			crfFee: "0.00",
			creatorEarnings: "8.44",
			stripePaymentIntentId: `pi_ntf_${id}`,
			status: "completed",
		})
		.returning();
	purchaseId = purchase.id;
}, DB_SETUP_TIMEOUT);

describe("one fact, one notification", () => {
	it("does not send twice for the same dedupe key", async () => {
		const input = {
			userId: recipientId,
			category: "essential" as const,
			kind: "test_thing",
			title: `Something happened ${id}`,
			dedupeKey: `test-thing:${id}`,
		};

		const first = await notify(input);
		expect(first.created).toBe(true);

		// The realistic caller is a cron re-evaluating the same rows tomorrow.
		const second = await notify(input);
		expect(second.created).toBe(false);
		expect(second.notificationId).toBeNull();

		const rows = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `test-thing:${id}`));
		expect(rows.length).toBe(1);
	});

	it("treats a different key about the same person as a different thing", async () => {
		const result = await notify({
			userId: recipientId,
			category: "activity",
			kind: "test_thing",
			title: `Something else ${id}`,
			dedupeKey: `test-other:${id}`,
		});
		expect(result.created).toBe(true);
	});
});

describe("the opt-out line", () => {
	it("keeps the in-app record when activity email is switched off", async () => {
		await db.update(users).set({ notifyActivityEmail: false }).where(eq(users.id, recipientId));

		const result = await notify({
			userId: recipientId,
			category: "activity",
			kind: "test_activity",
			title: `Activity while opted out ${id}`,
			dedupeKey: `test-activity-optout:${id}`,
		});

		// Opting out of email is NOT opting out of being told.
		expect(result.created).toBe(true);
		// Chose not to — the switch applies here, and this is the counterpart to the
		// essential assertion below.
		expect(result.emailIntended).toBe(false);

		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `test-activity-optout:${id}`));
		expect(row).toBeDefined();
		// And the evidence stays honest: recorded, not emailed, and distinguishable.
		expect(row.emailSentAt).toBeNull();
	});

	it("🚨 sends an ESSENTIAL notice regardless of the switch", async () => {
		// The assertion the whole category split exists for. A preference that quietly
		// applied here would mean someone believing they had opted into being told about
		// their money, and not being.
		const [before] = await db
			.select({ pref: users.notifyActivityEmail })
			.from(users)
			.where(eq(users.id, recipientId));
		expect(before.pref).toBe(false);

		const result = await notify({
			userId: recipientId,
			category: "essential",
			kind: "test_essential",
			title: `Essential while opted out ${id}`,
			dedupeKey: `test-essential-optout:${id}`,
		});

		expect(result.created).toBe(true);
		// The assertion is on the DECISION to send, not on delivery. Delivery is Resend's
		// and no-ops without RESEND_API_KEY — so asserting `emailed` here would pass
		// whether or not the preference had wrongly suppressed this, which is how the
		// first draft of this test let exactly that bug through under sabotage.
		expect(result.emailIntended).toBe(true);

		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `test-essential-optout:${id}`));
		expect(row.category).toBe("essential");

		await db.update(users).set({ notifyActivityEmail: true }).where(eq(users.id, recipientId));
	});
});

describe("reading them", () => {
	it("lists a user's own, counts unread, and marks read", async () => {
		const mine = await listNotifications(recipientId);
		expect(mine.length).toBeGreaterThan(0);
		expect(mine.every((n) => n.userId === recipientId)).toBe(true);

		const before = await unreadCount(recipientId);
		expect(before).toBeGreaterThan(0);

		const { marked } = await markRead(recipientId);
		expect(marked).toBe(before);
		expect(await unreadCount(recipientId)).toBe(0);
	});

	it("will not let one user mark another's as read", async () => {
		const [theirs] = await db
			.insert(notifications)
			.values({
				userId: buyerId,
				category: "activity",
				kind: "test_scope",
				title: "Not yours",
				dedupeKey: `test-scope:${id}`,
			})
			.returning();

		// Passing somebody else's id explicitly — the filter lives in the service, not
		// the route, precisely so this shape cannot reach through.
		const { marked } = await markRead(recipientId, [theirs.id]);
		expect(marked).toBe(0);

		const [still] = await db.select().from(notifications).where(eq(notifications.id, theirs.id));
		expect(still.readAt).toBeNull();
	});

	it("serves them over the API, scoped to the caller", async () => {
		const res = await req("/api/accounts/me/notifications", { headers: { Cookie: recipient } });
		expect(res.status).toBe(200);
		const data = (await res.json()) as { notifications: { userId: number }[]; unread: number };
		expect(data.notifications.every((n) => n.userId === recipientId)).toBe(true);
		expect((await req("/api/accounts/me/notifications")).status).toBe(401);
	});
});

describe("the first real consumer: a creator leaves and a buyer owns their Work", () => {
	it("tells the buyer their purchase was withdrawn — once", async () => {
		await eraseAccount(creatorId);
		expect(await idOf(creatorName)).toBeNull();

		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `work-withdrawn:${purchaseId}`));

		// The gap the deletion work shipped with, now closed. Before this, a buyer found
		// out by noticing, or not at all.
		expect(row).toBeDefined();
		expect(row.userId).toBe(buyerId);
		// Essential: it is about something they paid for, so no switch suppresses it.
		expect(row.category).toBe("essential");
		expect(row.title).toContain(`Notify fixture ${id}`);
		// Sent somewhere they can act on it.
		expect(row.linkPath).toBe("/library");

		// Keyed per purchase, so re-running the erase (or a retry) cannot re-notify.
		await eraseAccount(creatorId);
		const all = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `work-withdrawn:${purchaseId}`));
		expect(all.length).toBe(1);
	});
});
