// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A receipt outlives the thing it bought.
 *
 * `purchases.work_id` was `ON DELETE CASCADE`, so a creator deleting a Work silently
 * destroyed every purchase row naming it — the buyer's entitlement, the financial record,
 * and the `sales_tax` figure that makes remittance reportable. Nothing in the app asked
 * for that deletion or reported it; it was a property of the constraint.
 *
 * The fix has two halves and this file covers both, because either alone is insufficient:
 *   1. the delete now REFUSES when someone has bought the Work, unless forced; and
 *   2. when it is forced, the purchase row SURVIVES, carrying its own snapshot of what
 *      was bought and who was paid.
 *
 * The snapshot is the part worth testing hardest. `purchases` never had a `creator_id` —
 * the seller was reachable only by joining `works` — so a deleted Work used to take the
 * seller's identity with it, and the sale quietly dropped out of that creator's own
 * earnings maths in `calculate-crf`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases, users, works } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string) {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `psd_creator_${id}`;
const buyerName = `psd_buyer_${id}`;

describe("A purchase survives the Work being deleted", () => {
	let creatorCookie: string;
	let buyerCookie: string;
	let creatorId: number;
	let buyerId: number;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName})`);
		creatorCookie = await signUp(creatorName);
		buyerCookie = await signUp(buyerName);
		const rows = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(sql`${users.username} IN (${creatorName}, ${buyerName})`);
		creatorId = rows.find((r) => r.username === creatorName)!.id;
		buyerId = rows.find((r) => r.username === buyerName)!.id;
	}, DB_SETUP_TIMEOUT);

	/** A released Work with one completed purchase against it. */
	async function soldWork(title: string) {
		const work = await insertWork({ creatorId, type: "game", title });
		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId: work.id,
				creatorId,
				workTitle: work.title,
				workType: work.type,
				workPublicId: work.publicId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				deliveryFee: "0.02",
				crfFee: "0.00",
				salesTax: "0.41",
				creatorEarnings: "4.53",
				stripePaymentIntentId: `pi_psd_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
			})
			.returning();
		return { work, purchase };
	}

	it("refuses to delete a Work someone has bought, and says how many", async () => {
		const { work } = await soldWork(`Sold Game ${id}`);
		const res = await req(`/api/content/works/${work.id}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("work_purchased");
		expect(body.purchaseCount).toBe(1);

		// Refusing means refusing — the Work is still there.
		const [still] = await db.select().from(works).where(eq(works.id, work.id));
		expect(still).toBeTruthy();
	});

	it("keeps the receipt intact when the delete IS forced", async () => {
		const { work, purchase } = await soldWork(`Doomed Game ${id}`);

		const res = await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(204);

		// The Work is gone…
		const workRows = await db.select().from(works).where(eq(works.id, work.id));
		expect(workRows.length).toBe(0);

		// …and the purchase is NOT. Under the old cascade this row no longer existed.
		const [kept] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(kept).toBeTruthy();
		expect(kept.workId).toBeNull(); // the pointer is severed, as SET NULL requires

		// Everything that makes the row a record still reads, with no `works` row to join.
		expect(kept.workTitle).toBe(`Doomed Game ${id}`);
		expect(kept.workType).toBe("game");
		expect(kept.workPublicId).toBe(work.publicId);
		expect(kept.creatorId).toBe(creatorId); // who was paid — previously unrecoverable
		expect(kept.salesTax).toBe("0.41"); // the remittance figure
		expect(kept.creatorEarnings).toBe("4.53");
	});

	it("still lists the purchase in the buyer's history after the Work is gone", async () => {
		const { work, purchase } = await soldWork(`Vanishing Game ${id}`);
		await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});

		const res = await req("/api/payments/purchases", { headers: { Cookie: buyerCookie } });
		expect(res.status).toBe(200);
		const { purchases: listed } = await res.json();

		// The inner join through `works` used to drop this row entirely, so the buyer's
		// own receipt disappeared from the one place they can see it.
		const row = listed.find((p: { id: number }) => p.id === purchase.id);
		expect(row).toBeTruthy();
		expect(row.work.title).toBe(`Vanishing Game ${id}`);
		expect(row.work.type).toBe("game");
		// Slug and cover come from the join and are honestly null — there is no page left.
		expect(row.work.slug).toBeNull();
		// The creator is resolved from purchases.creatorId, not through the dead Work.
		expect(row.creator.username).toBe(creatorName);
	});

	it("counts the sale toward the creator's earnings even after the Work is deleted", async () => {
		const { work } = await soldWork(`Earnings Game ${id}`);
		const before = await db
			.select({ total: sql<string>`coalesce(sum(${purchases.creatorEarnings}), 0)` })
			.from(purchases)
			.where(and(eq(purchases.creatorId, creatorId), eq(purchases.status, "completed")));

		await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});

		const after = await db
			.select({ total: sql<string>`coalesce(sum(${purchases.creatorEarnings}), 0)` })
			.from(purchases)
			.where(and(eq(purchases.creatorId, creatorId), eq(purchases.status, "completed")));

		// This is the sum calculate-crf now takes. Joining through `works` for the
		// creator, as it used to, this total would have fallen by 4.53.
		expect(after[0].total).toBe(before[0].total);
	});

	it("reports the sold count on the delete preflight, so the warning precedes the choice", async () => {
		const { work } = await soldWork(`Preflight Game ${id}`);
		const res = await req(`/api/content/works/${work.id}/usage`, {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.purchaseCount).toBe(1);

		// And zero — not absent — for an unsold Work, so the dialog can tell "none" from
		// "the preflight never answered".
		const clean = await insertWork({ creatorId, type: "game", title: `Clean ${id}` });
		const res2 = await req(`/api/content/works/${clean.id}/usage`, {
			headers: { Cookie: creatorCookie },
		});
		expect((await res2.json()).purchaseCount).toBe(0);
	});

	it("leaves a Work nobody bought deletable without a force flag", async () => {
		const work = await insertWork({ creatorId, type: "game", title: `Unsold ${id}` });
		const res = await req(`/api/content/works/${work.id}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(204);
	});
});
