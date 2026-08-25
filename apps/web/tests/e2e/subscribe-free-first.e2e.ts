// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `/subscribe` opens with the door, not with the ask.
 *
 * 🚨 **This is a product position, not a layout preference, which is why it gets a test.**
 * Parker's instruction (2026-08-22): joining must never read as something you pay for, and
 * supporting Anthers must never read as the price of admission. Somebody served entirely by
 * buying from creators, backing them directly, and the free hours is using Anthers exactly
 * as intended — the page must not nudge them out of it.
 *
 * A layout can drift back a section at a time without anything looking wrong, and the
 * failure would be silent: a signup page that has quietly become a pricing page still
 * renders, still converts somebody, and still passes every other spec. So what is pinned
 * here is **order and co-presence** rather than appearance.
 *
 * ⚠️ Deliberately not pinned: the wording of any of it. Copy is 63.01's to govern and it
 * moves; a spec that asserted sentences would fail on every edit and teach people to weaken
 * it. The exception is the free limit, which is pinned because 63.01 requires it to be
 * *co-present* with "free forever" — that is a rule about structure, and structure is what
 * this file is for.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Where an element's top edge sits, for order assertions.
 *
 * Position rather than DOM order, because DOM order is not what a reader experiences — a
 * section moved visually by CSS would satisfy `:has()` checks and still put the ask first.
 */
async function topOf(locator: Locator): Promise<number> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("element is not visible, so it has no position to compare");
	return box.y;
}

/**
 * A rung on the Anthers ladder, as the clickable card rather than the input inside it.
 *
 * ⚠️ **Filtered by the RADIO's accessible name, never by the label's text.** Two traps
 * meet here. The input is `sr-only` so the card can be styled, which puts it out of reach
 * of `.check()`'s actionability wait — so the label is the thing to click. And a paid
 * rung's label *text* begins with its Badge emoji, which is `aria-hidden` (so it stays out
 * of the accessible name) and is still very much part of `hasText`: an earlier
 * `hasText: /^Root/` passed until the Badge art landed and then matched nothing, because
 * the text had quietly become "🫚Root$3/mo". Naming the radio sidesteps both.
 */
const rung = (page: Page, name: RegExp) =>
	page.locator("#anthers-badges label").filter({ has: page.getByRole("radio", { name }) });

/** Whether the DOCUMENT scrolls sideways — never acceptable, at any width. */
const scrollsSideways = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe("/subscribe leads with the free door", () => {
	test("the signup control comes before either support ask", async ({ page }) => {
		await page.goto("/subscribe");

		const signup = page.locator('[data-signup="top"]');
		await expect(signup).toBeVisible();

		// The two optional sections. Both must sit BELOW the way in, so that scrolling is
		// what it takes to be asked for money — never what it takes to join.
		//
		// ⚠️ Matched on "Badges" rather than on the full heading, which was "Support a
		// creator" / "Support Anthers" until 2026-08-24 and is free to move again. What
		// this test is about is ORDER; anchoring the exact wording would make it fail for
		// copy edits it has no opinion on.
		const creatorAsk = page.getByRole("heading", { name: /creator badges/i });
		const anthersAsk = page.getByRole("heading", { name: /anthers badges/i });

		const signupTop = await topOf(signup);
		expect(signupTop).toBeLessThan(await topOf(creatorAsk));
		expect(signupTop).toBeLessThan(await topOf(anthersAsk));
	});

	test("what free includes is stated above the signup control, limit and all", async ({ page }) => {
		await page.goto("/subscribe");

		// 🚨 63.01: "free forever" and the monthly cap are co-present, on the same rule as
		// "no cut" and the take-home. A reader who meets the promise without the bound beside
		// it hears "unlimited", and then meets the limit as a surprise after signing up.
		//
		// ⚠️ **Both house phrasings are matched, because what is pinned is the co-presence
		// of a PERIOD with the hours — not one wording of it.** The page says "10 hours/month
		// of Public Access" at the top and "10 hours of Public Access a month" in the closing
		// summary; a regex naming only one of them would pass by finding the wrong element,
		// which is worse than failing, since the position assertion below is the whole test.
		const forever = page.getByRole("heading", { name: /free\. forever/i });
		const limit = page
			.getByText(/hours\/month of Public Access|hours of Public Access a month/i)
			.first();
		await expect(forever).toBeVisible();
		await expect(limit).toBeVisible();

		const limitTop = await topOf(limit);
		expect(limitTop).toBeGreaterThan(await topOf(forever));
		expect(limitTop).toBeLessThan(await topOf(page.locator('[data-signup="top"]')));
	});

	test("staying free is a rung on the ladder, not the absence of one", async ({ page }) => {
		await page.goto("/subscribe");

		// 🚨 **The property, restated for the ladder that replaced the yes/no card on
		// 2026-08-24.** It used to be "the refusal has its own button and its own words";
		// now it is that Free sits *inside* the same control as the paid rungs, priced like
		// them and selectable like them. A ladder that started at Root would make declining
		// the absence of a choice, which is the thing this file exists to prevent.
		const free = page.getByRole("radio", { name: /^free/i });
		await expect(free).toBeVisible();

		// 🚨 **Checked before anything is pressed** (Parker, 2026-08-25). The ladder opened
		// with nothing selected until then, which left its default state showing none of its
		// five options — and made the assertion below meaningless, since clicking Free first
		// and then checking it passes whatever the default was. Free is where an account with
		// no support for Anthers already sits, so it is what the control should show.
		await expect(free).toBeChecked();
		await expect(page.getByText(/staying free/i)).toBeVisible();

		// And choosing it is still a real answer the page acts on, rather than decoration.
		// See `rung` for why the label is the click target and why it is named by its radio.
		await rung(page, /^root/i).click();
		await expect(free).not.toBeChecked();
		await rung(page, /^free/i).click();
		await expect(free).toBeChecked();
		await expect(page.getByText(/staying free/i)).toBeVisible();

		// It is also first, so nobody has to scan a price list to find out they can decline.
		const rungs = await page.getByRole("radio").all();
		await expect(rungs[0]).toHaveAccessibleName(/^free/i);
	});

	test("the ladder is the same height at every rung, so choosing does not move the page", async ({
		page,
	}) => {
		// 🚨 **Parker reported this twice, so it gets pinned.** The section's panels change
		// with the rung — the perk cards, the breakdown's legend and note, the echo — and
		// copy of different lengths made the section grow and shrink under the control that
		// changed it. The page's background art is positioned against page height, so the
		// whole backdrop shifts with it. A control whose job is comparison must not resize
		// the thing it sits in when you use it.
		//
		// ⚠️ **Two widths, because the first fix passed at 1440 and was wrong at 390.** The
		// copy for two rungs can wrap to the same number of lines at one width and to
		// different numbers at another, so a single-viewport assertion here proves almost
		// nothing. 390 is the narrow case where the labels wrap hardest.
		for (const width of [390, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/subscribe");

			const section = page.locator("#anthers-badges");
			await expect(section).toBeVisible();

			const heights: number[] = [];
			for (const name of [/^free/i, /^root/i, /^sprout/i, /^petal/i, /^blossom/i]) {
				await rung(page, name).click();
				await expect(page.getByRole("radio", { name })).toBeChecked();
				const box = await section.boundingBox();
				if (!box) throw new Error("the ladder section has no box to measure");
				heights.push(Math.round(box.height));
			}

			// Rounded to the pixel rather than compared with a tolerance: a tolerance is a
			// budget for the next 19px of drift, and there is no honest reason for any.
			expect(new Set(heights).size, `heights at ${width}px: ${heights.join(", ")}`).toBe(1);
		}
	});

	test("the matrix gives way to cards rather than to a sideways scroll", async ({ page }) => {
		// 🚨 **The rule (Parker, 2026-08-24): keep the matrix as long as it works, and swap
		// when it stops.** Below `MATRIX_QUERY` five columns do not fit, and a matrix you have
		// to scroll to compare two rungs is a worse list than a list. What is pinned here is
		// that the swap happens *instead of* a scroll, in both directions — a matrix that
		// silently started scrolling again, or a phone that got the table anyway, is the same
		// defect wearing either face.
		//
		// ⚠️ **The page must never be the thing that scrolls, at any width.** It was, at
		// first, for a reason no amount of staring at the flex chain would have found: each
		// rung's radio is `sr-only`, so `position: absolute`, and an absolutely positioned box
		// is clipped by an ancestor's `overflow` only when its containing block sits inside
		// that ancestor. Five 1px inputs pushed the document to 710px on a 390px screen.
		const phone = { width: 390, height: 844 };
		const desk = { width: 1280, height: 900 };

		await page.setViewportSize(phone);
		await page.goto("/subscribe");
		const section = page.locator("#anthers-badges");
		await expect(section).toBeVisible();
		await expect(section.locator("table")).toHaveCount(0);
		// The cards are a real list of every rung, not a truncation of one.
		await expect(section.getByRole("radio")).toHaveCount(5);
		expect(await scrollsSideways(page)).toBe(false);

		await page.setViewportSize(desk);
		await page.goto("/subscribe");
		await expect(section.locator("table")).toHaveCount(1);
		await expect(section.getByRole("radio")).toHaveCount(5);
		expect(await scrollsSideways(page)).toBe(false);

		// And the matrix is not quietly scrolling inside its own box either, which is the
		// state the breakpoint exists to prevent rather than to tidy up after.
		const scroller = section.locator(".overflow-x-auto");
		const [scrollWidth, clientWidth] = await scroller.evaluate((el) => [
			el.scrollWidth,
			el.clientWidth,
		]);
		expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
	});

	test("the matrix actually draws its grid, rather than declaring it and painting it away", async ({
		page,
	}) => {
		// 🚨 **The rules were declared and then painted transparent, and it shipped.** The
		// value cells carried `border-t border-base-content/10` for the row rule and
		// `border-x border-transparent` to reserve the column edge — and `border-transparent`
		// sets `border-color` on ALL FOUR sides, so the later class wiped the colour the row
		// rule depended on. The label column had no such class, which is why the lines
		// appeared under the descriptions and stopped dead where the figures began.
		//
		// ⚠️ **Nothing else could have caught this.** The markup was right, the classes were
		// all present, every layout assertion passed, and the DOM says `border-top-width: 1px`
		// either way. The only thing that knows is the computed colour.
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto("/subscribe");

		const cell = page.locator("#anthers-badges tbody td").first();
		await expect(cell).toBeVisible();

		const paint = await cell.evaluate((el) => {
			const style = getComputedStyle(el);
			return {
				top: style.borderTopColor,
				right: style.borderRightColor,
				background: style.backgroundColor,
			};
		});

		// `rgba(…, 0)` is the tell — a border that is there, sized, and invisible.
		const invisible = (colour: string) => /,\s*0\s*\)$/.test(colour) || colour === "transparent";
		expect(invisible(paint.top), `row rule is invisible: ${paint.top}`).toBe(false);
		expect(invisible(paint.right), `column rule is invisible: ${paint.right}`).toBe(false);
		// And the card has a surface of its own, so the figures do not sit on the page.
		expect(invisible(paint.background), `matrix has no surface: ${paint.background}`).toBe(false);
	});

	test("the two signup controls agree, because they are one form", async ({ page }) => {
		await page.goto("/subscribe");

		// Typing at the top fills the bottom. They read the same state deliberately: two
		// fields that disagreed would let somebody submit an address they had corrected.
		await page.locator('[data-signup="top"] input[type="email"]').fill("someone@example.com");
		await expect(page.locator('[data-signup="summary"] input[type="email"]')).toHaveValue(
			"someone@example.com",
		);
	});
});

test.describe("the way in is named as free", () => {
	test("the navbar button says so, and Log In sits after it", async ({ page }) => {
		await page.goto("/");

		const signUp = page.getByRole("link", { name: /sign up free/i }).first();
		const logIn = page.getByRole("banner").getByRole("link", { name: /^log in$/i });
		await expect(signUp).toBeVisible();
		await expect(signUp).toHaveAttribute("href", "/subscribe");

		// Reading order and visual weight should agree: the primary act first.
		const signUpBox = await signUp.boundingBox();
		const logInBox = await logIn.boundingBox();
		if (!signUpBox || !logInBox) throw new Error("both header links should be visible");
		expect(signUpBox.x).toBeLessThan(logInBox.x);
	});
});
