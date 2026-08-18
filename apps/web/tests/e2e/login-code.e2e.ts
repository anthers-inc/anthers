// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signing in from `/login` with the password field left empty.
 *
 * An account may hold no password at all — the signup ceremony makes one optional — and
 * until 2026-08-18 this page could not admit those accounts: it pointed them at
 * `/subscribe` in a footnote, which is the signup door wearing a sign-in hat. Submitting
 * with the box empty now mails a code and opens the same six-box field `/subscribe` uses.
 *
 * ⚠️ **What this spec cannot assert, and why.** It cannot complete a sign-in, for the same
 * reason `subscribe-ceremony.e2e.ts` cannot complete a signup: the emailed code is
 * argon2-hashed at rest and the only plaintext copy goes to the API's stdout, which
 * Playwright's `webServer` owns. A test-only endpoint that handed the live code back for an
 * address is precisely the thing that must not exist.
 *
 * It also cannot assert the load-bearing property — that this door **never creates an
 * account** — because there is deliberately no way to ask the API whether an address is
 * registered. That one is pinned server-side, in `signup-ceremony.test.ts`
 * (*"a valid code for an address with no account creates NOTHING"*), and it is the
 * assertion to protect: a `/login` that minted accounts would be the second signup door the
 * 2026-08-17 consolidation removed, and it would look perfectly correct from this page.
 *
 * So what is pinned here is the browser half: the field is genuinely optional (a `required`
 * attribute would make the whole path unreachable and nothing else would look wrong), the
 * page says what the button is about to do, a handle is not mistaken for an address, and a
 * refused code signs nobody in.
 */
import { expect, test } from "./fixtures";

/** An address that cannot collide with a real account or another run. */
const addr = () => `e2e-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

test.describe("signing in with an emailed code", () => {
	test("the password field is optional, and says what leaving it empty does", async ({ page }) => {
		await page.goto("/login");

		const box = page.locator('input[type="password"]');
		await expect(box).toHaveCount(1);
		// 🚨 The whole path hangs off this attribute's absence. With `required` the browser
		// refuses to submit and the code branch is unreachable — no error, no failing
		// assertion anywhere else, just a button that appears to do nothing.
		await expect(box).not.toHaveAttribute("required", /.*/);

		await expect(page.getByText(/leave it empty/i)).toBeVisible();
	});

	test("the button follows the field, so nobody is surprised by an email", async ({ page }) => {
		await page.goto("/login");

		// Empty password: pressing this sends a code, and it says so. Being told to check
		// your email after pressing "Log In" is the surprise this avoids.
		await expect(page.getByRole("button", { name: /email me a sign-in code/i })).toBeVisible();

		await page.locator('input[type="password"]').fill("hunter22");
		await expect(page.getByRole("button", { name: /^log in$/i })).toBeVisible();
	});

	test("a handle with no password is asked for an address instead", async ({ page }) => {
		await page.goto("/login");

		// The code is keyed on the email address, and resolving a public username to a
		// private mailbox would let anyone mail anyone by guessing handles.
		await page.locator('input[autocomplete="username"]').fill("alice");
		await page.getByRole("button", { name: /email me a sign-in code/i }).click();

		await expect(page.getByText(/needs your email address/i)).toBeVisible();
		// And no code was asked for: the modal must not open on a request we never sent.
		await expect(page.getByRole("heading", { name: /check your email/i })).toHaveCount(0);
	});

	test("an address opens the code field, in place", async ({ page }) => {
		await page.goto("/login");

		await page.locator('input[autocomplete="username"]').fill(addr());
		await page.getByRole("button", { name: /email me a sign-in code/i }).click();

		await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();
		await expect(page.locator('input[aria-label^="Code character"]')).toHaveCount(6);
		// Stays on /login. Sending someone to /subscribe to sign in is what this replaced.
		expect(new URL(page.url()).pathname).toBe("/login");

		// 🚨 The lede is conditional — "if there's an Anthers account for …" — because the
		// endpoint answers identically whether or not one exists, and a page that promised
		// a code had been sent would answer the question the API refuses to.
		await expect(page.getByText(/if there's an anthers account/i)).toBeVisible();
	});

	test("a wrong code is refused, and signs nobody in", async ({ page }) => {
		await page.goto("/login");
		await page.locator('input[autocomplete="username"]').fill(addr());
		await page.getByRole("button", { name: /email me a sign-in code/i }).click();

		// Wait for the autofocus rather than for the modal: `keyboard.type` goes wherever
		// focus currently is, and the modal becoming visible is a different moment from its
		// focus effect having run. Asserting only visibility passes in isolation and races
		// under the full suite's load.
		await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();

		// Valid shape, wrong value — so this reaches the endpoint rather than the client
		// guard, which is the half worth testing.
		await page.keyboard.type("ZZZZZZ");
		await expect(page.getByText(/that code didn't work/i)).toBeVisible();

		const boxes = page.locator('input[aria-label^="Code character"]');
		for (let i = 0; i < 6; i++) await expect(boxes.nth(i)).toHaveValue("");

		// Asserted against the API, because a refused code that still minted a session would
		// look identical on the page.
		const me = await page.request.get("http://localhost:8000/api/auth/me");
		expect((await me.json()).user, "a refused code must not create a session").toBeNull();
	});
});
