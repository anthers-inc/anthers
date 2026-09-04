// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A receipt outlives the thing it bought.
 *
 * `purchases.work_id` was `ON DELETE CASCADE`, so a creator deleting a Work silently
 * destroyed every purchase row naming it — the buyer's entitlement, the financial record,
 * and the `sales_tax` figure that makes remittance reportable. Nothing in the app asked
 * for that deletion or reported it; it was a property of the constraint.
 *
 * The fix has three parts and this file covers all of them, because each alone is
 * insufficient:
 *   1. the delete REFUSES when someone has bought the Work, unless forced;
 *   2. forcing it WITHDRAWS rather than destroys — out of public circulation, still
 *      served to the people who bought it, which is the actual ruling: *if a user
 *      purchases something, they own it, regardless of what the creator does*; and
 *   3. the purchase row survives regardless, carrying its own snapshot of what was
 *      bought and who was paid — so it still reads once the Work row does go, which it
 *      eventually will when the rescue window expires.
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

async function signUp(username: string) {
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

	it("withdraws rather than destroys when the delete is forced, and the buyer keeps it", async () => {
		const { work, purchase } = await soldWork(`Withdrawn Game ${id}`);

		const res = await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		// 200, not 204 — the Work was not deleted, and the caller is told so.
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ withdrawn: true, purchaseCount: 1 });

		// The row and its media survive; only its circulation changed.
		const [kept] = await db.select().from(works).where(eq(works.id, work.id));
		expect(kept).toBeTruthy();
		expect(kept.visibility).toBe("withdrawn");
		expect(kept.withdrawnAt).toBeTruthy();

		// THE RULING: the buyer still has what they paid for.
		const asBuyer = await req(`/api/content/works/${work.id}`, {
			headers: { Cookie: buyerCookie },
		});
		expect(asBuyer.status).toBe(200);
		expect((await asBuyer.json()).work.title).toBe(`Withdrawn Game ${id}`);

		// And the receipt is of course still intact.
		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.workId).toBe(work.id);
		expect(row.creatorId).toBe(creatorId);
		expect(row.salesTax).toBe("0.41");
	});

	it("hides a withdrawn Work from the public, and from a stranger who never bought it", async () => {
		const { work } = await soldWork(`Gone Public ${id}`);
		await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});

		// Signed out.
		const anon = await req(`/api/content/works/${work.id}`);
		expect(anon.status).toBe(404);

		// Signed in, but not a buyer — 404 rather than 403, matching how the rest of the
		// route treats non-public work: its existence isn't public information.
		const strangerName = `psd_stranger_${crypto.randomUUID().slice(0, 6)}`;
		const strangerCookie = await signUp(strangerName);
		const stranger = await req(`/api/content/works/${work.id}`, {
			headers: { Cookie: strangerCookie },
		});
		expect(stranger.status).toBe(404);

		// And it is out of the public Catalog, which filters *for* released.
		const catalog = await req(`/api/content/catalog/${creatorName}`, {
			headers: { Cookie: strangerCookie },
		});
		const listed = (await catalog.json()).works as { id: number }[];
		expect(listed.some((w) => w.id === work.id)).toBe(false);
	});

	it("hard-deletes a Work whose only purchase never completed", async () => {
		// A pending or failed charge bought nothing, so there is nobody to protect and
		// withdrawal would just be litter. The guard counts COMPLETED purchases only.
		const work = await insertWork({ creatorId, type: "game", title: `Pending ${id}` });
		await db.insert(purchases).values({
			buyerId,
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
			salesTax: "0.00",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_psd_${crypto.randomUUID().slice(0, 12)}`,
			status: "pending",
		});

		const res = await req(`/api/content/works/${work.id}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(204);
		expect((await db.select().from(works).where(eq(works.id, work.id))).length).toBe(0);
	});

	it("still lists the purchase in the buyer's history once the Work row is genuinely gone", async () => {
		const { work, purchase } = await soldWork(`Vanishing Game ${id}`);
		// The route no longer destroys a purchased Work, so this deletes the row directly
		// to stand in for the one thing that eventually will: the rescue window expiring.
		// That sweep isn't built, but the receipt has to outlive it when it is.
		await db.delete(works).where(eq(works.id, work.id));

		const res = await req("/api/payments/purchases", { headers: { Cookie: buyerCookie } });
		expect(res.status).toBe(200);
		const { purchases: listed } = await res.json();

		// The inner join through `works` used to drop this row entirely, so the buyer's
		// own receipt disappeared from the one place they can see it.
		const row = listed.find((p: { id: number }) => p.id === purchase.id);
		expect(row).toBeTruthy();
		expect(row.work.title).toBe(`Vanishing Game ${id}`);
		expect(row.work.type).toBe("game");
		// Slug, publicId and cover come from the join and are honestly null — there is no
		// page left, and `publicId` is what the client reads to decide whether to offer a
		// link at all. The SNAPSHOT publicId stays on the row for reconciliation; it must
		// not be what gets rendered, or the buyer is handed a link straight to a 404.
		expect(row.work.slug).toBeNull();
		expect(row.work.publicId).toBeNull();
		expect(row.workPublicId).toBe(work.publicId);
		// The creator is resolved from purchases.creatorId, not through the dead Work.
		expect(row.creator.username).toBe(creatorName);
	});

	it("counts the sale toward the creator's earnings even once the Work row is gone", async () => {
		const { work } = await soldWork(`Earnings Game ${id}`);
		const before = await db
			.select({ total: sql<string>`coalesce(sum(${purchases.creatorEarnings}), 0)` })
			.from(purchases)
			.where(and(eq(purchases.creatorId, creatorId), eq(purchases.status, "completed")));

		await db.delete(works).where(eq(works.id, work.id));

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

	it("gives the buyer a live publicId, so the Library can link back to what they bought", async () => {
		// The ruling is that a buyer owns it *in their library*, and a library entry that
		// leads nowhere does not satisfy it. This endpoint never returned `publicId` at all
		// after the Works rename, so both the Library and Purchases pages fell through to
		// their `/posts/{slug}` fallback — a different route serving a different entity, so
		// EVERY purchase led to a not-found page. Typecheck could not catch it: the field
		// was declared optional.
		const { work, purchase } = await soldWork(`Linkable Game ${id}`);

		const res = await req("/api/payments/purchases", { headers: { Cookie: buyerCookie } });
		const row = (await res.json()).purchases.find((p: { id: number }) => p.id === purchase.id) as {
			work: { publicId: number; slug: string; visibility: string };
		};

		expect(row.work.publicId).toBe(work.publicId);
		expect(row.work.slug).toBe(work.slug);
		expect(row.work.visibility).toBe("released");

		// And that link resolves — the pair is what `/works/{slug}-{publicId}` is built from.
		const opened = await req(`/api/content/works/${work.slug}-${work.publicId}`, {
			headers: { Cookie: buyerCookie },
		});
		expect(opened.status).toBe(200);
	});

	it("keeps the link, and says it is withdrawn, once the creator pulls it", async () => {
		const { work, purchase } = await soldWork(`Withdrawn Link ${id}`);
		await req(`/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});

		const res = await req("/api/payments/purchases", { headers: { Cookie: buyerCookie } });
		const row = (await res.json()).purchases.find((p: { id: number }) => p.id === purchase.id) as {
			work: { publicId: number; visibility: string };
		};

		// Still openable — that is the whole point of withdrawal — but the buyer is owed
		// the fact that it left circulation, since the rescue window will eventually end.
		expect(row.work.publicId).toBe(work.publicId);
		expect(row.work.visibility).toBe("withdrawn");
	});

	it("lists a support top-up as a receipt that bought no Work, and says so in `type`", async () => {
		// A support top-up is a real charge with a real receipt, so it belongs in Purchases — it
		// only started appearing when `0016` stopped this endpoint dropping every row with
		// no Work. But it unlocks nothing, so it does NOT belong in the Library, and the
		// client needs something to tell the two apart. `workId` cannot: it is null here
		// AND null for a Work that has been deleted. `type` is the discriminator.
		const [seedBuy] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId: null,
				creatorId: null,
				type: "seeds",
				amount: "9.00",
				processingFee: "0.56",
				crfFee: "0.00",
				salesTax: "0.00",
				creatorEarnings: "0.00",
				stripePaymentIntentId: `pi_psd_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
			})
			.returning();

		const res = await req("/api/payments/purchases", { headers: { Cookie: buyerCookie } });
		const row = (await res.json()).purchases.find((p: { id: number }) => p.id === seedBuy.id) as {
			type: string;
			work: { title: null; publicId: null };
			creator: { username: null };
		};

		expect(row).toBeTruthy();
		expect(row.type).toBe("seeds");
		// Nothing to name, nothing to open, nobody to credit.
		expect(row.work.title).toBeNull();
		expect(row.work.publicId).toBeNull();
		expect(row.creator.username).toBeNull();
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
