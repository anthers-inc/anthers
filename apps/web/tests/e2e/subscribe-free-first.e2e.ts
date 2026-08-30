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

import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
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

		// 🚨 63.01: "free forever" and the cap are co-present, on the same rule as "no cut"
		// and the take-home. A reader who meets the promise without the bound beside it
		// hears "unlimited", and then meets the limit as a surprise after signing up.
		//
		// ⚠️ **What is pinned is that a BOUND is stated before the reader signs up — not the
		// wording of it, and not the period.** 63.01's requirement is a co-present limit;
		// what "forever" denies is an expiry, not that the free tier has edges. Naming the
		// period is preferred where it fits, and the top label does name it ("hrs/mo"), but
		// a spec that demanded the period would be enforcing the guide's example sentence
		// rather than its rule.
		//
		// 🚨 Matching the bound however it is spelled makes **the position assertions below
		// the whole test.** A looser regex on its own would find the closing summary and
		// pass while the top of the page said nothing about a limit at all — `.first()`
		// plus the ordering is what closes that, so neither may be dropped.
		//
		// ⚠️ **The unit alternation has to grow when a new abbreviation lands, and it will
		// fail loudly rather than quietly when it doesn't.** The page has said "hours/month
		// of Public Access", "hours of Public Access", and now "hrs/mo of Public Access" in
		// the space of a week; each time, a regex naming only the old form stopped matching
		// the top of the page, fell through to the closing summary, and failed on position —
		// which reads as a layout regression rather than a copy edit. If this churns again,
		// the fix is a `data-` hook on the element rather than a longer alternation.
		//
		// The NUMBER is never typed: it comes from the constant the page renders.
		const forever = page.getByRole("heading", { name: /free\. forever/i });
		const limit = page
			.getByText(
				new RegExp(
					`${FREE_PUBLIC_ACCESS_HOURS}\\s*(hours?|hrs)(/(month|mo))? of Public Access`,
					"i",
				),
			)
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

	test("choosing a rung moves nothing on the page, above it or below it", async ({ page }) => {
		// 🚨 **Parker has reported this three times, so what is pinned is the whole page and
		// not one section of it.** The panels that change with the rung — the perk cards, the
		// breakdown's legend and note, the echo — are held open by invisible sizers, and the
		// section's own height is the assertion that used to stand here alone. It passed
		// through the third report: the section really was holding, while the hero's note
		// above it wrapped to a second line at any paid rung and the closing summary below it
		// grew a whole row, so the matrix slid 19px under the pointer that had just pressed
		// it and the document grew 93px. The bees in `MeadowVines` are placed at a percentage
		// of page height, which is why a change anywhere on the page moves the backdrop
		// everywhere on it.
		//
		// ⚠️ **So measure the three things a reader can actually see move**, and keep the
		// section height among them — it is the one that says *where* a regression is rather
		// than only that there is one.
		//
		// ⚠️ **Two widths, because the first fix passed at 1440 and was wrong at 390.** The
		// copy for two rungs can wrap to the same number of lines at one width and to
		// different numbers at another, so a single-viewport assertion here proves almost
		// nothing. 390 is the narrow case where the labels wrap hardest, and it is also where
		// two *paid* rungs diverged from each other: "Sprout" wraps the summary's row a line
		// further than "Root" does.
		for (const width of [390, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/subscribe");

			const section = page.locator("#anthers-badges");
			await expect(section).toBeVisible();

			// 🚨 **Wait for the page to finish arriving before measuring any of it.** Two
			// surfaces here fill in from the API after first paint: the signup card grows its
			// Bluesky tab once `GET /api/atproto/config` answers, and the creator finder swaps
			// its skeletons for real cards. Either one landing between two readings is ~300px
			// of movement that has nothing to do with the rung — which is how this test first
			// failed, on its own warm-up rather than on the thing it is about. Both are above
			// the ladder, so both move it.
			await expect(
				page.locator('[data-signup="top"]').getByRole("tab", { name: "Bluesky", exact: true }),
			).toBeVisible();
			await expect(page.locator("#creator-badges .animate-pulse")).toHaveCount(0);

			const readings: string[] = [];
			for (const name of [/^free/i, /^root/i, /^sprout/i, /^petal/i, /^blossom/i]) {
				await rung(page, name).click();
				await expect(page.getByRole("radio", { name })).toBeChecked();
				// 🚨 **`offsetTop`/`offsetHeight`, never `boundingBox()` or a rect.** Both of
				// the obvious measurements are wrong here for different reasons. A rect is
				// viewport-relative, and clicking a rung scrolls it into view, so two readings
				// are taken from two scroll positions. And a rect includes TRANSFORMS: every
				// section on this page is a `Reveal`, which holds it at `translateY(1rem)`
				// until it has scrolled into view — so a section that had not yet animated
				// measured exactly 16px lower than the same section a moment later, and the
				// test reported layout movement that was really the fade-up finishing. The
				// offset chain is layout, which is the thing being asserted.
				readings.push(
					await section.evaluate((el) => {
						let top = 0;
						for (
							let node = el as HTMLElement | null;
							node;
							node = node.offsetParent as HTMLElement | null
						)
							top += node.offsetTop;
						// Its top, not only its height: a section that keeps its size and slides
						// down the page has still moved out from under the reader's finger.
						return `page ${document.documentElement.scrollHeight} · ladder top ${top} · ladder height ${(el as HTMLElement).offsetHeight}`;
					}),
				);
			}

			// Rounded to the pixel rather than compared with a tolerance: a tolerance is a
			// budget for the next 19px of drift, and there is no honest reason for any.
			expect(new Set(readings).size, `at ${width}px:\n  ${readings.join("\n  ")}`).toBe(1);
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
		// sets `border-color` on ALL FOUR sides, so the later class wiped the color the row
		// rule depended on. The label column had no such class, which is why the lines
		// appeared under the descriptions and stopped dead where the figures began.
		//
		// ⚠️ **Nothing else could have caught this.** The markup was right, the classes were
		// all present, every layout assertion passed, and the DOM says `border-top-width: 1px`
		// either way. The only thing that knows is the computed color.
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
		const invisible = (color: string) => /,\s*0\s*\)$/.test(color) || color === "transparent";
		expect(invisible(paint.top), `row rule is invisible: ${paint.top}`).toBe(false);
		expect(invisible(paint.right), `column rule is invisible: ${paint.right}`).toBe(false);
		// And the card has a surface of its own, so the figures do not sit on the page.
		expect(invisible(paint.background), `matrix has no surface: ${paint.background}`).toBe(false);

		// 🚨 **The outer edge is heavier than the rules inside it, and the table is raised.**
		// The cells were lightened to separate them from the chrome, which also moved them
		// closer to the page — and a card whose fill nearly matches its surroundings is held
		// together by its edge alone (Parker, 2026-08-25). Both halves are asserted because
		// either one alone leaves the table reading as loose text on the background.
		const edge = await page
			.locator("#anthers-badges tbody tr:last-child td:last-child")
			.evaluate((el) => ({
				right: Number.parseFloat(getComputedStyle(el).borderRightWidth),
				bottom: Number.parseFloat(getComputedStyle(el).borderBottomWidth),
			}));
		const interior = Number.parseFloat(
			await cell.evaluate((el) => getComputedStyle(el).borderRightWidth),
		);
		expect(edge.right, "the card's right edge is no heavier than an interior rule").toBeGreaterThan(
			interior,
		);
		expect(
			edge.bottom,
			"the card's bottom edge is no heavier than an interior rule",
		).toBeGreaterThan(interior);

		// A `drop-shadow` filter, not a `box-shadow`: the tabs stand proud of the body with
		// gaps between them, so a rectangle would not trace this control.
		const filter = await page
			.locator("#anthers-badges table")
			.evaluate((el) => getComputedStyle(el).filter);
		expect(filter, `the matrix casts no shadow: ${filter}`).toContain("drop-shadow");
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
