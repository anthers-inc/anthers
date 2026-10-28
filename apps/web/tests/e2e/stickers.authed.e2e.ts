// SPDX-License-Identifier: Apache-2.0
/**
 * The Sticker picker and the give it performs, in a real browser.
 *
 * 🚨 **The failure class is the votes suite's: the control renders nothing and reports
 * nothing.** `StickerBar` draws only its decoration while it has no data, so a broken import,
 * a wrong endpoint parse or a collapsed dropdown leaves a page that looks finished but admits
 * no giving at all. The API suites cannot see that failure, because the API is fine in exactly
 * that case.
 *
 * ⭐ **What a give leaves behind is an outline, not a count** (Parker, 2026-09-13). The wall of
 * chips this suite used to assert published how many Stickers of each drawing a thing carried,
 * which let a reader add up the money; the mark counts distinct levels and states no amount.
 *
 * ⭐ **The overlay is the product claim** (Parker, 2026-10-16): the picker is a dropdown
 * over the page and not an inline expansion — opening it must move nothing below it. A
 * regression here shows as the layout shifting, which is exactly how the first version
 * shipped broken.
 *
 * ⭐ **The picker shows what each denomination is worth and how many of it the giver has
 * left** (Parker, 2026-10-16), so nobody divides their Badge's allowance in their head —
 * and no batch-name heading and no explainer sentence: both left with this same change.
 */
import { db } from "@anthers/db/client";
import {
	GAUNTLET_CREATOR_EMAIL,
	GAUNTLET_SLUG_PREFIX,
	GAUNTLET_WALKER_EMAIL,
} from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import {
	badges,
	comments,
	posts,
	stickers,
	stripeConnectAccounts,
	stripeCustomers,
	userBadges,
	users,
	works,
} from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { STICKER_DENOMINATIONS, stickerBudgetFor } from "@anthers/shared/constants";
import type { Page } from "@playwright/test";
import { and, eq, or, sql } from "drizzle-orm";
import { expect, signInAsWalker, test, trackErrorsStrict } from "./fixtures";

/**
 * The gauntlet's free post — published, and authored by the gauntlet creator, which is not
 * the account this suite signs in as. The API refuses a Sticker on your own work, so giver
 * and subject's author have to be two accounts for the give to be real.
 */
const POST_SLUG = `${GAUNTLET_SLUG_PREFIX}free-post-post`;
/** The media fixture's video Work — released, authored by `media_fixture`, also not the giver. */
const WORK_SLUG = "media-fixture-video";

/**
 * The canonical paths, built from the publicIds the fixtures carry — both pages
 * canonicalize `/posts/{slug}` to `/posts/{slug}-{publicId}` with a replace navigation
 * after load, and that settle tears the page to a spinner on its way. Arriving canonical
 * leaves the settle to the load and this suite watching the picker, not the router.
 */
let POST_PATH = "";
let WORK_PATH = "";

/**
 * The allowance this suite's giver holds: their Badge is Blossom at $12, and what that
 * funds is the model's own derivation — never typed here, so the picker's counts and the
 * suite's expectations answer from the same source. The count of a denomination is the
 * allowance divided by that denomination, floored, with the epsilon the component uses.
 */
const GIVER_BADGE_DOLLARS = 12;
const ALLOWANCE = stickerBudgetFor(GIVER_BADGE_DOLLARS);
const leftFor = (amount: number) => Math.floor(ALLOWANCE / amount + 1e-9);

// ⚠️ Serial: the tests share one fixture giver, one Badge holding and an allowance that
// moves as they give — a parallel worker would refetch its own numbers mid-move.
test.describe.configure({ mode: "serial" });

let walkerId = 0;
let postId = 0;
let workId = 0;
/** The cycle the fixture gives into, and whether its billing row is this suite's own. */
let cycle = "";
let billingRowMine = false;

/**
 * The row filter naming every Sticker this suite might have left.
 *
 * ⚠️ **The comment arm is the walker's own comments**, because since 2026-10-24 a comment is a
 * valid subject and this suite writes one to exercise the editor's chooser. Scoped by author
 * rather than by "any comment on the post", which would reach other suites' rows.
 */
function thisGiversStickers(): ReturnType<typeof sql> {
	return sql`(giver_id = ${walkerId} AND (
		(subject_type = 'post' AND subject_id = ${postId})
		OR (subject_type = 'work' AND subject_id = ${workId})
		OR (subject_type = 'comment' AND subject_id IN (SELECT id FROM comments WHERE user_id = ${walkerId}))
	))`;
}

/**
 * The Anthers ladder's owner id — the same handle predicate `anthersUserId`
 * (`apps/api/src/services/anthers-badges.ts`) reads, replicated because no web-side import
 * path reaches an api module. 🚨 Keep the two identical, or import one of them the day a
 * path opens; a drift here finds a different ladder or none, and the picker's counts then
 * answer from a world nobody else is standing in.
 */
async function anthersLadderOwnerId(): Promise<number> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(or(eq(users.atprotoHandle, "anthers"), sql`${users.atprotoHandle} LIKE 'anthers.%'`))
		.orderBy(users.id)
		.limit(1);
	expect(row, "the Anthers Badge ladder's owner exists — db:seed has run").toBeTruthy();
	return row!.id;
}

test.beforeAll(async () => {
	const [[walker], [post], [work]] = await Promise.all([
		db.select({ id: users.id }).from(users).where(eq(users.email, GAUNTLET_WALKER_EMAIL)).limit(1),
		db
			.select({ id: posts.id, publicId: posts.publicId })
			.from(posts)
			.where(eq(posts.slug, POST_SLUG))
			.limit(1),
		db
			.select({ id: works.id, publicId: works.publicId })
			.from(works)
			.where(eq(works.slug, WORK_SLUG))
			.limit(1),
	]);
	expect(walker, "the gauntlet walker exists — db:gauntlet --ensure-walker has run").toBeTruthy();
	expect(post, `the gauntlet post ${POST_SLUG} is missing`).toBeTruthy();
	expect(work, `the media fixture's Work ${WORK_SLUG} is missing`).toBeTruthy();
	walkerId = walker!.id;
	postId = post!.id;
	workId = work!.id;
	POST_PATH = `/posts/${POST_SLUG}-${post!.publicId}`;
	WORK_PATH = `/works/${WORK_SLUG}-${work!.publicId}`;

	// Sweep this suite's leftovers from a run whose afterAll never reached, in the cycle
	// the route reads and any other — a failed run's rows must not pre-spend the
	// allowance this suite's fixture gives.
	await db.delete(stickers).where(thisGiversStickers());

	// The giver's Badge, in the cycle the route will read it from — the current cycle key
	// by the real function, because a cycle key built by hand is exactly what the codebase
	// refuses ("never build this key by hand").
	cycle = currentCycleKey();
	const [existing] = await db
		.select({ id: stripeCustomers.id })
		.from(stripeCustomers)
		.where(eq(stripeCustomers.userId, walkerId))
		.limit(1);
	if (!existing) {
		await db.insert(stripeCustomers).values({
			userId: walkerId,
			currentPeriodStart: new Date(`${cycle}T00:00:00Z`),
			currentPeriodEnd: new Date(`${cycle}T00:00:00Z`),
			isActive: true,
		});
		billingRowMine = true;
	}
	const anthersId = await anthersLadderOwnerId();
	const threshold = GIVER_BADGE_DOLLARS.toFixed(2);
	const [rung] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, threshold)))
		.limit(1);
	expect(rung, `the Anthers ladder has a rung at $${threshold}`).toBeTruthy();
	// Replace only the ladder-owned holding in this cycle, never the walker's other rows.
	await db
		.delete(userBadges)
		.where(
			and(
				eq(userBadges.userId, walkerId),
				eq(userBadges.billingCycle, cycle),
				sql`${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${anthersId})`,
			),
		);
	await db.insert(userBadges).values({ userId: walkerId, badgeId: rung!.id, billingCycle: cycle });

	// The subject's creators must be payable, or the give 409s for a reason that is not
	// the picker's. Written the way `enablePayoutsFor` writes it and left standing — both
	// fixture creators are shared and reset by nothing here, so their rows are not this
	// suite's to take back.
	for (const [label, email] of [
		["media_fixture", MEDIA_FIXTURE_EMAIL],
		["the gauntlet creator", GAUNTLET_CREATOR_EMAIL],
	] as const) {
		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(1);
		expect(creator, `${label} exists`).toBeTruthy();
		await db.update(users).set({ creatorMode: true }).where(eq(users.id, creator!.id));
		await db
			.insert(stripeConnectAccounts)
			.values({
				userId: creator!.id,
				// Marked as a fixture, so it can never collide with a real `acct_` id.
				stripeAccountId: `acct_test_${creator!.id}_${crypto.randomUUID().slice(0, 8)}`,
				onboardingComplete: true,
				payoutsEnabled: true,
				chargesEnabled: true,
			})
			.onConflictDoUpdate({
				target: stripeConnectAccounts.userId,
				set: { onboardingComplete: true, payoutsEnabled: true, chargesEnabled: true },
			});
	}
});

test.afterAll(async () => {
	// ⚠️ Scope the cleanup to what this suite wrote: the Stickers it gave, the
	// ladder-owned Badge holding it put on the walker in its cycle, and (only if missing
	// beforehand) the billing row the cycle rides. The payout row on the shared creator
	// stands.
	await db.delete(stickers).where(thisGiversStickers());
	if (walkerId) {
		// The comment the editor test wrote goes with its Sticker; the post it answered stays.
		await db
			.delete(comments)
			.where(
				and(
					eq(comments.userId, walkerId),
					eq(comments.subjectType, "post"),
					eq(comments.subjectId, postId),
				),
			);
		if (cycle) {
			await db
				.delete(userBadges)
				.where(and(eq(userBadges.userId, walkerId), eq(userBadges.billingCycle, cycle)));
		}
		if (billingRowMine) {
			await db.delete(stripeCustomers).where(eq(stripeCustomers.userId, walkerId));
		}
	}
});

/** The picker's row buttons, by the shape only theirs carry: `"<art>, $<amount>"`. */
function pickerRows(page: Page) {
	return page.getByRole("button", { name: /^.*, \$\d+\.\d{2}$/ });
}

/** Open the picker by its accessible name, with no measurement — for tests past the first. */
async function openPickerPlain(page: Page, subjectName: string) {
	const trigger = page
		.getByRole("group", { name: `Add a Sticker to ${subjectName}` })
		.or(page.getByLabel(`Add a Sticker to ${subjectName}`));
	await expect(trigger.first()).toBeVisible();
	await trigger.first().click();
	const rows = pickerRows(page);
	await expect(rows.first()).toBeVisible();
	return rows;
}

/**
 * Open the picker and, with it, assert the overlay claim: whatever sits below the bar
 * (the comment entry on a post, the review form on a Work) must not move when the
 * dropdown opens.
 *
 * ⚠️ Measured only after the trigger is scrolled into view: the logged-in layout scrolls
 * in an internal container, so the click's own scroll-into-view moves every viewport
 * rectangle and would be mistaken for the dropdown shifting the page. Once the trigger is
 * in view the click performs no scroll, and any movement left is the dropdown's.
 */
async function openPicker(page: Page, subjectName: string) {
	const trigger = page
		.getByRole("group", { name: `Add a Sticker to ${subjectName}` })
		.or(page.getByLabel(`Add a Sticker to ${subjectName}`));
	await expect(trigger.first()).toBeVisible();
	await trigger.first().scrollIntoViewIfNeeded();
	const below = page.getByPlaceholder(/Write a comment|What did you think/i);
	const before = await below.evaluate((el) => el.getBoundingClientRect().top);
	await trigger.first().click();
	const after = await below.evaluate((el) => el.getBoundingClientRect().top);
	expect(
		Math.abs(after - before),
		"opening the picker must not move what sits below the bar",
	).toBeLessThan(1);

	const rows = pickerRows(page);
	await expect(rows.first()).toBeVisible();
	return rows;
}

test("🚨 the post carries the picker; its rows run smallest at the top with counts, and nothing below moves", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	await signInAsWalker(context);
	await page.goto(POST_PATH);

	const rows = await openPicker(page, "Anyone can read this");

	// Exactly this quarter's three, in the batch's own order — the batch is declared
	// simple to elaborate, so the DOM order is the display order Parker asked for:
	// smallest at the top.
	expect(await rows.count(), "the current batch's three Stickers").toBe(3);
	const texts = await rows.allTextContents();
	expect(texts[0]).toContain("$0.25");
	expect(texts[2]).toContain("$1.00");
	// Each row shows how many of its denomination the allowance still affords.
	for (const [i, art] of STICKER_DENOMINATIONS.entries()) {
		await expect(rows.nth(i)).toContainText(`(${leftFor(art)} left)`, { timeout: 5_000 });
	}

	// What left with the redesign, still absent.
	await expect(page.getByText("Butterflies")).toHaveCount(0);
	await expect(page.getByText("This directs part of the support")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("⭐ giving a Sticker lands the outline, closes the picker, and the count moves", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	await signInAsWalker(context);
	await page.goto(POST_PATH);

	const rows = await openPicker(page, "Anyone can read this");
	await rows.first().click();

	// ⭐ **The outline, not a count** (Parker, 2026-09-13): one level reads as one stripe, and
	// the page states no amount. A chip carrying "1" beside an art would be the count the
	// decision retired, so the assertion is the mark's own attribute.
	const mark = page.locator(`[data-sticker-decoration]`).first();
	await expect(mark).toBeVisible({ timeout: 5_000 });
	await expect(mark).toHaveAttribute("data-sticker-decoration", /^[1-3]$/);
	// The wall of chips is gone, including the one this give used to land.
	await expect(page.getByRole("button", { name: "Small Butterfly 1" })).toHaveCount(0);

	// The picker closed on its own once the give went through.
	await expect(pickerRows(page)).toHaveCount(0);

	// Reopening shows the refetched allowance and, under it, what this giver has on the page
	// — the picker is where taking one back lives now that the chips are gone.
	const fresh = await openPickerPlain(page, "Anyone can read this");
	await expect(fresh.first()).toContainText(`(${leftFor(0.25) - 1} left)`, { timeout: 5_000 });
	// ⚠️ Scoped to the open picker: a `<details>` renders its contents whether or not it is
	// open, so every comment row's picker also holds this line in the DOM.
	await expect(page.locator("details[open]").getByText("What you gave")).toBeVisible();
	expect(errors).toEqual([]);
});

/**
 * The picker on a page whose allowance the shared fixture has already moved (the give
 * test ran before this one in serial order), so the exact count a fresh open carries is
 * whatever the earlier tests left — asserted as "a count, in the picker's own shape"
 * rather than a number this test does not own.
 */
async function assertCountedRows(page: Page): Promise<void> {
	const rows = pickerRows(page);
	await expect(rows.first()).toBeVisible();
	await expect(rows.first()).toContainText(/\(\d+ left\)/, { timeout: 5_000 });
}

test("⭐ a comment takes its Sticker from the editor that writes it", async ({ page, context }) => {
	const errors = trackErrorsStrict(page);
	await signInAsWalker(context);
	await page.goto(POST_PATH);

	// The editor's own chooser, beside Post comment. Choosing one holds it for the message
	// rather than giving it there and then — the comment has no id until it is sent.
	const body = `Sticker award ${crypto.randomUUID().slice(0, 8)}`;
	await page.getByPlaceholder(/Write a comment/).fill(body);
	await page.getByLabel("Add a Sticker to your comment").click();
	const rows = pickerRows(page);
	await expect(rows.first()).toBeVisible();
	await rows.first().click();
	await expect(page.getByLabel("Remove the Sticker from your comment")).toBeVisible();

	await page.getByRole("button", { name: "Post comment" }).click();

	// The comment landed and the Sticker went with it: the post carried one from the give
	// test above, so the wall now holds two of this denomination.
	await expect(page.getByText(body)).toBeVisible({ timeout: 10_000 });
	// The comment carries its own outline inside the thread, beside its score — the post's is
	// outside `#comments`, so this counts only what the comment earned.
	await expect(page.locator("#comments [data-sticker-decoration]")).toHaveCount(1, {
		timeout: 10_000,
	});
	expect(errors).toEqual([]);
});

test("⭐ the picker is where a giver takes one back, now that no chip carries a Remove", async ({
	page,
	context,
}) => {
	await signInAsWalker(context);
	await page.goto(POST_PATH);
	await openPickerPlain(page, "Anyone can read this");

	// The give above left this giver a row under "What you gave" — that section is the home
	// removal has without chips to click. Scoped to the open picker, because a closed
	// `<details>` still holds its contents and every other row has one of these too.
	const open = page.locator("details[open]");
	await expect(open.getByText("What you gave")).toBeVisible();
	page.once("dialog", (dialog) => dialog.accept());
	await open.getByRole("button", { name: "Remove" }).first().click();

	// The row goes and the section goes with it; the money stays spent, which is the
	// confirmation's whole point and is asserted on the API side.
	await expect(open.getByText("What you gave")).toHaveCount(0, { timeout: 5_000 });
});

test("⭐ the review composer carries the Work's chooser, with the same rows", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	await signInAsWalker(context);
	await page.goto(WORK_PATH);
	// Reviews is the side column's default tab; the click names it the way its role names it.
	await page.getByRole("tab", { name: "Reviews", exact: true }).click();

	// ⭐ A Sticker for a Work rides a review (Parker, 2026-09-13), added from this editor.
	// There is no give on the Work page itself any more.
	await expect(page.getByLabel(/Add a Sticker to this Work/)).toHaveCount(0);
	await page.getByLabel("Add a Sticker to your review").click();
	await assertCountedRows(page);
	expect(errors).toEqual([]);
});
