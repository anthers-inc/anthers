// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in account's home chrome preferences — the tab a session opens on, the
 * playback-home preference the persistent miniplayer reads, and the search chords.
 *
 * 🚨 **The default-tab rule this pins:** the write is one id from the nav's vocabulary
 * (an unknown id is refused here rather than stored), and it rides both serializers it
 * needs: the account's GET /me and the shell's boot read `/auth/me`, because the landing
 * redirect has no second call to spend. Null means "never answered" and the client reads
 * that as Discovery, so the column never bakes the default in.
 *
 * ⚠️ **There are two tabs as of 2026-10-24**, when Network retired into Discovery as a
 * recipe preset. A stored `network` is not refused on read — the serializers treat any id
 * this build's nav does not have as never-answered — so the account lands on the merged
 * tab rather than nowhere. The recipe the merged tab remembers is pinned below, and so are
 * the recipes a reader saved beside the built-in presets.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { SAVED_RECIPE_LIMIT } from "@anthers/shared/discovery";
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
	it("starts null — the client's Discovery default", async () => {
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
		// The ids are the client's nav vocabulary; the schema's enum is that refusal. The
		// retired tab is in that set: it is a redirect now, not a place to open on.
		expect((await patchMe({ homeDefaultTab: "basket" })).status).toBe(400);
		expect((await patchMe({ homeDefaultTab: "network" })).status).toBe(400);
	});

	it("accepts a PATCH with no tab key at all — other fields still work", async () => {
		const res = await patchMe({ bio: "Just here for the Network." });
		expect(res.status).toBe(200);
	});
});

describe("the Discovery recipe preference", () => {
	it("starts null — the client's My Network preset", async () => {
		const fresh = `norecipe${Date.now().toString(36)}`;
		const freshCookie = (await createAccount(fresh)).cookie;
		const me = await (await req("/api/accounts/me", { headers: { Cookie: freshCookie } })).json();
		expect(me.user.homeRecipe).toBeNull();
	});

	it("persists the whole recipe, to both serializers it must ride", async () => {
		const recipe = { window: "week", candidates: "following", mix: "straight" };
		expect((await patchMe({ homeRecipe: recipe })).status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.homeRecipe).toEqual(recipe);
		// A bare `/discovery` opens on this from the shell's boot payload, so a recipe that
		// stopped at GET /me would open on the default instead.
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.homeRecipe).toEqual(recipe);
	});

	it("refuses a stage value neither the page nor the route can run", async () => {
		// One refusal per stage, because the schema's three enums are the shared
		// vocabulary: a stored value the page cannot parse would draw something else.
		expect(
			(await patchMe({ homeRecipe: { window: "fortnight", candidates: "network", mix: "spread" } }))
				.status,
		).toBe(400);
		expect(
			(await patchMe({ homeRecipe: { window: "all", candidates: "friends", mix: "spread" } }))
				.status,
		).toBe(400);
		expect(
			(await patchMe({ homeRecipe: { window: "all", candidates: "network", mix: "chaos" } }))
				.status,
		).toBe(400);
	});

	it("leaves the stored recipe alone when a PATCH does not mention it", async () => {
		await patchMe({ homeRecipe: { window: "day", candidates: "saved", mix: "spread" } });
		expect((await patchMe({ bio: "Still reading." })).status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.homeRecipe).toEqual({ window: "day", candidates: "saved", mix: "spread" });
	});
});

describe("the saved Discovery recipes", () => {
	const recipeA = { window: "all", candidates: "following", mix: "straight" };
	const recipeB = { window: "week", candidates: "everyone", mix: "spread" };
	const rows = [
		{ id: "a", label: "Close friends", color: "rose", recipe: recipeA },
		{ id: "b", label: "Wide net", color: "sky", recipe: recipeB },
	];

	it("starts empty and round-trips the list through both serializers", async () => {
		const fresh = `savedrecipes${Date.now().toString(36)}`;
		const freshCookie = (await createAccount(fresh)).cookie;
		const before = await (
			await req("/api/accounts/me", { headers: { Cookie: freshCookie } })
		).json();
		expect(before.user.savedRecipes).toBeNull();

		expect((await patchMe({ savedRecipes: rows })).status).toBe(200);
		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.savedRecipes).toEqual(rows);
		// The chips render before anything is clicked, so the list has to ride the boot read
		// rather than only the settings page's GET.
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.savedRecipes).toEqual(rows);
	});

	it("keeps the order the client sent, because order is which chip renders first", async () => {
		expect((await patchMe({ savedRecipes: [...rows].reverse() })).status).toBe(200);
		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.savedRecipes.map((row: { id: string }) => row.id)).toEqual(["b", "a"]);
	});

	it("refuses a row the page could not render", async () => {
		const withRow = (overrides: Record<string, unknown>) =>
			patchMe({ savedRecipes: [{ ...rows[0], ...overrides }] });

		expect((await withRow({ label: "" })).status).toBe(400);
		expect((await withRow({ label: "x".repeat(41) })).status).toBe(400);
		expect((await withRow({ color: "chartreuse" })).status).toBe(400);
		expect((await withRow({ recipe: { ...recipeA, mix: "chaos" } })).status).toBe(400);
	});

	/**
	 * Two chips keyed on one id would be one chip React cannot tell from the other, and a
	 * saved recipe identical to a built-in preset would be a chip that can never light —
	 * `choiceForRecipe` matches by recipe, so the first match wins and the other is an
	 * affordance that does nothing. Two saved rows of the same recipe have the same
	 * problem. All three are refusals at the route because the UI is not the only client a
	 * preference can arrive from.
	 */
	it("refuses duplicate ids, a repeated recipe and a copy of a built-in preset", async () => {
		expect(
			(await patchMe({ savedRecipes: [rows[0], { ...rows[1], id: rows[0].id }] })).status,
		).toBe(400);
		// Same stages, different id and name: still one chip that could never light.
		expect(
			(await patchMe({ savedRecipes: [rows[0], { ...rows[1], recipe: rows[0].recipe }] })).status,
		).toBe(400);
		expect(
			(
				await patchMe({
					savedRecipes: [
						{
							id: "copy",
							label: "Same as My Network",
							color: "moss",
							recipe: { window: "all", candidates: "network", mix: "straight" },
						},
					],
				})
			).status,
		).toBe(400);
	});

	it("refuses more recipes than the chip row is bounded to", async () => {
		const tooMany = Array.from({ length: SAVED_RECIPE_LIMIT + 1 }, (_, index) => ({
			...rows[0],
			id: `row-${index}`,
		}));
		expect((await patchMe({ savedRecipes: tooMany })).status).toBe(400);
	});

	it("leaves the list alone when a PATCH does not mention it", async () => {
		expect((await patchMe({ bio: "Still reading." })).status).toBe(200);
		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.savedRecipes.map((row: { id: string }) => row.id)).toEqual(["b", "a"]);
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

describe("the keyboard shortcut preference", () => {
	const chords = {
		search: "mod+shift+k",
		filter: "alt+f",
		sidebar: "ctrl+/",
		previousRecipe: "ctrl+[",
		nextRecipe: "ctrl+]",
		fullscreen: "f",
		theater: "t",
	};

	it("starts null and round-trips every canonical chord through both serializers", async () => {
		const before = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(before.user.keyboardShortcuts).toBeNull();

		const res = await patchMe({ keyboardShortcuts: chords });
		expect(res.status).toBe(200);

		const expected = {
			search: "Mod+Shift+K",
			filter: "Alt+F",
			sidebar: "Ctrl+/",
			previousRecipe: "Ctrl+[",
			nextRecipe: "Ctrl+]",
			fullscreen: "F",
			theater: "T",
		};
		const me = await (await req("/api/accounts/me", { headers: { Cookie: cookie } })).json();
		expect(me.user.keyboardShortcuts).toEqual(expected);
		const auth = await (await req("/api/auth/me", { headers: { Cookie: cookie } })).json();
		expect(auth.user.keyboardShortcuts).toEqual(expected);
	});

	it("refuses a bare page shortcut, a duplicate pair and a partial map", async () => {
		expect((await patchMe({ keyboardShortcuts: { ...chords, search: "K" } })).status).toBe(400);
		expect(
			(await patchMe({ keyboardShortcuts: { ...chords, theater: "mod+shift+k" } })).status,
		).toBe(400);
		expect(
			(await patchMe({ keyboardShortcuts: { search: "Mod+K", filter: "Mod+F" } })).status,
		).toBe(400);
	});

	/**
	 * Command+K and Control+K are two keys on a Mac and one key everywhere else, and a
	 * shortcut map follows the account across devices — so the pair is refused rather than
	 * left to answer two actions on the next machine the account signs in from.
	 */
	it("refuses a Mod chord and a Ctrl chord on one key", async () => {
		expect(
			(await patchMe({ keyboardShortcuts: { ...chords, search: "Mod+K", sidebar: "Ctrl+K" } }))
				.status,
		).toBe(400);
		expect(
			(await patchMe({ keyboardShortcuts: { ...chords, search: "Mod+K", sidebar: "Ctrl+F" } }))
				.status,
		).toBe(200);
	});

	/**
	 * A player shortcut is listened for by a focused player, so a bare key is the natural
	 * binding — while the same bare key on Search would eat typing. The split is the whole
	 * reason the grammar has two scopes, so it gets its own refusal.
	 */
	it("accepts a bare player shortcut and refuses it on a page action", async () => {
		expect(
			(await patchMe({ keyboardShortcuts: { ...chords, fullscreen: "g", theater: "h" } })).status,
		).toBe(200);
		expect((await patchMe({ keyboardShortcuts: { ...chords, filter: "K" } })).status).toBe(400);
	});
});
