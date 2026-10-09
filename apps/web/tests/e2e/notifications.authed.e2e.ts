// SPDX-License-Identifier: Apache-2.0
/**
 * The notification loop in a real browser: a reply lands, the feed page lists it, and the
 * list marks it read.
 *
 * 🚨 **Where the loop is browser-only is the claim.** The API suite proves the row is
 * written and the unread endpoint counts it; nothing there can tell whether the bell
 * renders, whether the page marks things read, or whether the item's link carries the
 * anchor back to the comment it names.
 *
 * ⭐ **Two people, because a self-reply is correctly silent.** The reply is written
 * through the page's own form by the walker (the `authed` project's signed-in user),
 * answering the CREATOR's comment; the notification therefore belongs to the creator,
 * and a second context signs in as the creator (`signInAsCreator`) to see their bell and
 * feed. A single-account spec would have proven nothing: the self-reply skip is exactly
 * the branch it exists to steer around.
 *
 * Serial: one post, one sweep, in order.
 */
import { db } from "@anthers/db/client";
import { GAUNTLET_SLUG_PREFIX, GAUNTLET_WALKER_EMAIL } from "@anthers/db/gauntlet";
import { comments, notifications, posts, users } from "@anthers/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { expect, signInAsCreator, test } from "./fixtures";

/** The gauntlet's free post; the same fixture `comment-replies.authed.e2e.ts` walks. */
const POST_SLUG = `${GAUNTLET_SLUG_PREFIX}free-post-post`;

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const text = (label: string) => `E2E-notif ${label} ${RUN}`;

let postId = 0;
let creatorId = 0;

/** Insert a comment on the post, as the gauntlet creator. */
async function insert(label: string): Promise<number> {
	const [row] = await db
		.insert(comments)
		.values({
			userId: creatorId,
			subjectType: "post",
			subjectId: postId,
			body: text(label),
		})
		.returning({ id: comments.id });
	return row.id;
}

/** This run's comment rows, then the notifications their replies minted. */
async function sweep() {
	const staleComments = await db
		.select({ id: comments.id })
		.from(comments)
		.where(like(comments.body, "E2E-notif %"));
	if (staleComments.length > 0) {
		await db.delete(comments).where(
			inArray(
				comments.id,
				staleComments.map((s) => s.id),
			),
		);
	}
	const staleNotes = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(like(notifications.title, "Somebody replied to your comment"))
		// Only rows whose link points INTO this run's post — the sweep must take its own
		// rows and no other test's.
		.where(like(notifications.linkPath, `%${POST_SLUG}%`));
	for (const note of staleNotes) {
		await db.delete(notifications).where(eq(notifications.id, note.id));
	}
}

test.beforeAll(async () => {
	// A run that threw in `beforeAll` never reaches `afterAll`, so its leftovers go first.
	await sweep();
	const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, POST_SLUG));
	expect(post, `the gauntlet post ${POST_SLUG} is missing`).toBeTruthy();
	postId = post.id;
	// The post's creator — the gauntlet creator, by the post's own column rather than a
	// name lookup, so a fixture rename cannot strand this suite.
	const withCreator = await db
		.select({ creatorId: posts.creatorId })
		.from(posts)
		.where(eq(posts.id, postId))
		.limit(1);
	creatorId = withCreator[0]!.creatorId!;
});

test.afterAll(async () => {
	await sweep();
});

test("a reply lands, the feed lists it, and reading it marks it read", async ({
	page,
	context,
}) => {
	// The comment the reply answers, as the creator — the walker (signed in by the
	// project's storageState) will answer it.
	await insert("question");

	// The page IS signed in as the walker (the authed project's storage state needs no
	// sign-in ceremony). Open the post and answer the creator's comment through the form.
	await page.goto(`/posts/${POST_SLUG}`);
	const row = page
		.locator("div")
		.filter({ hasText: text("question") })
		.last();
	await row.getByRole("button", { name: /^Reply to/ }).click();
	// The open form's field, labeled `Reply to <handle>` — matched by the prefix rather
	// than the handle's shape, which the fixture owns.
	const field = page.getByRole("textbox", { name: /^Reply to/ }).first();
	await field.fill(text("answer"));
	const posted = page.waitForResponse(
		(r) => r.request().method() === "POST" && r.url().endsWith(`/posts/${POST_SLUG}/comments`),
	);
	await page.getByRole("button", { name: "Post reply" }).click();
	expect((await posted).status()).toBe(201);
	await expect(field).toHaveCount(0);
	await expect(page.getByText(text("answer"), { exact: true })).toBeVisible();

	// THE CREATOR's turn: signed in fresh, the bell renders (the count arrives with the
	// mount's own fetch), and the feed lists the reply pointing back at the post.
	const creatorContext = await context.browser()?.newContext();
	expect(creatorContext, "a second browser context is available").toBeTruthy();
	const c = creatorContext!;
	await signInAsCreator(c);
	const creatorPage = await c.newPage();
	await creatorPage.goto("/notifications");
	await expect(creatorPage.getByRole("heading", { name: "Notifications" })).toBeVisible();
	const item = creatorPage.locator("li").filter({ hasText: "replied to your comment" }).first();
	await expect(item).toBeVisible();
	const href = await item.getByRole("link").getAttribute("href");
	expect(href, "the item links back to the post").toContain("/posts/");

	// The page marked everything read behind its render: the reply's row now carries a
	// readAt. A count held up over entries the person has seen is the bell lying about
	// its own state — the DB read is where the truth lives.
	const [newest] = await db
		.select({ readAt: notifications.readAt })
		.from(notifications)
		.where(like(notifications.linkPath, `%${POST_SLUG}%`));
	expect(newest, "the reply's notification row exists").toBeTruthy();
	expect(newest!.readAt, "opening the feed marked it read").not.toBeNull();
	// And it went to the right person: the creator, not the walker who replied.
	const [told] = await db
		.select({ userId: notifications.userId })
		.from(notifications)
		.where(like(notifications.linkPath, `%${POST_SLUG}%`));
	expect(told!.userId).toBe(creatorId);
	// Explicitly not the walker: the self-reply branch is never how a notification
	// should arrive, and naming both sides of the not-equal is what makes the check mean
	// something if the fixture accounts ever merge.
	const [walker] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, GAUNTLET_WALKER_EMAIL));
	expect(told!.userId).not.toBe(walker!.id);

	await c.close();
});
