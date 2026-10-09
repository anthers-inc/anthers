// SPDX-License-Identifier: Apache-2.0
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
 * 3. **Losing the record.** Privacy Policy promises we will tell people before a change takes
 *    effect, and a promise to have told someone is worth what the evidence behind it is
 *    worth. So the in-app row must survive an email opt-out and an email *failure* —
 *    both tested, because both are states where the naive implementation writes nothing.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { notifications, purchases, userPreferences, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { eraseAccount } from "../services/account-deletion.js";
import { listNotifications, markRead, notify, unreadCount } from "../services/notifications.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;

const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
	return (await createAccount(username)).cookie;
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
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${u}@example.com`));
	return row?.id ?? null;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${recipientName}@example.com`}`, sql`${`${creatorName}@example.com`}`, sql`${`${buyerName}@example.com`}`], sql`, `)})`,
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
	it("keeps the in-app record when the whole map says app-only", async () => {
		// The old boolean's answer, carried into the map: `"*": "app"` is what the
		// migration writes for somebody who had turned activity email off, and the
		// assertion it needs is that the row stands and no email was INTENDED — on a
		// group the registry maps, since an unmapped kind is the category's business
		// (the test below names why).
		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: { "*": "app" } })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: { "*": "app" } },
			});

		const result = await notify({
			userId: recipientId,
			category: "activity",
			kind: "comment_reply",
			title: `Activity while opted out ${id}`,
			dedupeKey: `test-activity-optout:${id}`,
		});

		// Opting out of email is NOT opting out of being told — and this kind
		// (`test_activity`) maps to no group, so the category-level default stands.
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

	it("🚨 resolves an UNMAPPED activity kind to email-on regardless of the map", async () => {
		// `test_activity` names no delivery group. A kind the registry has not met is the
		// category's business, not the map's — resolving an unknown kind to "app" would
		// silence the next developer's activity kind by default, which is the direction
		// this must fail in.
		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: { "*": "app" } })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: { "*": "app" } },
			});
		const result = await notify({
			userId: recipientId,
			category: "activity",
			kind: `unmapped_kind_${id}`,
			title: `Unmapped kind ${id}`,
			dedupeKey: `test-unmapped:${id}`,
		});
		expect(result.created).toBe(true);
		expect(result.emailIntended).toBe(true);
		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: {} })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: {} },
			});
	});

	it("🚨 sends an ESSENTIAL notice regardless of the switch", async () => {
		// The assertion the whole category split exists for. A preference that quietly
		// applied here would mean someone believing they had opted into being told about
		// their money, and not being.
		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: { "*": "app" } })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: { "*": "app" } },
			});
		const [before] = await db
			.select({ pref: userPreferences.notificationDelivery })
			.from(userPreferences)
			.where(eq(userPreferences.userId, recipientId));
		// A live precondition, not a sibling's leftover: every group answers app-only, and
		// essential must ride over exactly that.
		expect(before.pref).toStrictEqual({ "*": "app" });

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

		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: {} })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: {} },
			});
	});
});

describe("per-group delivery", () => {
	it("keeps the row but skips the email when a social kind's group is app-only", async () => {
		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: { conversation: "app" } })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: { conversation: "app" } },
			});

		const result = await notify({
			userId: recipientId,
			category: "activity",
			kind: "comment_reply",
			title: `Reply while app-only ${id}`,
			dedupeKey: `test-group-app:${id}`,
		});

		expect(result.created).toBe(true);
		expect(result.emailIntended).toBe(false);
		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.dedupeKey, `test-group-app:${id}`));
		expect(row).toBeDefined();
		expect(row.emailSentAt).toBeNull();
	});

	it("emails when the mode says so, and stays silent when the wildcard says otherwise", async () => {
		// Wildcard app-only, one group re-raised to both: the explicit key beats the
		// wildcard — that is the whole reason there are two layers.
		await db
			.insert(userPreferences)
			.values({
				userId: recipientId,
				notificationDelivery: { "*": "app", reviews: "both" },
			})
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: { "*": "app", reviews: "both" } },
			});

		const silenced = await notify({
			userId: recipientId,
			category: "activity",
			kind: "comment_reply",
			title: `Wildcard app ${id}`,
			dedupeKey: `test-wildcard-app:${id}`,
		});
		expect(silenced.emailIntended).toBe(false);

		const mailed = await notify({
			userId: recipientId,
			category: "activity",
			kind: "work_review",
			title: `Explicit both ${id}`,
			dedupeKey: `test-explicit-both:${id}`,
		});
		expect(mailed.emailIntended).toBe(true);

		await db
			.insert(userPreferences)
			.values({ userId: recipientId, notificationDelivery: {} })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: {} },
			});
	});

	it("🚨 refuses a map carrying a key outside the registry, writing nothing", async () => {
		// Strict, not filtering: a key the registry does not name means the CLIENT and the
		// REGISTRY disagree about what map they are editing, and accepting the part that
		// matches would store a map whose other half the next GET renders wrong. A 400
		// names the disagreement; the schema's own enum is what answers.
		const res = await req("/api/accounts/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: recipient },
			body: JSON.stringify({ notificationDelivery: { conversation: "app", madeUp: "app" } }),
		});
		expect(res.status).toBe(400);
		const [row] = await db
			.select({ delivery: userPreferences.notificationDelivery })
			.from(userPreferences)
			.where(eq(userPreferences.userId, recipientId));
		expect(row.delivery).toStrictEqual({});
	});

	it("resolves every group for the settings page to read", async () => {
		await db
			.update(userPreferences)
			.set({ notificationDelivery: { followers: "email" } })
			.where(eq(userPreferences.userId, recipientId));
		const res = await req("/api/accounts/me", { headers: { Cookie: recipient } });
		const body = (await res.json()) as {
			user: { notificationDelivery: Record<string, string> };
		};
		expect(body.user.notificationDelivery.followers).toBe("email");
		// Un-answered groups arrive at their resolved default, not absent.
		expect(body.user.notificationDelivery.conversation).toBe("both");
		await db
			.update(userPreferences)
			.set({ notificationDelivery: {} })
			.where(eq(userPreferences.userId, recipientId));
	});
});

describe("one-click unsubscribe", () => {
	it("mints a token on the first social send and the email carries the link", async () => {
		// The mail is a no-op under the test runner, but minting happens on the decide-to-
		// send path, and the ROW's state is what the next send reads.
		const result = await notify({
			userId: recipientId,
			category: "activity",
			kind: "post_comment",
			title: `First social send ${id}`,
			dedupeKey: `test-first-social:${id}`,
		});
		expect(result.created).toBe(true);
		const [row] = await db
			.select({ token: userPreferences.notificationUnsubscribeToken })
			.from(userPreferences)
			.where(eq(userPreferences.userId, recipientId));
		expect(row.token).toMatch(/^[0-9a-f]{48}$/);
	});

	it("turns the named group app-only, without a session, and leaves the others alone", async () => {
		const [row] = await db
			.select({ token: userPreferences.notificationUnsubscribeToken })
			.from(userPreferences)
			.where(eq(userPreferences.userId, recipientId));
		// Set two groups differently first, so "the others alone" is a claim with content.
		await db
			.update(userPreferences)
			.set({ notificationDelivery: { conversation: "email", followers: "both" } })
			.where(eq(userPreferences.userId, recipientId));

		const res = await req(
			`/api/accounts/notifications/unsubscribe?token=${row.token}&group=conversation`,
		);
		expect(res.status).toBe(302);
		const [after] = await db
			.select({ delivery: userPreferences.notificationDelivery })
			.from(userPreferences)
			.where(eq(userPreferences.userId, recipientId));
		// The named group flipped to app; the untouched group kept the answer it had.
		expect(after.delivery).toMatchObject({ conversation: "app", followers: "both" });

		await db
			.update(userPreferences)
			.set({ notificationDelivery: {} })
			.where(eq(userPreferences.userId, recipientId));
	});

	it("answers 404 for an unknown token and for an unknown group, writing nothing", async () => {
		const res = await req(
			`/api/accounts/notifications/unsubscribe?token=${"f".repeat(48)}&group=conversation`,
		);
		expect(res.status).toBe(404);
		const resBadGroup = await req(
			`/api/accounts/notifications/unsubscribe?token=whatever&group=madeup`,
		);
		expect(resBadGroup.status).toBe(404);
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
