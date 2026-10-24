// SPDX-License-Identifier: Apache-2.0
/**
 * A post's tile shows the cover of a Work the reader may see, and of no other.
 *
 * 🚨 **The cover is part of what the Adult rung withholds.** `maturityHiddenFrom` keeps an
 * Adult Work's existence, title and cover art out of every listing for a reader who has not
 * opted in and verified, and a post's grid tile is a listing: it renders the first embedded
 * Work's thumbnail in place of artwork the post does not have. A query that read `works`
 * directly for that image answered the tile with a cover the rest of the page withheld.
 *
 * The allow-list is the one a title's `@` mention already resolves through, so the assertion
 * that matters most is the pair: the same post reads differently to two readers, and the
 * anonymous one matches the unverified one rather than the verified one.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, userPreferences } from "@anthers/db/schema";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, testPublicId } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
function req(path: string, cookie?: string) {
	return testFetch(
		new Request(`http://localhost${path}`, {
			headers: cookie ? { Cookie: cookie } : {},
		}),
	);
}

const run = crypto.randomUUID().slice(0, 8);
const GENERAL_THUMB = "https://cdn.anthers.org/creators/1/tile-general.png";
const ADULT_THUMB = "https://cdn.anthers.org/creators/1/tile-adult.png";

/** The two facts a tile asserts: the image, and that the count still sees what it hides. */
interface Tile {
	id: number;
	thumbnail: string | null;
	linkedWorkCount: number;
}

let creatorId: number;
let generalPostId: number;
let adultPostId: number;
let viewerCookie: string;
let grownCookie: string;

async function insertPost(body: string) {
	const [post] = await db
		.insert(posts)
		.values({
			creatorId,
			publicId: testPublicId(),
			slug: `tile-${run}-${crypto.randomUUID().slice(0, 6)}`,
			title: `A note ${crypto.randomUUID().slice(0, 4)}`,
			body,
			isPublished: true,
			publishedAt: new Date(),
		})
		.returning();
	return post!;
}

beforeAll(async () => {
	creatorId = (await createAccount(`tile_creator_${run}`, { fields: { isCreator: true } })).userId;
	const viewer = await createAccount(`tile_viewer_${run}`);
	const grown = await createAccount(`tile_grown_${run}`);
	viewerCookie = viewer.cookie;
	grownCookie = grown.cookie;

	// Opted in and verified, written directly because the enable route reads Stripe and this
	// suite is about what the verdict does. `adultDisplay: "blur"` is what that route writes;
	// the column's default is `hide`, which would test the display preference by accident.
	// Same state `adult-enforcement.test.ts` sets up.
	const grownPrefs = {
		adultOptIn: true,
		adultVerifiedAt: new Date(),
		adultVerifiedMethod: "card_funding",
		adultDisplay: "blur",
	};
	await db
		.insert(userPreferences)
		.values({ userId: grown.userId, ...grownPrefs })
		.onConflictDoUpdate({ target: userPreferences.userId, set: grownPrefs });

	const embed = (work: { slug: string; publicId: number }) =>
		`A note about it.\n\n[the work](/works/${work.slug}-${work.publicId})`;
	const general = await insertWork({
		creatorId,
		type: "text",
		title: "A gentle one",
		maturity: "general",
		thumbnail: GENERAL_THUMB,
	});
	const adult = await insertWork({
		creatorId,
		type: "text",
		title: "A grown one",
		maturity: "adult",
		thumbnail: ADULT_THUMB,
	});
	generalPostId = (await insertPost(embed(general))).id;
	adultPostId = (await insertPost(embed(adult))).id;
}, DB_SETUP_TIMEOUT);

/** One listing's tiles, by post row id. Both shapes carry `id`, `thumbnail` and the count. */
async function tiles(path: string, cookie?: string) {
	const res = await req(path, cookie);
	expect(res.status, path).toBe(200);
	const body = (await res.json()) as { posts?: Tile[]; entries?: Tile[] };
	return new Map((body.posts ?? body.entries ?? []).map((tile) => [tile.id, tile]));
}

describe("GET /posts — the public listing", () => {
	it(
		"shows the General Work's cover and withholds the Adult one",
		async () => {
			const listed = await tiles("/api/content/posts");
			expect(listed.get(generalPostId)?.thumbnail).toBe(GENERAL_THUMB);
			expect(listed.get(adultPostId)?.thumbnail).toBeNull();
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"answers an unverified reader the same way it answers an anonymous one",
		async () => {
			const anonymous = await tiles("/api/content/posts");
			const unverified = await tiles("/api/content/posts", viewerCookie);
			expect(unverified.get(adultPostId)?.thumbnail).toBeNull();
			expect(unverified.get(adultPostId)?.thumbnail).toBe(anonymous.get(adultPostId)?.thumbnail);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"shows it again to a reader who has opted in and verified",
		async () => {
			const listed = await tiles("/api/content/posts", grownCookie);
			expect(listed.get(adultPostId)?.thumbnail).toBe(ADULT_THUMB);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"still counts the Works the post embeds, whatever it may show",
		async () => {
			const listed = await tiles("/api/content/posts");
			expect(listed.get(adultPostId)?.linkedWorkCount).toBe(1);
		},
		DB_SETUP_TIMEOUT,
	);
});

describe("GET /accounts/me/feed — the grid timeline", () => {
	it(
		"applies the same rule to the tile it builds from a post",
		async () => {
			const unverified = await tiles("/api/accounts/me/feed?scope=global", viewerCookie);
			expect(unverified.get(adultPostId)?.thumbnail).toBeNull();
			expect(unverified.get(generalPostId)?.thumbnail).toBe(GENERAL_THUMB);

			const grown = await tiles("/api/accounts/me/feed?scope=global", grownCookie);
			expect(grown.get(adultPostId)?.thumbnail).toBe(ADULT_THUMB);
		},
		DB_SETUP_TIMEOUT,
	);
});
