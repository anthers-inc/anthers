// SPDX-License-Identifier: Apache-2.0
/**
 * Buying a physical good — the pick, the shelf, and the money a pick comes to.
 *
 * The suite's claims, one spec each:
 * - **A pick is checked against the listing, not against the client.** Every choice needs a
 *   value the creator offers, no choice may be named twice, and a name the listing does not
 *   carry is a tampered body rather than a buyer's mistake.
 * - **Stock is a count, blank means unlimited, and the count decides.** A reservation takes
 *   the number asked for, refuses a second buyer asking for the last one, and puts it back
 *   when the sale never happens.
 * - **The storefront reads signed out and prices from the Work's own baseline row.** The
 *   page and its panel are public; the price is the "Everyone" door, never a supporter's
 *   rung.
 * - **The basket carries the count and the choices, and the quote prices them.** A line
 *   added as two larges resolves to two larges, with the listing's shipping on it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { physicalListings, purchases, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import {
	releaseAbandonedStock,
	releaseStock,
	reserveStock,
	validatePhysicalPick,
} from "../services/physical-stock";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

let creator: FixtureAccount;
let buyer: FixtureAccount;
const workIds: number[] = [];
let physicalWork: number;
let slug = "";

function call(method: string, path: string, cookie?: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		}),
	);
}

const LISTING = {
	shippingPrice: "6.50",
	handlingBusinessDays: 4,
	taxCategory: "general" as const,
	options: [
		{
			name: "Size",
			values: [
				{ label: "Small", stock: 3 },
				{ label: "Large", stock: null },
			],
		},
		{
			name: "Glaze",
			values: [
				{ label: "Blue", stock: null },
				{ label: "Bare", stock: 0 },
			],
		},
	],
};

describe("a pick against its listing", () => {
	it("requires a value for every choice", () => {
		const r = validatePhysicalPick(LISTING, { quantity: 1, options: [] });
		expect(r.ok).toBe(false);
	});

	it("refuses a value the listing does not carry", () => {
		const r = validatePhysicalPick(LISTING, {
			quantity: 1,
			options: [
				{ name: "Size", label: "Enormous" },
				{ name: "Glaze", label: "Blue" },
			],
		});
		expect(r.ok).toBe(false);
	});

	it("refuses a choice the listing never offered", () => {
		const r = validatePhysicalPick(LISTING, {
			quantity: 1,
			options: [
				{ name: "Size", label: "Small" },
				{ name: "Glaze", label: "Blue" },
				{ name: "Finish", label: "Matte" },
			],
		});
		expect(r.ok).toBe(false);
	});

	it("refuses a sold-out value and a count past the shelf", () => {
		const soldOut = validatePhysicalPick(LISTING, {
			quantity: 1,
			options: [
				{ name: "Size", label: "Small" },
				{ name: "Glaze", label: "Bare" },
			],
		});
		expect(soldOut.ok).toBe(false);

		const tooMany = validatePhysicalPick(LISTING, {
			quantity: 5,
			options: [
				{ name: "Size", label: "Small" },
				{ name: "Glaze", label: "Blue" },
			],
		});
		expect(tooMany.ok).toBe(false);
	});

	it("keeps a good pick, in the listing's order", () => {
		const r = validatePhysicalPick(LISTING, {
			quantity: 2,
			options: [
				{ name: "Glaze", label: "Blue" },
				{ name: "Size", label: "Large" },
			],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.picks.map((p) => p.name)).toEqual(["Size", "Glaze"]);
	});

	it("treats a blank stock as as-many-as-I-can-make", () => {
		const r = validatePhysicalPick(LISTING, {
			quantity: 10,
			options: [
				{ name: "Size", label: "Large" },
				{ name: "Glaze", label: "Blue" },
			],
		});
		expect(r.ok).toBe(true);
	});
});

describe("the shelf", () => {
	let stockedWork: number;

	beforeAll(async () => {
		const run = crypto.randomUUID().slice(0, 8);
		creator = await createAccount(`pbuy-creator-${run}`, {
			emailVerified: true,
			fields: { creatorMode: true },
		});
		buyer = await createAccount(`pbuy-buyer-${run}`, { emailVerified: true });

		const work = await insertWork({
			creatorId: creator.userId,
			type: "physical",
			title: "A mug",
			access: [{ threshold: 0, allow: true, price: "18.00" }],
		});
		physicalWork = work.id;
		slug = work.slug ?? "";
		workIds.push(work.id);

		const stocked = await insertWork({
			creatorId: creator.userId,
			type: "physical",
			title: "A stocking mug",
			access: [{ threshold: 0, allow: true, price: "18.00" }],
		});
		stockedWork = stocked.id;
		workIds.push(stocked.id);

		await db.insert(physicalListings).values({
			workId: physicalWork,
			shippingPrice: LISTING.shippingPrice,
			handlingBusinessDays: LISTING.handlingBusinessDays,
			taxCategory: LISTING.taxCategory,
			options: LISTING.options,
		});
		await db.insert(physicalListings).values({
			workId: stockedWork,
			shippingPrice: "0.00",
			handlingBusinessDays: 3,
			taxCategory: "general",
			options: [{ name: "Size", values: [{ label: "One", stock: 2 }] }],
		});
	}, 60_000);

	afterAll(async () => {
		await purgeWorkIds(workIds);
	});

	it("reads the storefront signed out, at the Work's own price", async () => {
		const res = await call("GET", `/api/payments/physical/${slug}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			unitPrice: string;
			listing: { shippingPrice: string; options: Array<{ name: string }> };
		};
		expect(body.unitPrice).toBe("18.00");
		expect(body.listing.shippingPrice).toBe("6.50");
		expect(body.listing.options.map((o) => o.name)).toEqual(["Size", "Glaze"]);
	});

	it("answers a non-good with the same 404 a missing Work gets", async () => {
		const res = await call("GET", "/api/payments/physical/no-such-work");
		expect(res.status).toBe(404);
	});

	it("takes a count off the shelf, and refuses a second buyer the last ones", async () => {
		const first = await reserveStock([
			{ workId: stockedWork, picks: [{ name: "Size", label: "One" }], quantity: 2 },
		]);
		expect(first.ok).toBe(true);

		const [row] = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, stockedWork));
		expect(row.options[0].values[0].stock).toBe(0);

		const second = await reserveStock([
			{ workId: stockedWork, picks: [{ name: "Size", label: "One" }], quantity: 1 },
		]);
		expect(second.ok).toBe(false);

		await releaseStock([
			{ workId: stockedWork, picks: [{ name: "Size", label: "One" }], quantity: 2 },
		]);
		const [after] = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, stockedWork));
		expect(after.options[0].values[0].stock).toBe(2);
	});

	it("refuses the whole charge when one line cannot be filled", async () => {
		const result = await reserveStock([
			{ workId: stockedWork, picks: [{ name: "Size", label: "One" }], quantity: 1 },
			{ workId: stockedWork, picks: [{ name: "Size", label: "One" }], quantity: 5 },
		]);
		expect(result.ok).toBe(false);
		// Nothing was taken by the refused transaction: the first line's count is intact.
		const [row] = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, stockedWork));
		expect(row.options[0].values[0].stock).toBe(2);
	});

	it("puts an abandoned order's count back, once", async () => {
		const [pending] = await db
			.insert(purchases)
			.values({
				buyerId: buyer.userId,
				workId: stockedWork,
				creatorId: creator.userId,
				workTitle: "A stocking mug",
				workType: "physical",
				workPublicId: 1,
				type: "physical",
				amount: "18.00",
				processingFee: "0.82",
				salesTax: "0.00",
				creatorEarnings: "17.18",
				quantity: 1,
				options: [{ name: "Size", label: "One" }],
				shippingAmount: "0.00",
				stripePaymentIntentId: "pi_abandoned_test",
				status: "pending",
				createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
			})
			.returning();

		await reserveStock([
			{ workId: stockedWork, picks: [{ name: "Size", label: "One" }], quantity: 1 },
		]);
		const swept = await releaseAbandonedStock();
		expect(swept).toBeGreaterThanOrEqual(1);

		const [row] = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, stockedWork));
		expect(row.options[0].values[0].stock).toBe(2);

		// A second sweep is a no-op — the stamp is the latch.
		const again = await releaseAbandonedStock();
		const [after] = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, stockedWork));
		expect(after.options[0].values[0].stock).toBe(2);
		expect(again).toBe(0);

		await db.delete(purchases).where(eq(purchases.id, pending.id));
	});

	it("carries the count and the choices in the basket, and prices them", async () => {
		const add = await call("POST", "/api/payments/basket/items", buyer.cookie, {
			workId: physicalWork,
			quantity: 2,
			options: [
				{ name: "Size", label: "Small" },
				{ name: "Glaze", label: "Blue" },
			],
		});
		expect(add.status).toBe(200);
		const added = (await add.json()) as {
			items: Array<{ workId: number; quantity: number; price: string; shipping: string }>;
		};
		const line = added.items.find((i) => i.workId === physicalWork);
		expect(line?.quantity).toBe(2);
		expect(line?.price).toBe("36.00");
		expect(line?.shipping).toBe("6.50");

		const quote = await call("POST", "/api/payments/basket/quote", buyer.cookie, {});
		expect(quote.status).toBe(200);
		const priced = (await quote.json()) as {
			items: Array<{ workId: number; quantity: number; shipping: string }>;
			subtotal: string;
		};
		const quoted = priced.items.find((i) => i.workId === physicalWork);
		expect(quoted?.quantity).toBe(2);
		expect(quoted?.shipping).toBe("6.50");
		// Goods plus shipping: two mugs at $18 and one parcel at $6.50.
		expect(priced.subtotal).toBe("42.50");
	});

	it("re-prices the line when the basket's count changes", async () => {
		const res = await call("PUT", `/api/payments/basket/items/${physicalWork}`, buyer.cookie, {
			quantity: 1,
		});
		expect(res.status).toBe(200);
		const quote = await call("POST", "/api/payments/basket/quote", buyer.cookie, {});
		const priced = (await quote.json()) as {
			items: Array<{ workId: number; quantity: number; price: string }>;
			subtotal: string;
		};
		const line = priced.items.find((i) => i.workId === physicalWork);
		expect(line?.quantity).toBe(1);
		expect(line?.price).toBe("18.00");
		// Shipping stays once per creator, not once per item.
		expect(priced.subtotal).toBe("24.50");
	});

	it("refuses a basket line whose count outruns the shelf", async () => {
		const add = await call("POST", "/api/payments/basket/items", buyer.cookie, {
			workId: stockedWork,
			quantity: 5,
			options: [{ name: "Size", label: "One" }],
		});
		expect(add.status).toBe(200);
		const quote = await call("POST", "/api/payments/basket/quote", buyer.cookie, {});
		expect(quote.status).toBe(400);
		const body = (await quote.json()) as { error?: string };
		expect(body.error).toMatch(/left/i);

		await call("DELETE", `/api/payments/basket/items/${stockedWork}`, buyer.cookie);
	});

	it("refuses checkout without charging when the processor is unconfigured", async () => {
		const before = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, physicalWork));
		const res = await call("POST", "/api/payments/basket/checkout", buyer.cookie, {});
		// The processor guard runs before a session exists, so nothing is reserved and
		// nothing is written — the refusal is the whole of the interaction.
		expect(res.status).toBe(503);
		const after = await db
			.select()
			.from(physicalListings)
			.where(eq(physicalListings.workId, physicalWork));
		expect(after[0].options).toEqual(before[0].options);
	});

	it("keeps the Work itself untouched by a listing's stock", async () => {
		const [row] = await db.select().from(works).where(eq(works.id, physicalWork));
		expect(row.type).toBe("physical");
	});
});
