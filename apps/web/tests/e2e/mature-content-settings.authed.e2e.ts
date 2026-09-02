// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The reader's own controls over what they meet, walked in a browser.
 *
 * 🚨 **A preference with no surface is a preference nobody has**, which is the failure this
 * spec is shaped against and the same one `data-rights.authed.e2e.ts` was written for. The
 * API for both rungs' display settings and for the Adult opt-in can be complete and green
 * while nothing in the front end ever calls it — route tests cannot see that gap, and
 * neither can a signed-out page check, because every route on this app renders the same
 * marketing page when logged out and those assertions pass whether or not the UI exists.
 *
 * ⭐ **The copy is asserted, not just the controls.** Two sentences here are load-bearing and
 * both are easy to soften into something false: that the check reads the card's *funding
 * type* rather than the fact of paying, and that an adult whose only card is debit cannot
 * get in and nothing routes around it. A settings page that implied paying proves your age
 * would be a false claim about how Anthers checks, and one that gestured at an alternate
 * path would be promising something that does not exist.
 *
 * ⚠️ **Nothing here turns the Adult rung on.** Enabling it reads Stripe and writes a
 * verification to shared fixture state that later rungs depend on, so this asserts as far as
 * the door — which is the part that was missing — and stops.
 */
import { expect, test } from "@playwright/test";

test("the two rungs have separate controls, and Mature blurs by default", async ({ page }) => {
	await page.goto("/settings");

	const section = page.locator(".card").filter({ hasText: "What you meet before you choose" });
	await expect(section, "no mature-content controls on the settings page").toBeVisible();

	// 🚨 The separation is the design rather than the layout: a reader who wants difficult
	// work unblurred has said nothing about whether they want explicit work at all, so the
	// page has to name both rungs rather than offering one switch over "adult content".
	await expect(section).toContainText("Mature");
	await expect(section).toContainText("Adult");

	// Scoped to the section, because "Blur" and "Show" are ordinary enough words to appear
	// in a header or a footer and a page-wide match would test neither.
	await expect(section.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
	await expect(section.getByRole("button", { name: "Blur", exact: true })).toBeVisible();
	await expect(section.getByRole("button", { name: "Show", exact: true })).toBeVisible();

	// The default that makes the rung mean something. `btn-primary` is how the section
	// marks the current choice, so this reads the state rather than the mere presence of a
	// control.
	await expect(section.getByRole("button", { name: "Blur", exact: true })).toHaveClass(
		/btn-primary/,
	);
});

test("the page says what the age check actually reads, and what it excludes", async ({ page }) => {
	await page.goto("/settings");
	const section = page.locator(".card").filter({ hasText: "What you meet before you choose" });

	// 🚨 Paying is not the check, and saying so is not optional. Debit and prepaid cards
	// have no age floor at all, so a page implying a payment proves age would be describing
	// a check Anthers does not perform.
	await expect(section).toContainText(/credit/i);
	await expect(section).toContainText(/Paying for something is not the check/i);

	// ⚠️ And the exclusion is stated plainly rather than gestured past. The wiki's *Content Standards*: it is
	// real, it skews younger, lower-income and unbanked, and it is the accepted price of
	// refusing to verify everybody. A page that hinted at an alternate route would be
	// promising something that has deliberately not been built.
	await expect(section).toContainText(/we do not have another way to do it/i);

	// The door exists and is off by default.
	await expect(section.getByRole("button", { name: /turn adult content on/i })).toBeVisible();
});
