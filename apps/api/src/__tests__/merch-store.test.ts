// SPDX-License-Identifier: Apache-2.0
/**
 * The store facts a goods listing card shows — `services/merch-store.ts` and the
 * Catalog route's attachment of them.
 *
 * 🚨 **The rule underneath is the goods-works one** (`services/access.ts`, Parker
 * 2026-10-09): a buyable physical Work is never locked presentation, so the facts a
 * lock chip would have replaced have to be exactly what the store shows a visitor —
 * and nothing more. What these tests pin:
 *
 * - **First color's mockup in variant-id order, skipping past a color that stamps
 *   none** — a variant row with no mockup binds anyway (that is the setup script's
 *   cosmetic rule), so the lookup that stopped at it would blank the whole card.
 * - **The cheapest stamped list price, decimal-read** — numeric comes back as string
 *   and the minimum is a comparison, never a float.
 * - **A goods Work with no variants carries no merch key at all** — the card's
 *   placeholder band is the store's absence, not a fabricated null block on every Work.
 * - **The Catalog serializer's verdict for that Work stays `payment_required`** — the
 *   facts describe the store; they never soften the resolver's verdict.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { merchVariants, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { merchStoreFactsByWork } from "../services/merch-store";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure; the
// merch rows cascade away with the Work rows, which cascade with the account.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const _ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const stamp = crypto.randomUUID().slice(0, 8);
const username = `store_facts_${stamp}`;
let creatorHandle = "";
let creatorId = 0;
let shirtId = 0;

beforeAll(async () => {
	const account = await createAccount(username);
	creatorHandle = account.handle;
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${username}@example.com`));
	creatorId = row.id;
	await db.execute(
		sql`UPDATE users SET is_creator = true WHERE email = ${`${username}@example.com`}`,
	);

	const shirt = await insertWork({
		creatorId,
		type: "physical",
		title: `Facts Shirt ${stamp}`,
		access: [{ threshold: 0, allow: true, price: "0" }],
	});
	shirtId = shirt.id;

	// Three colors in variant-id order; the middle color stamps no mockup (the
	// cosmetic-null case the lookup must skip past), and prices are set so the
	// minimum is neither the first nor the last row's.
	await db.insert(merchVariants).values([
		{
			workId: shirt.id,
			color: "Oat",
			size: "M",
			catalogVariantId: 43001,
			syncVariantId: 43001,
			catalogVariantName: "Oat / M",
			catalogPrice: "9.50",
			listPrice: "24.99",
			printFileUrl: "https://files.example/oat.png",
			mockupUrl: "https://cdn.printful.example/oat-mockup.png",
		},
		{
			workId: shirt.id,
			color: "Sand",
			size: "M",
			catalogVariantId: 43002,
			syncVariantId: 43002,
			catalogVariantName: "Sand / M",
			catalogPrice: "9.50",
			listPrice: "12.00",
			printFileUrl: "https://files.example/sand.png",
			mockupUrl: null,
		},
		{
			workId: shirt.id,
			color: "Black",
			size: "M",
			catalogVariantId: 43003,
			syncVariantId: 43003,
			catalogVariantName: "Black / M",
			catalogPrice: "9.50",
			listPrice: "18.00",
			printFileUrl: "https://files.example/black.png",
			mockupUrl: "https://cdn.printful.example/black-mockup.png",
		},
	]);
});

describe("merchStoreFactsByWork", () => {
	it("takes the first stamped mockup in variant order and the cheapest list price", async () => {
		const facts = await merchStoreFactsByWork([shirtId]);
		expect(facts.get(shirtId)).toEqual({
			// The Oat color's, not Sand's null and not Black's second-in-line.
			mockupUrl: "https://cdn.printful.example/oat-mockup.png",
			// Sand's 12.00 — cheaper than either stamped color around it.
			fromPrice: "12.00",
		});
	});

	it("leaves a Work with no variants out of the map entirely", async () => {
		const bare = await insertWork({
			creatorId,
			type: "physical",
			title: `Bare Shirt ${stamp}`,
			access: [{ threshold: 0, allow: true, price: "0" }],
		});
		const facts = await merchStoreFactsByWork([bare.id]);
		expect(facts.has(bare.id)).toBe(false);
	});

	it("answers an empty batch with an empty map, without querying", async () => {
		const facts = await merchStoreFactsByWork([]);
		expect(facts.size).toBe(0);
	});
});

describe("the goods facts in the Catalog listing", () => {
	it("attaches the store facts to the physical Work alone, verdict unchanged", async () => {
		const res = await req(`/api/content/catalog/${creatorHandle}`);
		expect(res.status).toBe(200);
		const { works: list } = await res.json();
		expect(list.length).toBeGreaterThan(0);

		for (const w of list) {
			if (w.id === shirtId) {
				expect(w.access).toMatchObject({ reason: "payment_required", requiresPurchase: true });
				expect(w.merch).toEqual({
					mockupUrl: "https://cdn.printful.example/oat-mockup.png",
					fromPrice: "12.00",
				});
			} else {
				// A goods fact is a goods Work's — nothing null-shaped beside the others.
				expect(w.merch).toBeUndefined();
			}
		}
	});
});
