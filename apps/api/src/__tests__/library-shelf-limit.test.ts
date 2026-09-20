// SPDX-License-Identifier: Apache-2.0
/**
 * A Library past the shelf limit keeps its newest entries on the shelf.
 *
 * The shelf read is capped, and the cap once kept the oldest entries — so past it, every new
 * save disappeared from the shelf the moment it was made, with nothing to say why. The newest
 * save is the one somebody opens the Library to find.
 *
 * Projects stand in for the entries because a Project is the cheapest thing a shelf can hold
 * and nothing here is about what an entry is.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { SHELF_LIMIT } from "../services/library";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const id = crypto.randomUUID().slice(0, 8);
const readerName = `shelf_r_${id}`;

let cookie = "";
let readerId = 0;

async function shelf(): Promise<{
	items: { sortOrder: number }[];
	truncated: boolean;
	limit: number;
}> {
	const res = await app.fetch(
		new Request("http://localhost/api/content/library", { headers: { Cookie: cookie } }),
	);
	expect(res.status).toBe(200);
	return res.json();
}

beforeAll(async () => {
	const account = await createAccount(readerName);
	cookie = account.cookie;
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${readerName}@example.com`));
	readerId = row.id;

	// One more entry than the shelf holds, saved in order 1..N.
	await db.execute(sql`
		INSERT INTO projects (creator_id, slug, title)
		SELECT ${readerId}, 'shelf-' || ${id} || '-' || n, 'Shelf ' || n
		FROM generate_series(1, ${SHELF_LIMIT + 1}) AS n
	`);
	await db.execute(sql`
		INSERT INTO library_items (user_id, project_id, sort_order)
		SELECT ${readerId}, p.id, split_part(p.slug, '-', 3)::int
		FROM projects p WHERE p.slug LIKE ${`shelf-${id}-%`}
	`);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.execute(sql`DELETE FROM library_items WHERE user_id = ${readerId}`);
	await db.execute(sql`DELETE FROM projects WHERE slug LIKE ${`shelf-${id}-%`}`);
});

describe("a shelf past the limit", () => {
	it("keeps the newest entries, in saved order, and says it was cut", async () => {
		const { items, truncated, limit } = await shelf();
		expect(truncated).toBe(true);
		expect(limit).toBe(SHELF_LIMIT);
		expect(items).toHaveLength(SHELF_LIMIT);
		// The oldest save is the one left out; the newest is on the shelf, last.
		expect(items[0].sortOrder).toBe(2);
		expect(items.at(-1)?.sortOrder).toBe(SHELF_LIMIT + 1);
	});

	it("says nothing was cut once the shelf fits", async () => {
		await db.execute(
			sql`DELETE FROM library_items WHERE user_id = ${readerId} AND sort_order = ${SHELF_LIMIT + 1}`,
		);
		const { items, truncated } = await shelf();
		expect(truncated).toBe(false);
		expect(items).toHaveLength(SHELF_LIMIT);
	});
});
