// SPDX-License-Identifier: Apache-2.0
/**
 * Work embeds in a post body — the link IS the embed (Parker, 2026-10-16): a Work URL in
 * the body renders a card under the text, resolved at read time through the Work's own
 * gates, nothing stored. Covers the extractor's recognition rules and the route-level
 * behavior: ordering by first appearance, cross-creator embeds allowed, a dead link
 * rendering as the plain link it already is, and the Adult drop for an unverified reader.
 */

import { describe, expect, it } from "bun:test";
import type { DeclarableMaturity } from "@anthers/shared/content-rating";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import app from "../index";
import { pgWorkEmbedPattern, workPublicIdsFromBody } from "../lib/post-work-links";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { CREATED_CREDIT } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

describe("workPublicIdsFromBody", () => {
	it("extracts from a markdown link, a bare url, and a relative path — in first-appearance order", () => {
		const body = [
			"Read [the build](/works/my-game-123456789) or go straight to https://anthers.org/works/other-thing-987654321.",
			"Repeat links dedupe: /works/my-game-123456789",
		].join("\n\n");
		expect(workPublicIdsFromBody(body)).toEqual([123456789, 987654321]);
	});

	it("reads a subdomain link and tolerates a bare publicId path", () => {
		expect(workPublicIdsFromBody("https://www.anthers.org/works/123456789 x")).toEqual([123456789]);
	});

	it("ignores numbers that cannot be a publicId", () => {
		// A slug carrying small digit groups is not an embed: public ids are 9 digits.
		expect(workPublicIdsFromBody("page /works/123456-title and /works/2")).toEqual([]);
	});

	it("reads the trailing publicId even when the slug carries its own digits", () => {
		// A slug is free text, and `top-1000000-games` is an ordinary one. The id is the
		// run at the end of the address, never an earlier run inside the slug.
		expect(workPublicIdsFromBody("/works/top-1000000-games-123456789")).toEqual([123456789]);
		expect(workPublicIdsFromBody("https://anthers.org/works/2026-10-19-123456789")).toEqual([
			123456789,
		]);
		expect(workPublicIdsFromBody("/works/my-game-123456789/")).toEqual([123456789]);
	});

	it("reads two links written back to back without whitespace", () => {
		expect(
			workPublicIdsFromBody("/works/first-123456789,/works/second-987654321"),
		).toEqual([123456789, 987654321]);
	});

	it("ignores another site's path that happens to carry /works", () => {
		expect(
			workPublicIdsFromBody("https://example.com/works/something-123456789 and evil-anthers.org/x"),
		).toEqual([]);
	});

	it("returns nothing for an empty body", () => {
		expect(workPublicIdsFromBody(null)).toEqual([]);
		expect(workPublicIdsFromBody("")).toEqual([]);
	});
});

describe("Embeds resolve through the Work's own gates", () => {
	const id = crypto.randomUUID().slice(0, 8);
	const creatorName = `embed_${id}`;
	const strangerName = `embed_other_${id}`;

	/** A creator whose publishing path is fully set up. */
	const owner = (async () => {
		const cookie = (await createAccount(creatorName)).cookie;
		await enablePayouts(creatorName);
		return cookie;
	})();

	/** A second, unverified account — a creator too, so it can post. */
	const stranger = (async () => {
		const cookie = (await createAccount(strangerName)).cookie;
		await enablePayouts(strangerName);
		return cookie;
	})();

	async function makeWork(
		cookie: string,
		title: string,
		maturity: DeclarableMaturity = "general",
	): Promise<{ id: number; slug: string; publicId: number }> {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				type: "game",
				title,
				maturityRows: rowsRatedAs(maturity),
				credits: CREATED_CREDIT,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()).work;
	}

	async function publishWithBody(
		body: string,
		cookie?: string,
	): Promise<{ slug: string; body: string; linkedWorks: Array<{ work: { id: number } }> }> {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: cookie ?? (await owner),
			},
			body: JSON.stringify({ title: `Embeds ${id}`, body, isPublished: true }),
		});
		expect(res.status).toBe(201);
		const response = (await res.json()) as {
			post: { slug: string; body: string; linkedWorks: Array<{ work: { id: number } }> };
		};
		return response.post;
	}

	async function detailOf(slug: string, cookie?: string) {
		const res = await req(`/api/content/posts/${slug}`, {
			headers: cookie ? { Cookie: cookie } : {},
		});
		expect(res.status).toBe(200);
		return (await res.json()) as {
			post: { body: string; linkedWorks: Array<{ work: { id: number } }> };
		};
	}

	it("orders embeds by first appearance in the body", async () => {
		const a = await makeWork(await owner, "Embed first build");
		const b = await makeWork(await owner, "Embed second build");
		const post = await publishWithBody(
			`https://anthers.org/works/${b.slug}-${b.publicId}\n\nhttps://anthers.org/works/${a.slug}-${a.publicId}`,
		);
		expect(post.linkedWorks.map((r) => r.work.id)).toEqual([b.id, a.id]);
	});

	it("allows embedding another creator's Work, gated on its own standing", async () => {
		const work = await makeWork(await owner, "Cited build");
		const post = await publishWithBody(
			`Have you seen https://anthers.org/works/${work.slug}-${work.publicId}?`,
			await stranger,
		);
		expect(post.linkedWorks.length).toBe(1);
	});

	it("a dead link renders no card and leaves the text alone", async () => {
		const post = await publishWithBody(
			"No such work: https://anthers.org/works/gone-away-123456789",
		);
		expect(post.linkedWorks.length).toBe(0);
		expect(post.body).toContain("/works/gone-away-123456789");
	});

	it("an Adult embed drops for an unverified stranger; the creator still sees their own", async () => {
		const work = await makeWork(await owner, "Adult embed build", "adult");
		const post = await publishWithBody(
			`Quiet link: https://anthers.org/works/${work.slug}-${work.publicId}`,
		);
		// The creator's own embed stays (their own card, on the same rule the listing uses).
		expect(post.linkedWorks.length).toBe(1);

		// A signed-in stranger who has not opted in gets the words, not the card.
		const asStranger = await detailOf(post.slug, await stranger);
		expect(asStranger.post.linkedWorks.length).toBe(0);
		expect(asStranger.post.body).toContain("/works/");
	});

	it("the Postgres-side history pattern reads the same shape", () => {
		// The SQL-side derivations (a Work's posting history, the feed's type filter)
		// match by this string; the route tests above prove the extractor, this proves
		// the helper itself — a change to one shape without the other is the drift.
		expect(pgWorkEmbedPattern(123456789)).toBe("/works/[^[:space:]()>'\"]*-?123456789([^0-9]|$)");
		expect(workPublicIdsFromBody("x-123456789 y")).toEqual([]); // no /works/ prefix, no match
	});
});
