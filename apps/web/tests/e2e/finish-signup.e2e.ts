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
 * 🚨 **And that this page is not a second signup door.** the *Making an Account* page's rule is a prohibition on a
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
		// that offered to start one instead would be the second door the wiki's *Making an Account* forbids.
		await page.goto("/finish");

		await expect(page).toHaveURL(/\/subscribe$/);
		await expect(page.getByRole("heading", { name: /anthers is free/i })).toBeVisible();
	});

	test("it offers no way to start a signup of its own", async ({ page }) => {
		await startSignup(page);

		// ⚠️ **Wait for something only `/finish` draws before counting anything.** `toHaveURL`
		// resolves the instant a client-side route changes, which is before React has
		// unmounted `/subscribe` — and `.count()` is a one-shot read with no retry behind it,
		// unlike a web-first assertion. So for a moment both pages' inputs are in the
		// document and the count is the sum of them, which is how this failed with two email
		// fields on a page that has one. The rail is the cheapest tell that the swap is done.
		await expect(page.getByRole("list", { name: "Signup Progress" })).toBeVisible();

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

/**
 * The address Bluesky gave us, in the field.
 *
 * 🚨 **This is the assertion whose absence let a real defect reach Parker twice.** The server
 * chain was faultless — the PDS returned the address, `bindIdentityToPending` wrote it, and
 * `GET /signup/pending` served it — and the page still asked him to type it, because it chose
 * its state on whether an address was *known* rather than whether one had been *posted to*.
 * `finish-face.test.ts` pins that decision as a pure function; nothing pinned that the value
 * reaches the input.
 *
 * ⚠️ **The pending record is stubbed, and it has to be.** Reaching this state for real needs a
 * completed OAuth round trip against bsky.social, which no test may perform — so the response
 * is faked at the network boundary and what is asserted is everything downstream of it, which
 * is exactly where the bug was.
 */
test.describe("an address the PDS handed us", () => {
	const PENDING = {
		email: "someone@example.com",
		codeSent: false,
		addressProved: false,
		atprotoHandle: "someone.bsky.social",
		picks: { anthers: 0, follow: [], seed: [] },
		next: "",
	};

	async function stubPending(page: Page, pending: Record<string, unknown>) {
		await page.route("**/api/auth/signup/pending", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ pending, atprotoSignupEnabled: true }),
			});
		});
	}

	test("arrives already in the field, rather than asking for it again", async ({ page }) => {
		await stubPending(page, PENDING);
		await page.goto("/finish");

		const field = page.locator('input[type="email"]');
		await expect(field).toBeVisible();
		await expect(
			field,
			"the whole value of asking Bluesky for the address is not typing it twice",
		).toHaveValue("someone@example.com");
	});

	test("says whose signup it is, and where the address came from", async ({ page }) => {
		await stubPending(page, PENDING);
		await page.goto("/finish");

		await expect(page.getByText(/@someone\.bsky\.social/)).toBeVisible();
		// ⚠️ An address appearing in a field by itself, on a page reached by authorizing
		// somewhere else, reads as something the site already knew rather than something it
		// was handed. The label is what makes it legible.
		await expect(page.getByText(/is this the right address/i)).toBeVisible();
	});

	test("does not claim to have sent a code it never sent", async ({ page }) => {
		await stubPending(page, PENDING);
		await page.goto("/finish");

		// 🚨 The regression itself. `begin` runs before the Bluesky round trip and has nothing
		// to send to; the PDS supplies the address at the callback, which sends nothing.
		await expect(page.getByText(/we sent a six-character code/i)).toHaveCount(0);
		await expect(page.locator('input[aria-label^="Code character"]')).toHaveCount(0);
	});

	test("shows the code box once one really has gone out", async ({ page }) => {
		await stubPending(page, { ...PENDING, codeSent: true });
		await page.goto("/finish");

		await expect(page.locator('input[aria-label^="Code character"]')).toHaveCount(6);
		await expect(page.getByText(/we sent a six-character code/i)).toBeVisible();
	});
});
