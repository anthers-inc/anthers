// SPDX-License-Identifier: Apache-2.0
/**
 * The Sticker picker and the give it performs, in a real browser.
 *
 * 🚨 **The failure class is the votes suite's: the bar renders nothing and reports
 * nothing.** `StickerBar` draws only its wall of chips while it has no data, so a broken
 * import, a wrong endpoint parse or a collapsed dropdown leaves a page that looks finished
 * but admits no giving at all. The API suites cannot see that failure, because the API is
 * fine in exactly that case.
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
	billingAccounts,
	posts,
	stickers,
	stripeAccounts,
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

/** The row filter naming every Sticker this suite might have left at either subject. */
function thisGiversStickers(): ReturnType<typeof sql> {
	return sql`(giver_id = ${walkerId} AND ((subject_type = 'post' AND subject_id = ${postId}) OR (subject_type = 'work' AND subject_id = ${workId})))`;
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
		.select({ id: billingAccounts.id })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, walkerId))
		.limit(1);
	if (!existing) {
		await db.insert(billingAccounts).values({
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
		await db.update(users).set({ isCreator: true }).where(eq(users.id, creator!.id));
		await db
			.insert(stripeAccounts)
			.values({
				userId: creator!.id,
				// Marked as a fixture, so it can never collide with a real `acct_` id.
				stripeAccountId: `acct_test_${creator!.id}_${crypto.randomUUID().slice(0, 8)}`,
				onboardingComplete: true,
				payoutsEnabled: true,
				chargesEnabled: true,
			})
			.onConflictDoUpdate({
				target: stripeAccounts.userId,
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
		if (cycle) {
			await db
				.delete(userBadges)
				.where(and(eq(userBadges.userId, walkerId), eq(userBadges.billingCycle, cycle)));
		}
		if (billingRowMine) {
			await db.delete(billingAccounts).where(eq(billingAccounts.userId, walkerId));
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

test("⭐ giving a Sticker lands the chip, closes the picker, and the count moves", async ({
	page,
	context,
}) => {
	await signInAsWalker(context);
	await page.goto(POST_PATH);

	const rows = await openPicker(page, "Anyone can read this");
	await rows.first().click();

	// The chip on the wall, reconciled from the refetch rather than left as an optimistic
	// guess — a count that drifted from its rows would look exactly like a count. Its
	// accessible name rides the art plus the count, read straight off that shape.
	const chip = page.getByRole("button", { name: "Small Butterfly 1" });
	await expect(chip).toBeVisible({ timeout: 5_000 });

	// The picker closed on its own once the give went through.
	await expect(pickerRows(page)).toHaveCount(0);

	// Reopening shows the refetched allowance: one $0.25 given, so the row's count is one
	// less than it was — the giver sees what their give moved.
	const fresh = await openPickerPlain(page, "Anyone can read this");
	await expect(fresh.first()).toContainText(`(${leftFor(0.25) - 1} left)`, { timeout: 5_000 });
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

test("⭐ the Work's picker opens at the trigger's right edge, with the same rows", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	await signInAsWalker(context);
	await page.goto(WORK_PATH);
	// Reviews is the side column's default tab; the click names it the way its role names it.
	await page.getByRole("tab", { name: "Reviews", exact: true }).click();

	// The Work mounts the same bar in its verdict row; only the alignment flips, because
	// the trigger sits at that row's right edge.
	const trigger = page
		.getByRole("group", { name: /Add a Sticker to/ })
		.or(page.getByLabel(/Add a Sticker to/));
	await expect(trigger.first()).toBeVisible();
	await trigger.first().click();
	await assertCountedRows(page);
	expect(errors).toEqual([]);
});
