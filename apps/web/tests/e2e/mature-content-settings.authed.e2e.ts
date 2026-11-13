// SPDX-License-Identifier: Apache-2.0
/**
 * The user's own controls over what they meet, walked in a browser.
 *
 * 🚨 **A preference with no surface is a preference nobody has**, which is the failure this
 * spec is shaped against. The API for both rungs' display settings and for the Adult opt-in
 * can be complete and green while nothing in the front end ever calls it — route tests
 * cannot see that gap, and neither can a signed-out page check, because every route renders
 * the marketing page when logged out and those assertions pass whether or not the UI exists.
 *
 * ⭐ **The card split into Rating Controls and Content Controls on 2026-11-06** (Parker):
 * the ratings are what a Work is, the flags are what it contains, and one long card made
 * the two look like the same kind of setting. Both cards are asserted here, because the
 * split is only real if both are findable.
 *
 * 🚨 **The Adult control is a normal Hide / Blur / Show now, locked until a payment method
 * exists to read.** The warning's one sentence names what the method is for, and the (i)
 * carries the honest explanation — that the check reads the card's funding TYPE, that
 * nothing is charged, and that a debit-only adult has no other route. That last sentence is
 * not optional: a page that hinted at an alternate path would promise something that has
 * deliberately not been built.
 *
 * ⚠️ **Nothing here turns the Adult rung on.** Enabling it reads Stripe and writes a
 * verification to shared fixture state that later tests depend on, so this asserts as far
 * as the locked control and its warning, and stops.
 */
import { expect, test } from "@playwright/test";

test("Rating Controls separates the two rungs, and Mature blurs by default", async ({ page }) => {
	await page.goto("/settings?tab=content");

	const ratings = page
		.locator(".card")
		.filter({ has: page.getByRole("heading", { name: "Rating Controls" }) });
	await expect(ratings, "no rating controls on the settings page").toBeVisible();

	// 🚨 The separation is the design rather than the layout: a user who wants difficult
	// work unblurred has said nothing about whether they want explicit work at all, so the
	// page has to name both rungs rather than offering one switch over "adult content".
	await expect(ratings).toContainText("Mature");
	await expect(ratings).toContainText("Adult");

	// Scoped to each rung's own group, because "Blur" and "Show" are ordinary enough words
	// to appear in a header or a footer, and every content flag below has the same three.
	const mature = ratings.getByRole("group", { name: "Mature", exact: true });
	await expect(mature.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
	await expect(mature.getByRole("button", { name: "Blur", exact: true })).toBeVisible();
	await expect(mature.getByRole("button", { name: "Show", exact: true })).toBeVisible();

	// The default that makes the rung mean something. `btn-primary` is how the section
	// marks the current choice, so this reads the state rather than the mere presence of a
	// control.
	await expect(mature.getByRole("button", { name: "Blur", exact: true })).toHaveClass(
		/btn-primary/,
	);

	// Adult is the same three-way control, and the fixture account has no verification, so
	// every button in it is locked.
	const adult = ratings.getByRole("group", { name: "Adult", exact: true });
	for (const label of ["Hide", "Blur", "Show"]) {
		await expect(adult.getByRole("button", { name: label, exact: true })).toBeDisabled();
	}
});

test("the Adult warning names both proofs, and the (i) explains the check", async ({ page }) => {
	await page.goto("/settings?tab=content");
	const ratings = page
		.locator(".card")
		.filter({ has: page.getByRole("heading", { name: "Rating Controls" }) });

	await expect(ratings).toContainText(
		"Save payment info in Account settings to unlock Adult content, or complete creator payouts.",
	);

	const info = ratings.getByRole("button", { name: "About age verification" });
	await expect(info).toBeVisible();
	await info.hover();

	// 🚨 The funding TYPE is the signal, and saying so is not optional. Debit and prepaid
	// cards have no age floor at all, so a page implying a payment proves age would be
	// describing a check Anthers does not perform.
	const explanation = page.getByRole("tooltip");
	await expect(explanation).toContainText(/credit card/i);
	await expect(explanation).toContainText(/payout onboarding/i);
	await expect(explanation).toContainText(/Nothing is charged/i);

	// ⚠️ And the exclusion is stated plainly rather than gestured past. The wiki's *Content
	// Standards*: it is real, it skews younger, lower-income and unbanked, and it is the
	// accepted price of refusing to verify everybody.
	await expect(explanation).toContainText(/Debit and prepaid cards/i);
	await expect(explanation).toContainText(/no other way to do this today/i);

	// Without a saved credit card or a creator payout standing, the whole card is locked
	// with the reason — the old "Turn on Adult content" button and its card dialog are gone.
	await expect(ratings.getByText(/Save payment info in Account settings/)).toBeVisible();
	await expect(ratings.getByRole("button", { name: /turn on adult content/i })).toHaveCount(0);

	// The reason links to the one settings surface that saves the proof, and that surface
	// now splits the two: the card lives at Stripe, the US billing address stays inline.
	await page.getByRole("link", { name: "Account settings" }).click();
	await expect(page.getByRole("heading", { name: "Save payment info" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add a card at Stripe" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add billing address" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Billing Address" })).toHaveCount(0);
});

test("Content Controls carries the flags as their own card", async ({ page }) => {
	await page.goto("/settings?tab=content");

	const controls = page
		.locator(".card")
		.filter({ has: page.getByRole("heading", { name: "Content Controls" }) });
	await expect(controls, "no content controls card").toBeVisible();

	// The rows are the shared rating vocabulary, not a hand-typed list.
	await expect(controls).toContainText("Hide or blur work that contains any of these");
	// The own-Work exemption is part of the setting's meaning, not a footnote a later copy
	// edit may drop: the server keeps a creator's own Works out of the filter, and the
	// browser must not veil them either.
	await expect(controls).toContainText(
		"If you're a creator, this won't apply to how you see your own works around the site.",
	);

	// Scoped to one flag's group: the page has several rows, all with the same three words.
	const violence = controls.getByRole("group", { name: "Violence", exact: true });
	await expect(violence.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
	await expect(violence.getByRole("button", { name: "Blur", exact: true })).toBeVisible();
	await expect(violence.getByRole("button", { name: "Show", exact: true })).toBeVisible();
});
