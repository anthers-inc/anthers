// SPDX-License-Identifier: Apache-2.0
/**
 * The card a shared post is unfurled with.
 *
 * Three things this suite exists to keep true, each with no other guard:
 *
 * 1. **An unfurl leaves no trace.** The permalink counts a view; every chat client, feed
 *    reader and crawler that meets a pasted link asks for the card, and none of those are a
 *    read. The count is asserted from the row, not from the code's intent.
 * 2. **The permalink's own gates reach this route.** A draft and a suspended author's post
 *    each answer 404 on the page; a card that answered either would publish what the page
 *    withholds.
 * 3. **An Adult Work's cover is not a post's card image.** A post embeds Works by link, and
 *    its tile shows the first one's thumbnail — but that image reaches whoever the link is
 *    pasted to, and an Adult Work's cover is part of the existence its rung withholds.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { suspendAccount } from "../services/moderation";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, testPublicId, type WorkFixture } from "./work-fixtures.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;
function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `post_card_${run}`;

const THUMBNAIL = "https://cdn.anthers.org/creators/1/post-card-fixture.png";

let creatorId: number;
beforeAll(async () => {
	creatorId = (await createAccount(creatorName, { fields: { isCreator: true } })).userId;
}, DB_SETUP_TIMEOUT);

/** The markdown a post's body carries when it embeds a Work — the shape the feed parses. */
const embed = (work: { slug: string; publicId: number }, label = "the work") =>
	`[${label}](/works/${work.slug}-${work.publicId})`;

async function aPost(overrides: Partial<typeof posts.$inferInsert> = {}) {
	const [post] = await db
		.insert(posts)
		.values({
			creatorId,
			publicId: testPublicId(),
			slug: `post-card-${run}-${crypto.randomUUID().slice(0, 6)}`,
			title: "Hello, there",
			body: "A short note about the garden.",
			isPublished: true,
			publishedAt: new Date(),
			...overrides,
		})
		.returning();
	return post!;
}

async function aWork(overrides: Partial<WorkFixture>) {
	return insertWork({ creatorId, type: "text", title: "The Quiet Year", ...overrides });
}

const canonical = (post: { slug: string; publicId: number }) =>
	`/api/content/posts/${post.slug}-${post.publicId}/card`;

describe("GET /posts/:slug/card", () => {
	it(
		"serves the post's title, its words as plain text, and the Work it embeds",
		async () => {
			const work = await aWork({ thumbnail: THUMBNAIL });
			const post = await aPost({
				title: `New from [@quiet](/works/${work.slug}-${work.publicId})`,
				body: `A short note about the garden.\n\n${embed(work)}`,
			});

			const res = await req(canonical(post));
			expect(res.status).toBe(200);
			const { preview } = (await res.json()) as {
				preview: { title: string; description: string; image: string | null };
			};

			// The title resolves the mention to the Work's current name, exactly as the page's does.
			expect(preview.title).toBe("New from @The Quiet Year");
			// Markdown never reaches a preview: the body ships as the text a reader would see.
			expect(preview.description).toStartWith("A short note about the garden.");
			expect(preview.image).toBe(THUMBNAIL);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"counts no view, while the permalink counts one",
		async () => {
			const post = await aPost();
			const views = async () =>
				(
					await db.select({ viewCount: posts.viewCount }).from(posts).where(eq(posts.id, post.id))
				)[0]!.viewCount;

			const before = await views();
			await req(canonical(post));
			expect(await views()).toBe(before);

			// The page's write is fire-and-forget, so give it a moment rather than assuming.
			await req(`/api/content/posts/${post.slug}-${post.publicId}`);
			let after = before;
			for (let i = 0; i < 20 && after === before; i += 1) {
				await Bun.sleep(25);
				after = await views();
			}
			expect(after).toBeGreaterThan(before);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a draft, which the permalink also hides from everybody but its author",
		async () => {
			const post = await aPost({ isPublished: false, publishedAt: null });
			expect((await req(canonical(post))).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a suspended author's post rather than describing it",
		async () => {
			const author = await createAccount(`post_card_susp_${run}`, {
				fields: { isCreator: true },
			});
			const operator = await createAdminFixture("post-card-op");
			const post = await aPost({
				creatorId: author.userId,
				slug: `post-card-susp-${run}`,
				publicId: testPublicId(),
			});

			expect((await req(canonical(post))).status).toBe(200);
			await suspendAccount({
				userId: author.userId,
				adminId: operator.id,
				reason: "spam",
				note: "fixture",
			});
			expect((await req(canonical(post))).status).toBe(404);

			// Unsuspend so the purge below is the only cleanup this fixture needs.
			await db.update(users).set({ suspendedAt: null }).where(eq(users.id, author.userId));
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"never carries an Adult Work's cover, even when the post embeds one",
		async () => {
			const adult = await aWork({ maturity: "adult", thumbnail: THUMBNAIL });
			const post = await aPost({ body: `A note.\n\n${embed(adult, "a work")}` });

			const res = await req(canonical(post));
			expect(res.status).toBe(200);
			const { preview } = (await res.json()) as { preview: { image: string | null } };
			expect(preview.image).toBeNull();
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"names a title-less post the way its own page does, and still has a line to say",
		async () => {
			const post = await aPost({ title: "", body: "" });

			const res = await req(canonical(post));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				preview: {
					title: "Untitled",
					description: "A post on Anthers, a nonprofit creative garden for everyone.",
					image: null,
				},
			});
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"answers a post it does not have with the same 404 as the page",
		async () => {
			expect((await req("/api/content/posts/no-such-post-999/card")).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);
});
