// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The page that finishes a signup (`/finish`).
 *
 * 🚨 **Its whole reason for existing is legibility, so legibility is what this spec pins.**
 * Parker walked the Bluesky signup on 2026-08-25 and could not tell whether it had worked:
 * `/subscribe` sent him to bsky.social, brought him back to `/subscribe`, and apparently
 * asked him to sign up again. Coming back to finish is the design — an address a PDS calls
 * confirmed is somebody else's assertion, and a code we sent is ours — but nothing said so.
 * What is asserted below is that a person can now *see* where they are: a rail naming the
 * steps, the choices they made read back, and one thing to do.
 *
 * 🚨 **And that this page is not a second signup door.** 40.10's rule is a prohibition on a
 * second place in the UI that mints accounts, so a page reachable only by already having a
 * pending signup is a continuation of the one door rather than a rival to it. That is a
 * property of a guard, and a guard nothing exercises is a guard nobody will notice going.
 *
 * ⚠️ **What this spec cannot assert, and why.** It cannot complete a verification: the
 * emailed code is argon2-hashed at rest, there is deliberately no way to read it back out of
 * the database, and a test-only endpoint that handed back the live code for an address is
 * precisely the thing that must not exist. So the far side — code accepted, session issued,
 * payment, `/welcome` — is `pending-signup.test.ts`'s server-side, and by hand against a
 * live API. Everything on the near side of it is here.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** An address that cannot collide with a real account or another run. */
const addr = () => `e2e-finish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

const topSignup = (page: Page) => page.locator('[data-signup="top"]');

/**
 * A rung on the Anthers ladder, as the clickable card rather than the input inside it.
 *
 * ⚠️ The input is `sr-only` so the card can be styled, which puts it out of reach of
 * `.check()`'s actionability wait — the label is the click target. Named by the RADIO it
 * contains rather than by its own text, because the text begins with an `aria-hidden` Badge
 * emoji that `hasText` very much sees.
 */
const rung = (page: Page, name: RegExp) =>
	page.locator("#anthers-badges label").filter({ has: page.getByRole("radio", { name }) });

/** Start a signup at the one door and land where it takes you. */
async function startSignup(page: Page, picks?: () => Promise<void>) {
	await page.goto("/subscribe");
	if (picks) await picks();
	await topSignup(page).locator('input[type="email"]').fill(addr());
	await topSignup(page)
		.getByRole("button", { name: /create my (free )?account/i })
		.click();
	await expect(page).toHaveURL(/\/finish$/);
}

test.describe("it cannot be an entry point", () => {
	test("a visitor with no signup in progress is sent to the one door", async ({ page }) => {
		// 🚨 The guard, exercised. The pending signup is read from an httpOnly cookie the
		// browser cannot forge, so arriving here by typing the URL finds nothing — and a page
		// that offered to start one instead would be the second door 40.10 forbids.
		await page.goto("/finish");

		await expect(page).toHaveURL(/\/subscribe$/);
		await expect(page.getByRole("heading", { name: /anthers is free/i })).toBeVisible();
	});

	test("it offers no way to start a signup of its own", async ({ page }) => {
		await startSignup(page);

		// The same structural tell the one-door spec uses: this page asks for no password at
		// all, and a Create Account card growing back here would be invisible otherwise.
		expect(await page.locator('input[type="password"]').count()).toBe(0);
		// One address field, the one it is confirming — not a form that could mint a second.
		expect(await page.locator('input[type="email"]').count()).toBeLessThanOrEqual(1);
	});
});

test.describe("a person can see where they are", () => {
	test("the rail names the steps, and the last of them is on the next page", async ({ page }) => {
		await startSignup(page);

		// ⚠️ Scoped by the rail's accessible name rather than by `listitem` alone: this site
		// is full of lists, and an unscoped filter reports a strict-mode violation where it
		// means to report a missing step.
		const steps = page.getByRole("list", { name: "Signup Progress" });
		await expect(steps.getByText("Your Email", { exact: true })).toBeVisible();
		// ⭐ **`/welcome`'s step is drawn here.** The two pages are separate routes because
		// `/welcome` has a job that has nothing to do with signing up — it is where any
		// signed-in account still owing a handle is sent, from anywhere — and sharing the rail
		// is what makes them read as one flow anyway.
		await expect(steps.getByText("Your Username", { exact: true })).toBeVisible();
	});

	test("the choices made a moment ago are read back, not left behind", async ({ page }) => {
		await startSignup(page, async () => {
			await rung(page, /^blossom/i).click();
			await expect(page.getByRole("radio", { name: /^blossom/i })).toBeChecked();
		});

		// 🚨 **The other half of getting somebody off `/subscribe`.** Their choices are no
		// longer in front of them, so a page that asked for a code while saying nothing about
		// what it was for would trade one kind of disorientation for another. $12 rather than
		// the entry price, because Root cannot catch a substitution — the amount a reader
		// chose and the amount a buggy page would substitute are the same $3 there.
		await expect(page.getByText("What you chose")).toBeVisible();
		await expect(page.getByText("$12").first()).toBeVisible();
	});

	test("choosing nothing is shown as the complete answer it is", async ({ page }) => {
		await startSignup(page);

		// ⚠️ Support for Anthers must never read as the price of admission — a product
		// position rather than a copy preference, and the last page of the funnel is where it
		// would be easiest to lose.
		await expect(page.getByText(/complete answer/i)).toBeVisible();
	});
});

test.describe("starting over", () => {
	test("abandoning drops the signup rather than leaving it to expire", async ({ page }) => {
		await startSignup(page);
		await page.getByRole("button", { name: /start over/i }).click();
		await expect(page).toHaveURL(/\/subscribe$/);

		// The row went with the cookie, so coming back finds nothing — an unfinished signup
		// nobody is claiming is a row waiting to expire, and this is somebody saying so.
		await page.goto("/finish");
		await expect(page).toHaveURL(/\/subscribe$/);
	});
});
