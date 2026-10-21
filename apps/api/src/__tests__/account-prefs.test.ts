// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in account's home chrome preferences — the tab a session opens on, the
 * playback-home preference the persistent miniplayer reads, and the search chords.
 *
 * 🚨 **The default-tab rule this pins:** the write is one id from the nav's vocabulary
 * (an unknown id is refused here rather than stored), and it rides both serializers it
 * needs: the account's GET /me and the shell's boot read `/auth/me`, because the landing
 * redirect has no second call to spend. Null means "never answered" and the client reads
 * that as Network, so the column never bakes the default in.
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

const RUN = `starttab${Date.now().toString(36)}`;
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

describe("the default-tab preference", () => {
	it("starts null — the client's Network default", async () => {
		const fresh = `neverasked${Date.now().toString(36)}`;
		const freshCookie = (await createAccount(fresh)).cookie;
		const me = await (await req("/api/accounts/me", { headers: { Cookie: freshCookie } })).json();
		expect(me.user.homeDefaultTab).toBeNull();
	});

	it("persists a chosen tab, to both serializers it must ride", async () => {
		const res = await patchMe({ homeDefaultTab: "library" });
		expect(res.status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.homeDefaultTab).toBe("library");

		// `/auth/me` is the shell's boot payload: the landing redirect reads the tab
		// from it, so a preference that stopped at GET /me would never land.
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.homeDefaultTab).toBe("library");
	});

	it("refuses a tab the nav does not have", async () => {
		// The ids are the client's nav vocabulary; the schema's enum is that refusal.
		expect((await patchMe({ homeDefaultTab: "basket" })).status).toBe(400);
	});

	it("accepts a PATCH with no tab key at all — other fields still work", async () => {
		const res = await patchMe({ bio: "Just here for the Network." });
		expect(res.status).toBe(200);
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
