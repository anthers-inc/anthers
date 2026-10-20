// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in account's home chrome preferences — the nav order write that the
 * sidebar's drag handles persist, and the landing it decides — and the playback-home
 * preference the persistent miniplayer reads.
 *
 * 🚨 **The rule the nav write pins:** the order is a WHOLE-map write (the client always
 * knows the whole order) and must cover every id the nav links, once each — an
 * order that drops or duplicates an id has no meaning, so it is refused rather than
 * merged with the stored one. The payload rides both serializers it needs: the
 * account's GET /me and the shell's boot read `/auth/me` (the landing redirect has
 * no second call to spend).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { userPreferences } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const RUN = `navorder${Date.now().toString(36)}`;
let cookie = "";

beforeAll(async () => {
	cookie = (await createAccount(RUN)).cookie;
});

function patchMe(body: unknown, c = cookie) {
	return req("/api/accounts/me", {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: c },
		body: JSON.stringify(body),
	});
}

describe("the home nav order preference", () => {
	it("persists a whole permutation, to both serializers it must ride", async () => {
		const res = await patchMe({ homeNavOrder: ["library", "network", "discovery"] });
		expect(res.status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.homeNavOrder).toEqual(["library", "network", "discovery"]);

		// `/auth/me` is the shell's boot payload: the landing redirect reads the
		// order from it, so a preference that stopped at GET /me would never land.
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.homeNavOrder).toEqual(["library", "network", "discovery"]);
	});

	it("refuses an order that drops or duplicates an id", async () => {
		expect((await patchMe({ homeNavOrder: ["network", "library"] })).status).toBe(400);
		expect((await patchMe({ homeNavOrder: ["network", "network", "discovery"] })).status).toBe(400);
	});

	it("refuses an id the nav does not have", async () => {
		// The ids are the client's nav vocabulary; the schema's enum is that refusal.
		expect((await patchMe({ homeNavOrder: ["network", "library", "basket"] })).status).toBe(400);
	});

	it("accepts a PATCH with no order key at all — other fields still work", async () => {
		const res = await patchMe({ bio: "Just here to reorder." });
		expect(res.status).toBe(200);
	});
});

describe("the nav-id migration", () => {
	it("rewrites a stored order's retired ids in place", async () => {
		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		const userId = me.user.id as number;
		expect(userId).toBeGreaterThan(0);

		// A row written before the rename, which the route's own validation now refuses —
		// so the migration is the only thing that can turn it back into a valid order.
		await db
			.update(userPreferences)
			.set({ homeNavOrder: ["feed", "library", "discover"] })
			.where(eq(userPreferences.userId, userId));

		const migration = readFileSync(
			join(
				import.meta.dir,
				"../../../../packages/db/drizzle/20261020-045536_rename_home_nav_ids.sql",
			),
			"utf8",
		);
		await db.execute(sql.raw(migration));

		const [row] = await db
			.select({ order: userPreferences.homeNavOrder })
			.from(userPreferences)
			.where(eq(userPreferences.userId, userId));
		expect(row?.order).toEqual(["network", "library", "discovery"]);

		const after = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(after.user.homeNavOrder).toEqual(["network", "library", "discovery"]);
	});
});

describe("the persistent miniplayer preference", () => {
	it("rides both serializers: the account's GET /me and the shell's boot read", async () => {
		const res = await patchMe({ persistentMiniplayer: false });
		expect(res.status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.persistentMiniplayer).toBe(false);
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.persistentMiniplayer).toBe(false);
	});

	/**
	 * 🚨 **Where a document claims an absence, that absence needs a test** — here, the
	 * absence is "never answered", which the client reads as on. The column is nullable
	 * on purpose so the default can move without rewriting rows; a route bug that
	 * coerced null to false would paywall nobody and still be wrong.
	 */
	it("an account that has never answered reads null — the client's on default", async () => {
		const fresh = `neverasked${Date.now().toString(36)}`;
		const freshCookie = (await createAccount(fresh)).cookie;
		const me = await (await req("/api/accounts/me", { headers: { Cookie: freshCookie } })).json();
		expect(me.user.persistentMiniplayer).toBeNull();
	});

	it("refuses a non-boolean write", async () => {
		expect((await patchMe({ persistentMiniplayer: "on" })).status).toBe(400);
	});
});

describe("the search shortcut preference", () => {
	it("starts null and round-trips a canonical pair through both serializers", async () => {
		const before = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(before.user.searchShortcuts).toBeNull();

		const res = await patchMe({ searchShortcuts: { search: "mod+shift+k", filter: "alt+f" } });
		expect(res.status).toBe(200);

		const expected = { search: "Mod+Shift+K", filter: "Alt+F" };
		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.searchShortcuts).toEqual(expected);
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.searchShortcuts).toEqual(expected);
	});

	it("refuses a bare key, a duplicate pair and a partial map", async () => {
		expect((await patchMe({ searchShortcuts: { search: "K", filter: "Mod+F" } })).status).toBe(400);
		expect((await patchMe({ searchShortcuts: { search: "Mod+K", filter: "Mod+K" } })).status).toBe(
			400,
		);
		expect((await patchMe({ searchShortcuts: { search: "Mod+K" } })).status).toBe(400);
	});
});
