// SPDX-License-Identifier: Apache-2.0
/**
 * A Library past its limit keeps its newest entries.
 *
 * The Library read is capped, and the cap once kept the oldest entries — so past it, every new
 * save disappeared from the Library the moment it was made, with nothing to say why. The newest
 * save is the one somebody opens the Library to find.
 *
 * Projects stand in for the entries because a Project is the cheapest thing the Library can hold
 * and nothing here is about what an entry is.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { LIBRARY_LIMIT } from "../services/library";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const id = crypto.randomUUID().slice(0, 8);
const userName = `library_r_${id}`;

let cookie = "";
let userId = 0;

async function library(): Promise<{
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
	const account = await createAccount(userName);
	cookie = account.cookie;
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${userName}@example.com`));
	userId = row.id;

	// One more entry than the Library holds, saved in order 1..N.
	await db.execute(sql`
		INSERT INTO projects (creator_id, slug, title)
		SELECT ${userId}, 'library-' || ${id} || '-' || n, 'Library ' || n
		FROM generate_series(1, ${LIBRARY_LIMIT + 1}) AS n
	`);
	await db.execute(sql`
		INSERT INTO library_items (user_id, project_id, sort_order)
		SELECT ${userId}, p.id, split_part(p.slug, '-', 3)::int
		FROM projects p WHERE p.slug LIKE ${`library-${id}-%`}
	`);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.execute(sql`DELETE FROM library_items WHERE user_id = ${userId}`);
	await db.execute(sql`DELETE FROM projects WHERE slug LIKE ${`library-${id}-%`}`);
});

describe("a Library past the limit", () => {
	it("keeps the newest entries, in saved order, and says it was cut", async () => {
		const { items, truncated, limit } = await library();
		expect(truncated).toBe(true);
		expect(limit).toBe(LIBRARY_LIMIT);
		expect(items).toHaveLength(LIBRARY_LIMIT);
		// The oldest save is the one left out; the newest is in the Library, last.
		expect(items[0].sortOrder).toBe(2);
		expect(items.at(-1)?.sortOrder).toBe(LIBRARY_LIMIT + 1);
	});

	it("says nothing was cut once the Library fits", async () => {
		await db.execute(
			sql`DELETE FROM library_items WHERE user_id = ${userId} AND sort_order = ${LIBRARY_LIMIT + 1}`,
		);
		const { items, truncated } = await library();
		expect(truncated).toBe(false);
		expect(items).toHaveLength(LIBRARY_LIMIT);
	});
});
