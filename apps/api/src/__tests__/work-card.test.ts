// SPDX-License-Identifier: Apache-2.0
/**
 * The card a link preview is built from.
 *
 * Three things this suite exists to keep true, each of which has no other guard:
 *
 * 1. **An unfurl leaves no trace.** The page read counts a view; the card read must not,
 *    and a shared link is opened by every chat client, feed reader and search crawler that
 *    meets it. The count is asserted from the row, not from the code's intent.
 * 2. **The invisibility rule reaches this route too.** Adult Work already 404s on the page
 *    and in every listing; a card endpoint that answered it would hand the title and
 *    thumbnail back to the exact audience the rating withholds them from.
 * 3. **A rating above General serves the site card, not the Work's.** The endpoint answers
 *    `preview: null` for Mature rather than the facts, because the preview lands somewhere
 *    the reader never chose to meet the work.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, type WorkFixture } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `card_c_${run}`;

const THUMBNAIL = "https://cdn.anthers.org/creators/1/card-fixture.png";

let creatorId: number;
beforeAll(async () => {
	creatorId = (await createAccount(creatorName, { fields: { isCreator: true } })).userId;
}, DB_SETUP_TIMEOUT);

async function aWork(overrides: Partial<WorkFixture>) {
	return insertWork({
		creatorId,
		type: "text",
		title: "A Quiet Year",
		description: "A short game about a garden that keeps growing.",
		thumbnail: THUMBNAIL,
		...overrides,
	});
}

const canonical = (work: { slug: string; publicId: number }) =>
	`/api/content/works/${work.slug}-${work.publicId}/card`;

describe("GET /works/:id/card", () => {
	it(
		"serves a General Work's own title, blurb and thumbnail",
		async () => {
			const work = await aWork({ maturity: "general" });
			const res = await req(canonical(work));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				preview: {
					title: "A Quiet Year",
					description: "A short game about a garden that keeps growing.",
					image: THUMBNAIL,
				},
			});
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"counts no view, while the page route counts one",
		async () => {
			const work = await aWork({ maturity: "general" });
			const before = await db
				.select({ viewCount: works.viewCount })
				.from(works)
				.where(eq(works.id, work.id));
			await req(canonical(work));
			const afterCard = await db
				.select({ viewCount: works.viewCount })
				.from(works)
				.where(eq(works.id, work.id));
			expect(afterCard[0]!.viewCount).toBe(before[0]!.viewCount);

			// The page's write is fire-and-forget, so give it a moment; the point of this half
			// is that the observation can see a view when one is actually recorded.
			await req(`/api/content/works/${work.slug}-${work.publicId}`);
			let views = afterCard[0]!.viewCount;
			for (let i = 0; i < 20 && views === before[0]!.viewCount; i += 1) {
				await Bun.sleep(25);
				views = (
					await db.select({ viewCount: works.viewCount }).from(works).where(eq(works.id, work.id))
				)[0]!.viewCount;
			}
			expect(views).toBeGreaterThan(before[0]!.viewCount);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"serves the site card for Mature, and hides an Adult Work's existence",
		async () => {
			const mature = await aWork({ maturity: "mature" });
			const matureRes = await req(canonical(mature));
			expect(matureRes.status).toBe(200);
			expect(await matureRes.json()).toEqual({ preview: null });

			const adult = await aWork({ maturity: "adult" });
			expect((await req(canonical(adult))).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a Work that is not released",
		async () => {
			const work = await aWork({ maturity: "general", visibility: "private" });
			expect((await req(canonical(work))).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"answers a Work it does not have with the same 404 as the page",
		async () => {
			expect((await req("/api/content/works/no-such-work-999/card")).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);
});
