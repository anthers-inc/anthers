// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A buyer is told when the creator withdraws what they bought.
 *
 * 🚨 **This closes an asymmetry rather than adding a feature, and the asymmetry is the
 * thing to keep asserted.** `services/account-deletion.ts` has notified buyers since
 * 2026-08-10 when a departing creator's Works are withdrawn. The ordinary withdrawal — a
 * creator deleting a purchased Work from the Studio — reached the same outcome for the
 * same buyer and told them **nothing**. Same buyer, same Work, same loss of public
 * circulation; which one you were told about depended on why the creator did it.
 *
 * ⚠️ **The dedupe key is shared with the account-deletion path on purpose**, so the last
 * case here is not a nicety: a creator who withdraws a Work and later closes their account
 * must not mail the buyer twice about one withdrawal. Asserting the *count* is what makes
 * that provable — a test that only checked a notification exists would pass against an
 * implementation that sent three.
 *
 * ⭐ **The notice is `essential`.** Its entire value is arriving before a date, so it has
 * to reach the people who turned activity email off.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { notifications, purchases, users, works } from "@anthers/db/schema";
import { WITHDRAWN_RESCUE_DAYS } from "@anthers/shared/constants";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);
const creatorName = `wwn_creator_${RUN}`;
const buyerName = `wwn_buyer_${RUN}`;
const otherBuyerName = `wwn_buyer2_${RUN}`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
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
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

let creatorCookie: string;
let creatorId = 0;
let buyerId = 0;
let otherBuyerId = 0;

/** A released Work with a completed purchase from each of the buyers named. */
async function soldWork(title: string, buyers: number[]) {
	const work = await insertWork({ creatorId, type: "game", title });
	for (const b of buyers) {
		await db.insert(purchases).values({
			buyerId: b,
			workId: work.id,
			creatorId,
			workTitle: work.title,
			workType: work.type,
			workPublicId: work.publicId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			deliveryFee: "0.00",
			crfFee: "0.00",
			salesTax: "0.41",
			creatorEarnings: "4.53",
			stripePaymentIntentId: `pi_wwn_${crypto.randomUUID().slice(0, 12)}`,
			status: "completed",
		});
	}
	return work;
}

function withdraw(workId: number) {
	return req(`/api/content/works/${workId}?force=1`, {
		method: "DELETE",
		headers: { Origin: ORIGIN, Cookie: creatorCookie },
	});
}

/** Every withdrawal notice this user has, newest first. */
async function noticesFor(userId: number) {
	return db
		.select()
		.from(notifications)
		.where(
			and(eq(notifications.userId, userId), eq(notifications.kind, "work_withdrawn_by_creator")),
		);
}

describe("Withdrawing a purchased Work tells the people who bought it", () => {
	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${otherBuyerName})`,
		);
		creatorCookie = await signUp(creatorName);
		await signUp(buyerName);
		await signUp(otherBuyerName);
		const rows = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(inArray(users.username, [creatorName, buyerName, otherBuyerName]));
		creatorId = rows.find((r) => r.username === creatorName)!.id;
		buyerId = rows.find((r) => r.username === buyerName)!.id;
		otherBuyerId = rows.find((r) => r.username === otherBuyerName)!.id;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${otherBuyerName})`,
		);
	});

	it("🚨 notifies the buyer, who until now was told nothing at all", async () => {
		const work = await soldWork(`Withdrawn ${RUN}`, [buyerId]);
		expect((await withdraw(work.id)).status).toBe(200);

		const notices = await noticesFor(buyerId);
		expect(notices).toHaveLength(1);
		expect(notices[0].title).toContain(`Withdrawn ${RUN}`);
		expect(notices[0].linkPath).toBe("/library");
		// Essential, so it reaches somebody who turned activity email off. The whole
		// value of this notice is arriving before a date.
		expect(notices[0].category).toBe("essential");
	});

	it("⭐ names the deadline the Library card already shows, rather than saying 'at some point'", async () => {
		// A buyer reading the card sees a date. A notice vaguer than the card would be the
		// less useful of two statements of the same promise.
		const [notice] = await noticesFor(buyerId);
		const deadline = new Date();
		deadline.setDate(deadline.getDate() + WITHDRAWN_RESCUE_DAYS);
		expect(notice.body).toContain(
			deadline.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
		);
	});

	it("tells both buyers of the same Work, and each of them once", async () => {
		// `dedupeKey` is unique globally, so a base key that did not vary per purchase
		// would silently deliver to the first buyer and nobody else.
		const work = await soldWork(`Shared ${RUN}`, [buyerId, otherBuyerId]);
		expect((await withdraw(work.id)).status).toBe(200);

		for (const [who, id] of [
			["first buyer", buyerId],
			["second buyer", otherBuyerId],
		] as const) {
			const forThisWork = (await noticesFor(id)).filter((n) => n.title.includes(`Shared ${RUN}`));
			expect(forThisWork, who).toHaveLength(1);
		}
	});

	it("🚨 does not tell them twice when the same withdrawal is processed again", async () => {
		// The case the shared dedupe namespace exists for: a creator withdraws a Work and
		// later closes their account, and `account-deletion.ts` reaches the same purchase.
		// Asserting the count rather than the existence is what makes this provable.
		const work = await soldWork(`Twice ${RUN}`, [buyerId]);
		expect((await withdraw(work.id)).status).toBe(200);
		const after = (await noticesFor(buyerId)).filter((n) => n.title.includes(`Twice ${RUN}`));
		expect(after).toHaveLength(1);

		// Put it back in circulation and withdraw it again — the same purchase, so the
		// same key, so no second notice.
		await db.update(works).set({ visibility: "released" }).where(eq(works.id, work.id));
		expect((await withdraw(work.id)).status).toBe(200);
		const again = (await noticesFor(buyerId)).filter((n) => n.title.includes(`Twice ${RUN}`));
		expect(again).toHaveLength(1);
	});

	it("⚠️ says nothing when nobody bought it, because that is a deletion and not a withdrawal", async () => {
		// The half a notification change is most likely to break: an unpurchased Work is
		// destroyed outright, there is no buyer, and a notice here would be addressed to
		// nobody — or worse, to the creator about their own decision.
		const before = (await noticesFor(buyerId)).length;
		const work = await insertWork({ creatorId, type: "game", title: `Unsold ${RUN}` });
		const res = await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(204);
		expect((await noticesFor(buyerId)).length).toBe(before);
	});
});
