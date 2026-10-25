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
 * - **Multi-creator baskets**: a second creator's Work APPENDS — the basket carries any
 *   number of creators and the merge folds a mixed scratch in without dropping anything
 *   (the replace-on-clash rule was removed with the 2026-10-15 split decision).
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
import { badges, basketItems, purchases, userBadges, users } from "@anthers/db/schema";
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
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
		fields: { creatorMode: true },
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
	// A third Work by a DIFFERENT creator, for the multi-creator append pins.
	const clashingCreator = await createAccount(`bskt_store_clash_${run}`, {
		fields: { creatorMode: true },
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

	it("a mixed-creator MERGE appends — the basket carries both creators (2026-10-15)", async () => {
		await clearBasketDirect();
		// The account's basket ALREADY holds A's creator's work.
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		// The scratch carries the OTHER creator's work: the merge appends it, because a
		// basket carries any number of creators — the replace-on-clash rule this test
		// used to pin is the behavior the multi-creator decision removed, on the client,
		// in the service and here at the merge, all three agreeing.
		const res = await req(
			"/api/auth/basket/merge",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ items: [{ workId: otherCreatorWorkId }] }),
			}),
		);
		expect(res.status).toBe(200);
		const basket = await serverBasket();
		expect(basket.workIds).toEqual([workA, otherCreatorWorkId]);
	});

	it("adding a second creator's Work keeps the first — no replace, no announcement", async () => {
		await clearBasketDirect();
		await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: workA }),
			}),
		);
		// The dealbreaker this whole change exists to fix (Parker, 2026-10-15): the add
		// used to wipe the basket for the new creator's Work. It appends now, and the
		// response carries no replaced-creator field at all — the announcement's absence
		// is pinned so the courtesy cannot quietly return.
		const res = await req(
			"/api/payments/basket/items",
			authed(buyerCookie, {
				method: "POST",
				body: JSON.stringify({ workId: otherCreatorWorkId }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { workId: number }[] };
		expect(body.items.map((i) => i.workId)).toEqual([workA, otherCreatorWorkId]);
		expect("replacedCreator" in body).toBe(false);
		const basket = await serverBasket();
		expect(basket.workIds).toEqual([workA, otherCreatorWorkId]);
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

// ─────────────────────────────────────────────────────────────────────────────
// The Badge line — the basket's second item kind (2026-10-15).
//
// A Badge bought from a creator page is a purchase, and its basket line is the rung
// the buyer picked. What pins here is the storage shape and its ONE extra rule: a
// second rung of the same issuer REPLACES the first (the pick replaces, one line per
// ladder — a holding's own shape). Everything about MONEY — the ratchet, the delta,
// the past-due buyer — is the quote's and checkout's refusal at the money door
// (`resolveBadgePurchase` in routes/payments.ts), NOT the add's business: the add
// checks existence and nobody's own ladder, and listing a rung that stopped being
// buyable between add and checkout is exactly as harmless as it is for a Work.

describe("basket storage — the Badge line", () => {
	let secondBuyerCookie: string;
	let secondBuyerId = 0;
	let ladderIssuerId: number;
	let rungA = 0;
	let rungB = 0;

	beforeAll(async () => {
		// A fresh buyer, so the describe owns its basket state (the module's shared
		// buyer's basket is other describes' history).
		const second = await createAccount(`bskt_store_badge_${run}`);
		secondBuyerCookie = second.cookie;
		secondBuyerId = second.userId;
		const issuerAccount = await createAccount(`bskt_store_ladder_${run}`, {
			fields: { creatorMode: true },
		});
		await db.update(users).set({ emailVerified: true }).where(eq(users.id, issuerAccount.userId));
		ladderIssuerId = issuerAccount.userId;
		rungA = (
			await db
				.insert(badges)
				.values({
					creatorId: ladderIssuerId,
					threshold: "6.00",
					label: "Route rung low",
					description: "A fixture rung the badge basket tests hold.",
				})
				.returning({ id: badges.id })
		)[0].id;
		rungB = (
			await db
				.insert(badges)
				.values({
					creatorId: ladderIssuerId,
					threshold: "9.00",
					label: "Route rung high",
					description: "A fixture rung the badge basket tests hold.",
				})
				.returning({ id: badges.id })
		)[0].id;
	}, DB_SETUP_TIMEOUT);

	it("adds a Badge and lists it with the resolved first-transaction and monthly prices", async () => {
		const added = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, {
				method: "POST",
				body: JSON.stringify({ badgeId: rungA }),
			}),
		);
		expect(added.status).toBe(200);
		const { items } = (await added.json()) as {
			items: {
				kind: string;
				badgeId?: number;
				title: string | null;
				price: string;
				recurring: string | null;
				creatorHandle: string;
			}[];
		};
		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("badge");
		expect(items[0].badgeId).toBe(rungA);
		expect(items[0].title).toBe("Route rung low");
		expect(items[0].price).toBe("6.00");
		expect(items[0].recurring).toBe("6.00");
		// The issuer's handle — the issuer is a user id's worth of identity, the same
		// vocabulary a Work line names its creator by. (A session account's handle is
		// its identity on the session's network, not its signup name.)
		expect(items[0].creatorHandle).not.toBe("");

		// The row in the table, badge-keyed — the exactly-one-kind shape.
		const rows = await db.select().from(basketItems).where(eq(basketItems.userId, secondBuyerId));
		expect(rows).toHaveLength(1);
		expect(rows[0].badgeId).toBe(rungA);
		expect(rows[0].workId).toBeNull();
	});

	it("add is idempotent on the same rung, and a SECOND rung of the issuer REPLACES the first", async () => {
		await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, { method: "POST", body: JSON.stringify({ badgeId: rungA }) }),
		);
		// The same rung again — a no-op, like a Work's repeat add.
		const repeat = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, { method: "POST", body: JSON.stringify({ badgeId: rungA }) }),
		);
		expect(repeat.status).toBe(200);
		let listed = (await (await req("/api/payments/basket", authed(secondBuyerCookie))).json()) as {
			count: number;
			items: { badgeId?: number }[];
		};
		expect(listed.count).toBe(1);
		expect(listed.items[0].badgeId).toBe(rungA);

		// 🚨 The pick replaces: a different rung of the SAME ladder leaves exactly one
		// line — the newest — because the basket is the pick being carried, and one
		// holding per issuer means one line per ladder everywhere.
		const upgrade = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, { method: "POST", body: JSON.stringify({ badgeId: rungB }) }),
		);
		expect(upgrade.status).toBe(200);
		listed = (await (await req("/api/payments/basket", authed(secondBuyerCookie))).json()) as {
			count: number;
			items: { badgeId?: number }[];
		};
		expect(listed.count).toBe(1);
		expect(listed.items[0].badgeId).toBe(rungB);
	});

	it("removes a Badge line through its own delete route, idempotently", async () => {
		const res = await req(
			`/api/payments/basket/badges/${rungB}`,
			authed(secondBuyerCookie, { method: "DELETE" }),
		);
		expect(res.status).toBe(200);
		let listed = (await (await req("/api/payments/basket", authed(secondBuyerCookie))).json()) as {
			count: number;
		};
		expect(listed.count).toBe(0);

		// Absence is already the goal.
		const again = await req(
			`/api/payments/basket/badges/${rungB}`,
			authed(secondBuyerCookie, { method: "DELETE" }),
		);
		expect(again.status).toBe(200);
		listed = (await (await req("/api/payments/basket", authed(secondBuyerCookie))).json()) as {
			count: number;
		};
		expect(listed.count).toBe(0);
	});

	it("🚨 refuses the buyer's own ladder at the add — the click's moment, like the cap", async () => {
		const [ownRung] = await db
			.insert(badges)
			.values({ creatorId: secondBuyerId, threshold: "4.00", label: "Own rung" })
			.returning({ id: badges.id });
		const res = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, { method: "POST", body: JSON.stringify({ badgeId: ownRung.id }) }),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error?: string }).error).toMatch(/own Badge/i);
	});

	it("refuses an add naming both or neither — a line names exactly one thing", async () => {
		const both = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, {
				method: "POST",
				body: JSON.stringify({ badgeId: rungA, workId: workA }),
			}),
		);
		expect(both.status).toBe(400);

		const neither = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, { method: "POST", body: "{}" }),
		);
		expect(neither.status).toBe(400);
	});

	/**
	 * 🚨 The table itself holds the shape nothing else defends — the CHECK, not the
	 * service. A hand-rolled write (or a merge bug) must not be able to park a row that
	 * names two kinds, because resolution drops unresolvable rows silently and a
	 * doubly-named row dropped silently would mean money the basket never showed.
	 */
	it("the database refuses a row naming both kinds — the CHECK, not the service", async () => {
		let refused = false;
		try {
			await db.insert(basketItems).values({ userId: secondBuyerId, workId: workA, badgeId: rungA });
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);
	});

	/**
	 * ⚠️ **The ratchet is deliberately NOT the add's refusal.** A rung the buyer already
	 * holds can still be carried — listing it is honest, and the money door
	 * (`resolveBadgePurchase`) stays the one place that decides what is purchasable.
	 * The refusal's shape, once the buyer reaches it, is the resolution's ABSENCE: the
	 * basket read returns only what a checkout could charge, so the row is invisible
	 * rather than an error, and the quote refuses on the empty remainder.
	 */
	it("lets the add succeed on a rung the buyer already holds — the money door answers by absence", async () => {
		await db.insert(userBadges).values({
			userId: secondBuyerId,
			badgeId: rungA,
			billingCycle: cycleKeyFor(new Date()),
		});
		const res = await req(
			"/api/payments/basket/items",
			authed(secondBuyerCookie, { method: "POST", body: JSON.stringify({ badgeId: rungA }) }),
		);
		expect(res.status).toBe(200);

		// The basket read drops the rung the buyer already holds — the same resolution
		// `/basket` has always answered with, badge lines under it.
		const read = (await (await req("/api/payments/basket", authed(secondBuyerCookie))).json()) as {
			count: number;
		};
		expect(read.count).toBe(0);

		// And the quote — asked through the same resolution — refuses the empty remainder.
		const quoted = await req(
			"/api/payments/basket/quote",
			authed(secondBuyerCookie, { method: "POST", body: "{}" }),
		);
		expect(quoted.status).toBe(400);
		expect(((await quoted.json()) as { error?: string }).error).toBe("Your basket is empty");
	});

	// The item cap is one line of shared arithmetic over `listBasket`'s union — the
	// works-side capacity tests above cover it; no badge-specific cap case exists.
});
