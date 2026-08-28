// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What an Adult rating costs a Work: it may not be free, it is never in the commons, it
 * earns no Time Pool, and it is invisible to anybody who has not opted in and verified.
 *
 * 🚨 **Two of the four are ABSENCES, and an absence needs a test or nothing in the
 * repository can tell it is gone.** That a Work rated Adult never appears in a listing, and
 * that it never earns a Time Pool second, are both the shape of defect that rots silently:
 * the feature keeps working, the tests keep passing, and the only symptom is content
 * reaching people it was never meant to reach. So the listings are asserted to be *missing*
 * the Work rather than to contain it locked, and the eligibility flag is read directly.
 *
 * ⭐ **The invisibility is asserted from three standings, not one.** A signed-out visitor, a
 * signed-in account that has not opted in, and the creator themselves get three different
 * right answers, and a guard written for only the first would look correct while leaking to
 * the second. The creator's case is the one a too-broad guard breaks, and it is the one that
 * would be found last, because it needs somebody to notice their own work had vanished.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, users, works } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import {
	type AccessContext,
	type AccessibleWork,
	isOpenToEveryoneFree,
	resolveAccessSync,
} from "../services/access";
import { purgeFixtureAccounts } from "./cleanup.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `adenf_c_${run}`;
const readerName = `adenf_r_${run}`;
const grownName = `adenf_g_${run}`;

/** Behind a $3 Badge and free at that rung — a legal shape for Adult work. */
const BEHIND_A_BADGE = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 3, allow: true, price: "0" },
];
/** Open to everyone at no cost — Public Access, and the shape Adult work may not have. */
const OPEN_TO_EVERYONE = [{ threshold: 0, allow: true, price: "0" }];

let creatorCookie: string;
let readerCookie: string;
let grownCookie: string;
let creatorId: number;
let grownId: number;
const madeWorkIds: number[] = [];

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const cookie = res.headers.get("Set-Cookie")!.split(";")[0];
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return { cookie, id: row!.id };
}

async function makeWork(fixture: Parameters<typeof insertWork>[0]) {
	const row = await insertWork(fixture);
	madeWorkIds.push(row.id);
	return row;
}

/** Titles in a catalog response, whoever is asking. */
async function catalogTitles(cookie?: string): Promise<string[]> {
	const headers: Record<string, string> = { Origin: ORIGIN };
	if (cookie) headers.Cookie = cookie;
	const res = await req(`/api/content/catalog/${creatorName}`, { headers });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { works: { title: string }[] };
	return body.works.map((w) => w.title);
}

// Titles as constants rather than read back off the row: `works.title` is nullable in the
// schema, and a listing assertion that quietly compared against `null` would pass for the
// wrong reason — `not.toContain(null)` is true of every list there is.
const ADULT_TITLE = `Adult fixture ${run}`;
const MATURE_TITLE = `Mature fixture ${run}`;

describe("what an Adult rating costs", () => {
	let adultWork: Awaited<ReturnType<typeof insertWork>>;
	let matureWork: Awaited<ReturnType<typeof insertWork>>;

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${creatorName}, ${readerName}, ${grownName})`,
		);
		({ cookie: creatorCookie, id: creatorId } = await signUp(creatorName));
		({ cookie: readerCookie } = await signUp(readerName));
		({ cookie: grownCookie, id: grownId } = await signUp(grownName));

		// The grown account has opted in and verified. Written directly rather than through
		// the enable route, because that route reads Stripe and this suite is about what the
		// verdict DOES rather than about how it is reached — `adult-access.test.ts` owns
		// the funding-type half.
		await db
			.insert(accounts)
			.values({
				userId: grownId,
				adultOptIn: true,
				adultVerifiedAt: new Date(),
				adultVerifiedMethod: "card_funding",
			})
			.onConflictDoUpdate({
				target: accounts.userId,
				set: { adultOptIn: true, adultVerifiedAt: new Date(), adultVerifiedMethod: "card_funding" },
			});

		adultWork = await makeWork({
			creatorId,
			type: "text",
			title: ADULT_TITLE,
			maturity: "adult",
			seedAccess: BEHIND_A_BADGE,
		});
		matureWork = await makeWork({
			creatorId,
			type: "text",
			title: MATURE_TITLE,
			maturity: "mature",
			seedAccess: OPEN_TO_EVERYONE,
		});
	}, DB_SETUP_TIMEOUT);

	// In `afterAll` so it runs on a bail as well as a pass. Works go by hand because
	// `works.creator_id` is `set null` rather than `cascade` — deleting the users would
	// orphan these rows instead of removing them.
	afterAll(async () => {
		if (madeWorkIds.length > 0) await db.delete(works).where(inArray(works.id, madeWorkIds));
		await purgeFixtureAccounts([creatorName, readerName, grownName]);
	});

	describe("the resolver, which is where entitlement is decided and nothing else may decide it", () => {
		const base: AccessibleWork = {
			id: 1,
			creatorId: 99,
			streamEnabled: true,
			downloadEnabled: false,
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
			takedownStatus: "active",
			quarantineStatus: "none",
			maturity: "adult",
		};
		const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
			userId: 7,
			supportByCreator: new Map(),
			purchasedWorkIds: new Set(),
			adultAccess: false,
			...over,
		});

		it("refuses an Adult Work to an account that has not opted in", () => {
			const got = resolveAccessSync(base, ctx());
			expect(got.canAccess).toBe(false);
			expect(got.reason).toBe("adult_gated");
		});

		it("refuses it to a signed-out visitor", () => {
			// A signed-out visitor has no account and so no setting for the opt-in to
			// consult, which is why the answer is the same absence rather than a prompt.
			const got = resolveAccessSync(base, ctx({ userId: null }));
			expect(got.canAccess).toBe(false);
			expect(got.reason).toBe("adult_gated");
		});

		it("🚨 refuses it even to somebody who bought it, once they opt back out", () => {
			// A purchase outlives everything on Anthers, so this outranking a receipt needs
			// a reason: what the viewer is being refused is something they asked not to be
			// shown, and it returns the moment they turn the setting back on. A purchase
			// that overrode the setting would make the setting mean "except for things you
			// already own", which nobody would expect it to.
			const got = resolveAccessSync(base, ctx({ purchasedWorkIds: new Set([1]) }));
			expect(got.canAccess).toBe(false);
			expect(got.reason).toBe("adult_gated");
		});

		it("⚠️ never refuses it to its own creator", () => {
			// The case a too-broad guard breaks, and the one nobody would find quickly. A
			// creator who has not opted in is not asking to be protected from the thing they
			// made, and locking them out would make their own Work un-editable.
			const got = resolveAccessSync({ ...base, creatorId: 7 }, ctx());
			expect(got.canAccess).toBe(true);
			expect(got.reason).toBe("owner");
		});

		it("lets a verified opted-in account through to the ordinary gate rules", () => {
			// The point is that it does not short-circuit to "yes" either — it falls through
			// to the same resolution everything else gets.
			const got = resolveAccessSync(base, ctx({ adultAccess: true }));
			expect(got.canAccess).toBe(true);
			expect(got.reason).toBe("free");
		});

		it("🚨 leaves a `mature` Work completely alone", () => {
			// The rule most likely to be over-applied, and the most expensive to get wrong:
			// a mature rating is a warning and a filter input carrying NO access
			// consequence. Teaching the resolver to read it would silently paywall the work
			// wiki 40.13 draws its rows to protect.
			const got = resolveAccessSync({ ...base, maturity: "mature" }, ctx());
			expect(got.canAccess).toBe(true);
			expect(got.reason).toBe("free");
		});
	});

	describe("Adult work may not be free", () => {
		it("recognizes the one row shape that means `free to everyone`", () => {
			expect(isOpenToEveryoneFree(OPEN_TO_EVERYONE)).toBe(true);
			// ⭐ Behind a Badge at $3 is NOT free-to-everyone, and this is the assertion that
			// keeps the rule from over-reaching. A row above the baseline priced at zero
			// means "supporters get it at no further cost", which is exactly the shape Adult
			// work is supposed to have.
			expect(isOpenToEveryoneFree(BEHIND_A_BADGE)).toBe(false);
			expect(isOpenToEveryoneFree([{ threshold: 0, allow: false, price: "0" }])).toBe(false);
			expect(isOpenToEveryoneFree([{ threshold: 0, allow: true, price: "5.00" }])).toBe(false);
			expect(isOpenToEveryoneFree(null)).toBe(false);
		});

		it("refuses to open an Adult Work up to everyone", async () => {
			const res = await req(`/api/content/works/${adultWork.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
				body: JSON.stringify({ seedAccess: OPEN_TO_EVERYONE }),
			});
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("adult_must_be_paid");
			const [row] = await db.select().from(works).where(eq(works.id, adultWork.id));
			expect(row.seedAccess).toEqual(BEHIND_A_BADGE);
		});

		it("refuses to rate a free Work Adult — the same violation from the other side", async () => {
			// Either half can move in one request, so the check reads the state the edit
			// RESULTS IN. A guard watching only the access table would wave this through.
			//
			// ⚠️ A PRIVATE Work on purpose. A released one is refused first, and correctly,
			// by the closed-rung check — Adult is not on the accepted list yet — and this
			// test would then pass on a refusal that has nothing to do with its subject.
			const freeDraft = await makeWork({
				creatorId,
				type: "text",
				title: `Free draft ${run}`,
				maturity: "general",
				visibility: "private",
				seedAccess: OPEN_TO_EVERYONE,
			});
			const res = await req(`/api/content/works/${freeDraft.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
				body: JSON.stringify({ maturity: "adult" }),
			});
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("adult_must_be_paid");
		});

		it("allows an Adult Work behind a Badge", async () => {
			const res = await req(`/api/content/works/${adultWork.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
				body: JSON.stringify({ seedAccess: BEHIND_A_BADGE }),
			});
			expect(res.status).toBe(200);
		});

		it("refuses to create one free and Adult in a single request", async () => {
			const res = await req("/api/content/works", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
				body: JSON.stringify({
					type: "text",
					title: `Born free and adult ${run}`,
					maturity: "adult",
					seedAccess: OPEN_TO_EVERYONE,
				}),
			});
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("adult_must_be_paid");
		});
	});

	describe("it is invisible rather than locked", () => {
		it("is absent from a signed-out visitor's view of the creator's Catalog", async () => {
			const titles = await catalogTitles();
			expect(titles).toContain(MATURE_TITLE);
			// 🚨 The absence, asserted as one. A test checking that the Work came back
			// `canAccess: false` would pass while the title and cover art — the things the
			// rung specifically does not give an existence to — were on the page.
			expect(titles).not.toContain(ADULT_TITLE);
		});

		it("is absent for a signed-in account that has not opted in", async () => {
			// Parker, 2026-08-28, settling 40.09's open question on the non-feed surfaces:
			// one rule for everyone without the opt-in, rather than an interstitial.
			const titles = await catalogTitles(readerCookie);
			expect(titles).toContain(MATURE_TITLE);
			expect(titles).not.toContain(ADULT_TITLE);
		});

		it("is present for an account that has opted in and verified", async () => {
			const titles = await catalogTitles(grownCookie);
			expect(titles).toContain(ADULT_TITLE);
		});

		it("⚠️ is always present for its own creator, whatever their setting says", async () => {
			// The creator has not opted in. Hiding their own Work from them would take it
			// out of their own Catalog, and it is the failure that would be found last.
			const titles = await catalogTitles(creatorCookie);
			expect(titles).toContain(ADULT_TITLE);
		});

		it("404s on the Work page for a signed-out visitor, rather than saying it exists", async () => {
			// 404 and not 403: a response saying "this exists and you may not have it" leaks
			// exactly what the rung withholds. This is also the surface a share link arrives
			// at — a share link is a locator and never an entitlement.
			const res = await req(`/api/content/works/${adultWork.publicId}`, {
				headers: { Origin: ORIGIN },
			});
			expect(res.status).toBe(404);
		});

		it("404s for a signed-in account that has not opted in", async () => {
			const res = await req(`/api/content/works/${adultWork.publicId}`, {
				headers: { Origin: ORIGIN, Cookie: readerCookie },
			});
			expect(res.status).toBe(404);
		});

		it("opens for an account that has opted in and verified", async () => {
			const res = await req(`/api/content/works/${adultWork.publicId}`, {
				headers: { Origin: ORIGIN, Cookie: grownCookie },
			});
			expect(res.status).toBe(200);
		});

		it("never appears in the Public Access commons", async () => {
			const res = await req("/api/content/open-works?limit=24", { headers: { Origin: ORIGIN } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { works: { title: string }[] };
			expect(body.works.map((w) => w.title)).not.toContain(ADULT_TITLE);
		});
	});

	describe("it earns no Time Pool, and needs no special case to", () => {
		it("can never be Public Access, because it can never be free", () => {
			// ⭐ The Time Pool exclusion falls out of the gating rather than being a rule of
			// its own — `attention_events.public_access` is stamped from `access.isFree`,
			// and an Adult Work cannot produce a true `isFree` from any viewer standing.
			// This asserts the property the stamp depends on, from both standings, so a
			// change that made Adult work free would fail here rather than quietly starting
			// to pay per minute for it.
			const work: AccessibleWork = {
				id: 2,
				creatorId: 99,
				streamEnabled: true,
				downloadEnabled: false,
				// The most permissive table there is. Even so, the rating denies first.
				seedAccess: [{ threshold: 0, allow: true, price: "0" }],
				takedownStatus: "active",
				quarantineStatus: "none",
				maturity: "adult",
			};
			const shutOut = resolveAccessSync(work, {
				userId: 7,
				supportByCreator: new Map(),
				purchasedWorkIds: new Set(),
				adultAccess: false,
			});
			expect(shutOut.isFree).toBe(false);

			// And with access, the only way to reach it is a table that is not free to
			// everyone — which the write boundary enforces, so this shape cannot be stored.
			const gated = resolveAccessSync(
				{ ...work, seedAccess: BEHIND_A_BADGE },
				{
					userId: 7,
					supportByCreator: new Map([[99, 3]]),
					purchasedWorkIds: new Set(),
					adultAccess: true,
				},
			);
			expect(gated.canAccess).toBe(true);
			// Entitled through a Badge is not free, so no second it earns carries the flag.
			expect(gated.isFree).toBe(false);
			expect(gated.reason).toBe("entitled");
		});
	});
});
