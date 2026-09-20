// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in from `/login`, which is the emailed code and nothing else.
 *
 * No account holds a password (Parker, 2026-09-13), so this page has no password field
 * and no route it could post one to: the one form asks for an email address, mails it a
 * six-character code, and opens the same six-box field `/subscribe` uses.
 *
 * ⚠️ **Completing a sign-in with the real code is `emailed-code.e2e.ts`'s job**, which reads the
 * code out of the session's mail catcher. This spec pins the page around it — including that
 * the password field stayed gone (`input[type="password"]` on this page at all would be the
 * old door rebuilt).
 *
 * It cannot assert the load-bearing property — that this door **never creates an
 * account** — because there is deliberately no way to ask the API whether an address is
 * registered. That one is pinned server-side, in `signup-ceremony.test.ts`
 * (*"a valid code for an address with no account creates NOTHING"*), and it is the
 * assertion to protect: a `/login` that minted accounts would be the second signup door the
 * 2026-08-17 consolidation removed, and it would look perfectly correct from this page.
 *
 * So what is pinned here is the browser half: the page asks for an address and says what the
 * button does, a handle is not mistaken for an address, and a refused code signs nobody in.
 */
import { API_URL, expect, test } from "./fixtures";

/** An address that cannot collide with a real account or another run. */
const addr = () => `e2e-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

test.describe("signing in with an emailed code", () => {
	test("the card asks for an email address and offers no password field", async ({ page }) => {
		await page.goto("/login");

		// 🚨 The load-bearing absence: a password input on this page is the old door
		// rebuilt. The form asks for the address the code goes to and nothing else.
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await expect(page.locator('input[type="email"]')).toHaveCount(1);

		await expect(page.getByText(/six-character sign-in code/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /email me a sign-in code/i })).toBeVisible();
	});

	test("something that is not an address is asked for one", async ({ page }) => {
		await page.goto("/login");

		// The code is keyed on the email address, and resolving a public username to a
		// private mailbox would let anyone mail anyone by guessing handles.
		await page.locator('input[type="email"]').fill("alice");
		await page.getByRole("button", { name: /email me a sign-in code/i }).click();

		await expect(page.getByText(/needs your email address/i)).toBeVisible();
		// And no code was asked for: the modal must not open on a request we never sent.
		await expect(page.getByRole("heading", { name: /check your email/i })).toHaveCount(0);
	});

	test("an address opens the code field, in place", async ({ page }) => {
		await page.goto("/login");

		await page.locator('input[type="email"]').fill(addr());
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
		await page.locator('input[type="email"]').fill(addr());
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
		const me = await page.request.get(`${API_URL}/api/auth/me`);
		expect((await me.json()).user, "a refused code must not create a session").toBeNull();
	});
});
