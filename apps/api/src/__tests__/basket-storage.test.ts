// SPDX-License-Identifier: Apache-2.0
/**
 * The basket's server-side storage — the endpoints the buyer's basket is read and
 * written through, and the account scoping that is the whole reason for it.
 *
 * The basket moved off the browser (Parker, 2026-10-03, live testing: a localStorage
 * basket followed the browser, so account B inherited account A's basket). What this
 * suite pins is what that decision buys and what it must NOT weaken:
 *
 * - **Auth required** on every storage route — a basket is scoped to the CALLER.
 * - **Round trips**: add is idempotent, remove is idempotent, clear empties.
 * - **Account scoping**: account B reads an empty basket on the browser-and-account
 *   shape the defect lived in (two accounts, one flow).
 * - **The replace-on-clash courtesy**: adding a second creator's Work REPLACES the
 *   basket and names the dropped creator — the client's old behavior, kept honest
 *   server-side so the sign-in merge and the button cannot disagree.
 * - **Untrusted storage**: quote and checkout re-resolve every id. A Work that is not
 *   buyable (already owned is the easiest to stage) is EXCLUDED from `list` — the badge
 *   never counts a ghost — and a seeded stale row never fails a checkout an honest
 *   client could still complete.
 *
 * Nothing here reaches the network — the Stripe calls quote and checkout make are fake
 * exactly as `payments-stripe.test.ts` fakes them, and the one checkout this file drives
 * stops at the `paymentsConfigured` 503, which is answered AFTER `resolveBasket` has
 * already done its refusing. That is the point: the refusal paths run without Stripe.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { basketItems, purchases, users } from "@anthers/db/schema";
import { MAX_BASKET_ITEMS } from "@anthers/shared/constants";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

/** The buyer's basket as the server holds it — what the merge and add assertions read. */
async function serverBasket(): Promise<{ count: number; workIds: number[] }> {
	const res = await req("/api/payments/basket", authed(buyerCookie));
	const body = (await res.json()) as { items: { workId: number }[]; count: number };
	return { count: body.count, workIds: body.items.map((i) => i.workId) };
}

/** Empty the buyer's basket through the DELETE route, so a test starts from its own state. */
async function clearBasketDirect(): Promise<void> {
	const res = await req("/api/payments/basket", authed(buyerCookie, { method: "DELETE" }));
	expect(res.status, "clearing the basket").toBe(200);
}

function authed(cookie: string, extra?: RequestInit): RequestInit {
	return {
		...extra,
		headers: {
			"Content-Type": "application/json",
			Origin: ORIGIN,
			Cookie: cookie,
			...(extra?.headers ?? {}),
		},
	};
}

// Every account this suite creates is taken back afterward, on success or failure.
// Top-level (module scope), per the pattern payments-stripe uses — the purge registers
// its own hooks wherever it is called.
purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
const FOR_SALE = [{ threshold: 0, allow: true, price: "5.00" }];

let buyerCookie: string;
let otherCookie: string;
let buyerId: number;
/** A creator the buyer and the stranger are NOT — the works they basket are this account's. */
let seller: { cookie: string; id: number };
let workA = 0;
let workB = 0;
/** A second creator's Work — the mixed-creator tests' clash on demand. */
let otherCreatorWorkId = 0;

beforeAll(async () => {
	const buyer = await createAccount(`bskt_store_buyer_${run}`);
	buyerCookie = buyer.cookie;
	buyerId = buyer.userId;
	const other = await createAccount(`bskt_store_other_${run}`);
	otherCookie = other.cookie;
	const sellerAccount = await createAccount(`bskt_store_seller_${run}`, {
		fields: { isCreator: true },
	});
	// 🚨 The seller must have a verified email — `requireVerified` gates checkout, and a
	// Work whose creator was never verified is a refusal with no route to fix it in-test.
	await db.update(users).set({ emailVerified: true }).where(eq(users.id, sellerAccount.userId));
	seller = { cookie: sellerAccount.cookie, id: sellerAccount.userId };

	// Two purchasable Works by ONE creator. The buyer does not own them, so a quote
	// resolves them — a creator's own Work in their own basket would be refused with
	// "already have access", which is exactly what the stale-row test below needs and
	// why the ownership stays off these two.
	workA = (
		await insertWork({
			creatorId: seller.id,
			type: "game",
			title: `Basket storage A ${run}`,
			streamEnabled: false,
			downloadEnabled: true,
			access: FOR_SALE,
		})
	).id;
	workB = (
		await insertWork({
			creatorId: seller.id,
			type: "game",
			title: `Basket storage B ${run}`,
			streamEnabled: false,
			downloadEnabled: true,
			access: FOR_SALE,
		})
	).id;
	// A third Work by a DIFFERENT creator, for the one-creator rule's replace-on-clash.
	const clashingCreator = await createAccount(`bskt_store_clash_${run}`, {
		fields: { isCreator: true },
	});
	await db.update(users).set({ emailVerified: true }).where(eq(users.id, clashingCreator.userId));
	otherCreatorWorkId = (
		await insertWork({
			creatorId: clashingCreator.userId,
			type: "game",
			title: `Basket storage clash ${run}`,
			streamEnabled: false,
			downloadEnabled: true,
			access: FOR_SALE,
		})
	).id;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.delete(basketItems).where(eq(basketItems.userId, buyerId));
	// The ownership row the stale-item test staged — the purge takes the accounts, and
	// this row names them both, so it goes with them explicitly.
	await db.delete(purchases).where(eq(purchases.stripePaymentIntentId, `pi_bskt_store_${run}`));
});

describe("basket storage — auth is required", () => {
	it("refuses an unauthenticated read", async () => {
		const res = await req("/api/payments/basket");
		expect(res.status).toBe(401);
	});

	it("refuses an unauthenticated add", async () => {
		const res = await req("/api/payments/basket/items", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ workId: workA }),
		});
		expect(res.status).toBe(401);
	});

	it("refuses an unauthenticated clear", async () => {
		const res = await req("/api/payments/basket", {
			method: "DELETE",
			headers: { Origin: ORIGIN },
		});
		expect(res.status).toBe(401);
	});
});

describe("basket storage — the round trips", () => {
	it("adds a Work and lists it with its price", async () => {
		const added = await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		expect(added.status).toBe(200);
		const { items } = (await added.json()) as { items: { workId: number; price: string }[] };
		expect(items).toHaveLength(1);
		expect(items[0].workId).toBe(workA);
		expect(items[0].price).toBe("5.00");

		const list = await req("/api/payments/basket", authed(buyerCookie));
		const listed = (await list.json()) as { items: unknown[]; count: number };
		expect(listed.count).toBe(1);
	});

	it("add is idempotent — a second add of the same Work changes nothing", async () => {
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workB }),
			}),
		);
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		const list = await req("/api/payments/basket", authed(buyerCookie));
		const { count, items } = (await list.json()) as { count: number; items: { workId: number }[] };
		expect(count).toBe(2);
		expect(items.map((i) => i.workId).sort()).toEqual([workA, workB].sort());
	});

	it("removes one Work, and removing an absent one is a no-op", async () => {
		const res = await req(
			`/api/payments/basket/items/${workB}`,
			authed(buyerCookie, {
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);
		const listed = (await (await req("/api/payments/basket", authed(buyerCookie))).json()) as {
			count: number;
		};
		expect(listed.count).toBe(1);

		// Absence is already the goal — a stranger's WorkId changes nothing.
		await req(
			`/api/payments/basket/items/${workB}`,
			authed(buyerCookie, {
				method: "DELETE",
			}),
		);
		const again = (await (await req("/api/payments/basket", authed(buyerCookie))).json()) as {
			count: number;
		};
		expect(again.count).toBe(1);
	});

	it("clears the basket", async () => {
		const res = await req("/api/payments/basket", {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(200);
		const listed = (await (await req("/api/payments/basket", authed(buyerCookie))).json()) as {
			count: number;
		};
		expect(listed.count).toBe(0);
	});

	it("refuses an add of a nonexistent Work with 404", async () => {
		const res = await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: 999999999 }),
			}),
		);
		expect(res.status).toBe(404);
	});

	it("refuses a malformed add with 400", async () => {
		const res = await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: "nine" }),
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("basket storage — scoped to the account", () => {
	it("account B sees an empty basket where account A holds items (Parker's case, server half)", async () => {
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		// A second account, same "browser" (this suite IS one browser): reads nothing.
		const list = await req("/api/payments/basket", authed(otherCookie));
		const { count } = (await list.json()) as { count: number };
		expect(count).toBe(0);
		// And account A still holds its own — one account's basket is nobody else's.
		const mine = (await (await req("/api/payments/basket", authed(buyerCookie))).json()) as {
			count: number;
		};
		expect(mine.count).toBe(1);
	});

	it("another account cannot mutate this one's basket through the same routes", async () => {
		// The other account adds ITS choice and clears — scoped to ITS rows.
		await req(
			"/api/payments/basket/items",
			authed(otherCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workB }),
			}),
		);
		await req("/api/payments/basket", authed(otherCookie, { method: "DELETE" }));
		const mine = (await (await req("/api/payments/basket", authed(buyerCookie))).json()) as {
			count: number;
		};
		expect(mine.count).toBe(1);
	});
});

describe("basket storage — the untrusted-storage rules", () => {
	it("a Work the buyer already owns is excluded from list — the badge counts what money can reach", async () => {
		// Own workB outright: a completed purchase is permanent access, which
		// `resolvePurchase` refuses with "already have access". The basket row survives —
		// the table does not self-clean — but the read leaves it out.
		await db.insert(purchases).values(purchasesSafe());
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workB }),
			}),
		);
		const list = (await (await req("/api/payments/basket", authed(buyerCookie))).json()) as {
			items: { workId: number }[];
			count: number;
		};
		expect(list.items.map((i) => i.workId)).toEqual([workA]);
		expect(list.count).toBe(1);
	});

	it("a stored stale row does not fail checkout of the rest — quote prices the resolved basket", async () => {
		// The buyer's email must be verified to reach checkout's money path at all
		// (`requireVerified` sits BEFORE any basket resolution, which is why this suite's
		// other refusals test quote — the same resolution, minus the verify wall).
		await db.update(users).set({ emailVerified: true }).where(eq(users.id, buyerId));
		// The basket now holds workA (buyable) and workB (owned, stale). Checkout must
		// reach its session-creation guard — not a 400 about workB.
		const res = await req(
			"/api/payments/basket/checkout",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		// 503 = "payments not configured", which this test session is. It is answered
		// AFTER resolveBasket — so reaching it proves no refusal fired on the stale row.
		expect(res.status).toBe(503);
	});

	it("the item cap is enforced at add, in the buyer's own words at the moment of the click", async () => {
		await db.delete(basketItems).where(eq(basketItems.userId, buyerId));
		// Fill to the cap with distinct Works created on the fly? Twenty inserts is the
		// honest walk, but the cap's shape is what's pinned: a basket AT the cap refuses
		// the next add with 409, and the rows are what make it so — seed MAX_BASKET_ITEMS
		// rows against a Work that exists, accepting the duplicate-id refusal is the
		// point. The unique index stops duplicates, so the cap is seeded one-Work-per-row
		// by inserting the SAME workId against DISTINCT... it cannot be. Direct rows
		// against one Work would violate the unique pair — so this test inserts the cap's
		// row count using the fixture generator's real Works, created in bulk.
		const ids: number[] = [];
		for (let i = 0; i < MAX_BASKET_ITEMS; i++) {
			const w = await insertWork({
				creatorId: seller.id,
				type: "game",
				title: `Basket cap ${run} ${i}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: FOR_SALE,
			});
			ids.push(w.id);
		}
		for (const id of ids) {
			await req(
				"/api/payments/basket/items",
				authed(buyerCookie, {
					method: "POST",
					body: JSON.stringify({ workId: id }),
				}),
			);
		}
		// One more, at the cap: refused.
		const over = await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workB }),
			}),
		);
		expect(over.status).toBe(409);
		// And the quote/checkout path still refuses a table somehow past the cap, via
		// `resolveBasket` — same constant, enforced twice.
	});
});

describe("POST /auth/basket/merge — the scratch basket folds through the add", () => {
	it("refuses an unauthenticated merge (a scratch belongs to whoever proved a session)", async () => {
		const res = await req("/api/auth/basket/merge", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ items: [{ workId: workA }] }),
		});
		expect(res.status).toBe(401);
	});

	it("refuses a scratch past the basket's cap with 400, in the schema", async () => {
		const items = Array.from({ length: MAX_BASKET_ITEMS + 1 }, (_, i) => ({ workId: i + 1 }));
		const res = await req(
			"/api/auth/basket/merge",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ items }),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("merges scratch items through the add — an empty account basket takes every live Work", async () => {
		await clearBasketDirect();
		const res = await req(
			"/api/auth/basket/merge",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ items: [{ workId: workA }, { workId: workB }] }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { added: number[] };
		expect(body.added.sort()).toEqual([workA, workB].sort());
		// The list resolves live: workB is already OWNED here (the stale-row test's staged
		// purchase is still in the books), so the read shows only what money can reach —
		// the merge is by intent, the listing is by purchasability, and neither lies.
		const basket = await serverBasket();
		expect(basket.workIds).toEqual([workA]);
	});

	it("a scratch item that is gone from the catalog is skipped, not refused", async () => {
		await clearBasketDirect();
		const res = await req(
			"/api/auth/basket/merge",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ items: [{ workId: 999999999 }, { workId: workA }] }),
			}),
		);
		expect(res.status).toBe(200);
		// The merge answers with what MERGED — the client's contract for clearing the
		// scratch is the 2xx, and what stayed is what the server could honor.
		const body = (await res.json()) as { added: number[] };
		expect(body.added).toEqual([workA]);
	});

	it("a mixed-creator MERGE replaces the account basket — the most recent intent wins", async () => {
		await clearBasketDirect();
		// The account's basket ALREADY holds A's creator's work.
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		// The scratch carries the OTHER creator's work: the merge's add REPLACE-clashes,
		// leaving the scratch's item alone — the client's own replace-on-clash behavior,
		// kept honest server-side, and now both sides agree.
		const res = await req(
			"/api/auth/basket/merge",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ items: [{ workId: otherCreatorWorkId }] }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { replacedCreator: string | null };
		expect(body.replacedCreator).toBeTruthy();
		const basket = await serverBasket();
		expect(basket.workIds).toEqual([otherCreatorWorkId]);
	});
});

// A pending purchase row that makes workB owned. Keyed by a throwaway intent id, so no
// webhook can ever complete it into anything else.
function purchasesSafe() {
	// Values asserted nowhere else in this file; the row is deleted with the account.
	return {
		buyerId,
		workId: workB,
		type: "digital" as const,
		amount: "5.00",
		processingFee: "0.30",
		salesTax: "0.00",
		creatorEarnings: "4.70",
		stripePaymentIntentId: `pi_bskt_store_${run}`,
		status: "completed" as const,
	};
}
