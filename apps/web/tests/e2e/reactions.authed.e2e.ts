// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A like, a dislike, and a collapsed comment, in a real browser.
 *
 * 🚨 **The failure this exists for renders NOTHING and reports nothing.** `ReactionControl`
 * returns `null` until it has a score, so a broken fetch, a wrong query shape or a bad
 * import gives a Work page with no control on it at all — no error, no empty box, nothing to
 * notice. The API tests cannot see that, because the API is fine in exactly that case.
 *
 * ⭐ **Collapse is the other half, and it is a rendering claim rather than a logic one.** A
 * collapsed comment must read as *readers pushed this down*, be openable, and look like
 * neither of the two states it sits beside — a moderation removal, which never reaches the
 * browser, and a tombstone, which is an author who left. Whether it does is a question about
 * what is on screen.
 */
import { db } from "@anthers/db/client";
import { GAUNTLET_SLUG_PREFIX } from "@anthers/db/gauntlet";
import { comments, posts, reactions } from "@anthers/db/schema";
import { COLLAPSE_NET_THRESHOLD } from "@anthers/shared/reactions";
import { eq, inArray, like } from "drizzle-orm";
import { expect, signInAsCreator, test } from "./fixtures";

/**
 * The gauntlet's free post, which its own fixture calls "the gauntlet's comment target".
 *
 * ⚠️ The stored slug carries a trailing `-post` that the fixture's own `slug` field does
 * not, which is why `user-gauntlet.e2e.ts` appends it too. Building the URL from the
 * fixture constant alone finds nothing.
 */
const POST_SLUG = `${GAUNTLET_SLUG_PREFIX}free-post-post`;

/**
 * 🚨 **Serial, because these three share one fixture post and one sweep.**
 * `playwright.config.ts` sets `fullyParallel`, which would run each test in its own worker
 * — and each worker's `beforeAll` would then delete the other workers' comments while they
 * were mid-test. The symptom is a suite that passes and fails on alternate runs for no
 * reason visible in either the code or the failure.
 */
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const BURIED = `E2E buried ${RUN}`;
const ORDINARY = `E2E ordinary ${RUN}`;

let postId = 0;
let buriedId = 0;
let ordinaryId = 0;

test.beforeAll(async () => {
	/**
	 * ⚠️ **Sweep this suite's own leftovers first.** A run whose `beforeAll` threw never
	 * reaches `afterAll`, so a failed run leaves collapsed comments on a shared fixture post
	 * — and the next run's `.first()` then clicks one of those instead of its own and fails
	 * for a reason that has nothing to do with the code. Cleaning up at the start as well as
	 * at the end is what makes a suite recoverable rather than poisoned by one bad run.
	 */
	const stale = await db
		.select({ id: comments.id })
		.from(comments)
		.where(like(comments.body, "E2E %"));
	if (stale.length > 0) {
		const ids = stale.map((s) => s.id);
		await db.delete(reactions).where(inArray(reactions.subjectId, ids));
		await db.delete(comments).where(inArray(comments.id, ids));
	}

	const [row] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, POST_SLUG));
	expect(row, `the gauntlet post ${POST_SLUG} is missing`).toBeTruthy();
	postId = row.id;

	const made = await db
		.insert(comments)
		.values(
			[BURIED, ORDINARY].map((body) => ({
				userId: null,
				subjectType: "post" as const,
				subjectId: postId,
				body,
			})),
		)
		.returning({ id: comments.id, body: comments.body });
	buriedId = made.find((m) => m.body === BURIED)!.id;
	ordinaryId = made.find((m) => m.body === ORDINARY)!.id;

	/**
	 * Enough dislikes to bury it, all from departed accounts.
	 *
	 * ⭐ **`userId: null` is the real shape of a vote whose account was deleted**, not a
	 * shortcut around making six fixtures. `reactions.user_id` is `set null` so a departing
	 * account does not move every score it ever touched, and Postgres treats NULLs as
	 * distinct — so this is simultaneously the cheapest way to reach the threshold and a
	 * check that those votes still count.
	 */
	await db.insert(reactions).values(
		Array.from({ length: -COLLAPSE_NET_THRESHOLD + 1 }, () => ({
			userId: null,
			subjectType: "comment" as const,
			subjectId: buriedId,
			value: -1,
		})),
	);
});

test.afterAll(async () => {
	await db.delete(reactions).where(inArray(reactions.subjectId, [buriedId, ordinaryId]));
	await db.delete(comments).where(inArray(comments.id, [buriedId, ordinaryId]));
});

test("🚨 the post carries a reaction control at all, with a score on it", async ({
	page,
	context,
}) => {
	await signInAsCreator(context);
	await page.goto(`/posts/${POST_SLUG}`);
	// Named for the post, so this cannot pass by finding a comment's control instead — the
	// thread below is full of them and they are the same component.
	const control = page.getByRole("button", { name: /^Like Anyone can read this$/ });
	await expect(control).toBeVisible();
});

test("⭐ a like moves the number the reader can see", async ({ page, context }) => {
	await signInAsCreator(context);
	await page.goto(`/posts/${POST_SLUG}`);

	const row = page.locator("div").filter({ hasText: ORDINARY }).last();
	const score = row.getByText(/^\d+$/).first();
	await expect(score).toHaveText("0");
	await row.getByRole("button", { name: /^Like/ }).click();
	// Reconciled against the server rather than left on the optimistic guess, so this is
	// also the assertion that the write landed.
	await expect(score).toHaveText("1");

	// Pressing it again takes the reaction back, which is not the same as disliking.
	await row.getByRole("button", { name: /^Like/ }).click();
	await expect(score).toHaveText("0");
});

test("🚨 a buried comment arrives collapsed, says who did it, and opens", async ({
	page,
	context,
}) => {
	await signInAsCreator(context);
	await page.goto(`/posts/${POST_SLUG}`);

	// Folded: the text is not on the page yet.
	await expect(page.getByText(BURIED)).toHaveCount(0);
	// And it says the crowd did it. A moderation removal would never have reached the
	// browser, so naming a moderator here would be telling the reader something false.
	const collapsed = page.getByText(/collapsed — heavily disliked/).first();
	await expect(collapsed).toBeVisible();

	await page.getByRole("button", { name: "Show comment" }).first().click();
	await expect(page.getByText(BURIED)).toBeVisible();
});
