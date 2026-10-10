// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in account's home chrome preferences — the nav order write that the
 * sidebar's drag handles persist, and the landing it decides.
 *
 * 🚨 **The rule the write pins:** the order is a WHOLE-map write (the client always
 * knows the whole order) and must cover every id the nav links, once each — an
 * order that drops or duplicates an id has no meaning, so it is refused rather than
 * merged with the stored one. The payload rides both serializers it needs: the
 * account's GET /me and the shell's boot read `/auth/me` (the landing redirect has
 * no second call to spend).
 */
import { beforeAll, describe, expect, it } from "bun:test";
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
		const res = await patchMe({ homeNavOrder: ["library", "feed", "discover"] });
		expect(res.status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.homeNavOrder).toEqual(["library", "feed", "discover"]);

		// `/auth/me` is the shell's boot payload: the landing redirect reads the
		// order from it, so a preference that stopped at GET /me would never land.
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.homeNavOrder).toEqual(["library", "feed", "discover"]);
	});

	it("refuses an order that drops or duplicates an id", async () => {
		expect((await patchMe({ homeNavOrder: ["feed", "library"] })).status).toBe(400);
		expect((await patchMe({ homeNavOrder: ["feed", "feed", "discover"] })).status).toBe(400);
	});

	it("refuses an id the nav does not have", async () => {
		// The ids are the client's nav vocabulary; the schema's enum is that refusal.
		expect((await patchMe({ homeNavOrder: ["feed", "library", "basket"] })).status).toBe(400);
	});

	it("accepts a PATCH with no order key at all — other fields still work", async () => {
		const res = await patchMe({ bio: "Just here to reorder." });
		expect(res.status).toBe(200);
	});
});
