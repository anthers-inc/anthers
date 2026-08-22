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
import type { Locator } from "@playwright/test";
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

test.describe("/subscribe leads with the free door", () => {
	test("the signup control comes before either support ask", async ({ page }) => {
		await page.goto("/subscribe");

		const signup = page.locator('[data-signup="top"]');
		await expect(signup).toBeVisible();

		// The two optional sections. Both must sit BELOW the way in, so that scrolling is
		// what it takes to be asked for money — never what it takes to join.
		const creatorAsk = page.getByRole("heading", { name: /^support a creator$/i });
		const anthersAsk = page.getByRole("heading", { name: /^support anthers$/i });

		const signupTop = await topOf(signup);
		expect(signupTop).toBeLessThan(await topOf(creatorAsk));
		expect(signupTop).toBeLessThan(await topOf(anthersAsk));
	});

	test("what free includes is stated above the signup control, limit and all", async ({ page }) => {
		await page.goto("/subscribe");

		// 🚨 63.01: "free forever" and the monthly cap are co-present, on the same rule as
		// "no cut" and the take-home. A reader who meets the promise without the bound beside
		// it hears "unlimited", and then meets the limit as a surprise after signing up.
		const forever = page.getByRole("heading", { name: /free\. forever/i });
		const limit = page.getByText(/hours of Public Access a month/i).first();
		await expect(forever).toBeVisible();
		await expect(limit).toBeVisible();

		const limitTop = await topOf(limit);
		expect(limitTop).toBeGreaterThan(await topOf(forever));
		expect(limitTop).toBeLessThan(await topOf(page.locator('[data-signup="top"]')));
	});

	test("declining Anthers is offered as an answer, not as a lapse", async ({ page }) => {
		await page.goto("/subscribe");

		// The refusal has its own button and its own words. A section where the only control
		// is "yes" is a section that has stopped asking.
		await expect(page.getByRole("button", { name: /hours suit me/i })).toBeVisible();
		await expect(page.getByText(/only if you want to/i)).toBeVisible();
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
