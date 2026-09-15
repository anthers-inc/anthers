// SPDX-License-Identifier: Apache-2.0
/**
 * Replies in a real browser: writing one, where it lands, and the two states a reply's parent
 * can be in that must not look alike.
 *
 * 🚨 **Where a reply is drawn is the claim, and only the screen can check it.** The API suite
 * proves a reply is stored under the comment it answers and arrives in reading order; nothing
 * there can tell whether the page indents it, stops indenting at the limit, or quietly renders
 * a flat list that happens to be in the right order. So these assert on position.
 *
 * ⚠️ **The prefix is `E2E-reply`, not `E2E `, on purpose.** `votes.authed.e2e.ts` sweeps every
 * comment whose body starts `E2E ` on the same fixture post, and the two specs may run at once.
 */
import { db } from "@anthers/db/client";
import { GAUNTLET_CREATOR_USERNAME, GAUNTLET_SLUG_PREFIX } from "@anthers/db/gauntlet";
import { comments, posts, users } from "@anthers/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { expect, signInAsCreator, test } from "./fixtures";

/** The gauntlet's free post; see `votes.authed.e2e.ts` for why the slug carries `-post`. */
const POST_SLUG = `${GAUNTLET_SLUG_PREFIX}free-post-post`;

/** Serial, because the tests share one post and one sweep. */
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const text = (label: string) => `E2E-reply ${label} ${RUN}`;

let postId = 0;
let authorId = 0;

async function sweep() {
	const stale = await db
		.select({ id: comments.id })
		.from(comments)
		.where(like(comments.body, "E2E-reply %"));
	if (stale.length > 0) {
		await db.delete(comments).where(
			inArray(
				comments.id,
				stale.map((s) => s.id),
			),
		);
	}
}

/** Insert a comment on the post, or a reply to `on`. The sweep takes it away afterwards. */
async function insert(label: string, on: number | null, moderationStatus = "visible") {
	const [row] = await db
		.insert(comments)
		.values({
			userId: authorId,
			subjectType: on === null ? "post" : "comment",
			subjectId: on ?? postId,
			body: text(label),
			moderationStatus,
		})
		.returning({ id: comments.id });
	return row.id;
}

test.beforeAll(async () => {
	// A run that threw in `beforeAll` never reaches `afterAll`, so its leftovers go first.
	await sweep();
	const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, POST_SLUG));
	expect(post, `the gauntlet post ${POST_SLUG} is missing`).toBeTruthy();
	postId = post.id;
	const [author] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, GAUNTLET_CREATOR_USERNAME));
	authorId = author.id;
});

test.afterAll(async () => {
	await sweep();
});

/** The left edge of a comment's text, which is where its indent shows. */
async function leftOf(page: import("@playwright/test").Page, label: string): Promise<number> {
	const box = await page.getByText(text(label), { exact: true }).boundingBox();
	expect(box, `${text(label)} is not on the page`).toBeTruthy();
	return (box as { x: number }).x;
}

test("⭐ a reply written in the browser lands under the comment it answers, indented", async ({
	page,
	context,
}) => {
	const top = await insert("question", null);
	await signInAsCreator(context);
	await page.goto(`/posts/${POST_SLUG}`);

	// The innermost block holding the comment's text is its own row, so the Reply button found
	// inside it is this comment's rather than another one by the same author.
	const row = page
		.locator("div")
		.filter({ hasText: text("question") })
		.last();
	await row.getByRole("button", { name: /^Reply to/ }).click();
	const field = page.getByRole("textbox", { name: `Reply to ${GAUNTLET_CREATOR_USERNAME}` });
	await field.fill(text("answer"));
	const posted = page.waitForResponse(
		(r) => r.request().method() === "POST" && r.url().endsWith(`/posts/${POST_SLUG}/comments`),
	);
	await page.getByRole("button", { name: "Post reply" }).click();
	expect((await posted).status()).toBe(201);

	// ⚠️ **Wait for the form to close before looking for the words.** `getByText` also matches
	// the textarea while it still holds them, so looking first passes before the write lands.
	await expect(field).toHaveCount(0);
	await expect(page.getByText(text("answer"), { exact: true })).toBeVisible();
	const [stored] = await db
		.select({ id: comments.id, subjectType: comments.subjectType, subjectId: comments.subjectId })
		.from(comments)
		.where(and(eq(comments.body, text("answer")), eq(comments.userId, authorId)));
	expect([stored.subjectType, stored.subjectId]).toEqual(["comment", top]);

	// Still under it after a reload, so this is the thread as served and not the page's own guess.
	await page.reload();
	expect(await leftOf(page, "answer")).toBeGreaterThan(await leftOf(page, "question"));
});

test("🚨 past the last indent, a reply lines up with the one it answers and names who that is", async ({
	page,
	context,
}) => {
	const top = await insert("root", null);
	const one = await insert("one", top);
	const two = await insert("two", one);
	const three = await insert("three", two);
	await insert("four", three);

	await signInAsCreator(context);
	await page.goto(`/posts/${POST_SLUG}`);

	const x = {
		root: await leftOf(page, "root"),
		one: await leftOf(page, "one"),
		two: await leftOf(page, "two"),
		three: await leftOf(page, "three"),
		four: await leftOf(page, "four"),
	};
	expect(x.one).toBeGreaterThan(x.root);
	expect(x.two).toBeGreaterThan(x.one);
	expect(x.three).toBeGreaterThan(x.two);
	// The fourth reply has run out of indent, so it sits level with the third and says so.
	expect(x.four).toBe(x.three);
	// The innermost block holding both the label and the fourth reply is the fourth reply's own,
	// so a label drawn above some other reply cannot satisfy this.
	const fourth = page
		.locator("div")
		.filter({ hasText: text("four") })
		.filter({ hasText: "Replying to" })
		.last();
	await expect(fourth).not.toContainText(text("three"));
	await expect(
		fourth.getByText(`Replying to ${GAUNTLET_CREATOR_USERNAME}`, { exact: true }),
	).toBeVisible();
});

test("🚨 a removed comment with a reply beneath it reads as a removal, and shows nothing it said", async ({
	page,
	context,
}) => {
	const removed = await insert("removed", null, "hidden");
	await insert("survivor", removed);

	await signInAsCreator(context);
	await page.goto(`/posts/${POST_SLUG}`);

	await expect(page.getByText(text("survivor"), { exact: true })).toBeVisible();
	await expect(page.getByText(text("removed"))).toHaveCount(0);
	// A removal is not a tombstone: nobody is named, and nothing claims an author deleted it.
	const gap = page.getByText("This comment was removed by moderation.");
	await expect(gap).toBeVisible();
	expect(await leftOf(page, "survivor")).toBeGreaterThan(
		((await gap.boundingBox()) as { x: number }).x,
	);
});
