// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in from `/login`: the emailed code, or a Bluesky handle through OAuth.
 *
 * No account holds a password (Parker, 2026-09-13), so this page has no password field
 * and no route it could post one to: the one form asks for an identifier, routes on what
 * it is, and the emailed-code half shares the six-box field `/signup` uses.
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
 * So what is pinned here is the browser half: the page asks for an identifier and says
 * what each shape of one does, a typed `@` is recognized as the start of a handle, and a
 * refused code signs nobody in. The OAuth half of the routing is `login-bluesky.e2e.ts`'s,
 * and the hosted-handle walk that signs in is `emailed-code.e2e.ts`'s.
 */
import { API_URL, expect, test } from "./fixtures";

/** An address that cannot collide with a real account or another run. */
const addr = () => `e2e-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

test.describe("signing in with an emailed code", () => {
	test("the card asks for an address or handle, offers no password field, and detects what is typed", async ({
		page,
	}) => {
		await page.goto("/login");

		// 🚨 The load-bearing absence: a password input on this page is the old door
		// rebuilt. The form asks for the identifier the code goes to and nothing else.
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await expect(page.locator('input[autocomplete="username"]')).toHaveCount(1);

		// The Bluesky-style label — no examples, no doors spelled out in copy — because
		// the field says both things as they become true: the icon turns, and the hint
		// names the door the typed shape is headed for.
		await expect(page.getByText(/^email or handle$/i)).toBeVisible();

		const field = page.locator('input[autocomplete="username"]');
		const drawing = page.locator("[data-form-icon]");
		await expect(drawing).toHaveAttribute("data-form-icon", "idle");
		await expect(
			page.getByText(/an email or anthers handle gets a sign-in code by mail/i),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /^continue$/i })).toBeVisible();

		// An address, typed: the envelope confirms the reading, the hint commits to it.
		await field.fill("jane@doe.com");
		await expect(drawing).toHaveAttribute("data-form-icon", "email");
		await expect(page.getByText(/six-character sign-in code goes to this address/i)).toBeVisible();
	});

	test("the field recognizes a handle as it forms, including whose it is", async ({ page }) => {
		await page.goto("/login");
		const config = (await (await page.request.get(`${API_URL}/api/atproto/config`)).json()) as {
			hostedHandleSuffix: string;
		};
		const suffix = config.hostedHandleSuffix;

		const field = page.locator('input[autocomplete="username"]');
		const drawing = page.locator("[data-form-icon]");

		// An `@` leads, and the drawing answers immediately — the half-formed state a
		// handle-typist passes through and an address-typist never does (Parker, 2026-10-09).
		await field.fill("@ja");
		await expect(drawing).toHaveAttribute("data-form-icon", "handle");

		// Complete it as an Anthers handle: the `@` turns ours, the hint commits.
		await field.fill(`@jane.${suffix}`);
		await expect(drawing).toHaveAttribute("data-form-icon", "anthers");
		await expect(page.getByText(/goes to this account's email address/i)).toBeVisible();

		// A foreign handle under the same `@`: the butterfly, only when the whole thing
		// is there — never mid-word.
		await field.fill("@alice.bsky.social");
		await expect(drawing).toHaveAttribute("data-form-icon", "bluesky");
		await expect(page.getByText(/bluesky confirms it's you/i)).toBeVisible();

		// And the keyboard answer rides along: the moment an `@` leads, the keyboard is
		// the handle's, not the email's.
		await expect(field).toHaveAttribute("inputmode", "url");
		await field.fill("jane@doe.com");
		await expect(field).toHaveAttribute("inputmode", "email");
	});

	test("something that is neither an address nor a handle is asked for one", async ({ page }) => {
		await page.goto("/login");

		// ⚠️ A foreign handle is resolved by the identity's own server, never by Anthers'
		// postbox — Anthers turns only its OWN handles into mailboxes. But a bare word is
		// neither an address nor any kind of handle, so it is refused by the page's own
		// shape check, and the message is the page's own too, since the input is
		// deliberately not `type="email"`.
		await page.locator('input[autocomplete="username"]').fill("alice");
		await page.getByRole("button", { name: /^continue$/i }).click();

		await expect(page.getByText(/email address or the handle on your account/i)).toBeVisible();
		// And no code was asked for: the modal must not open on a request we never sent.
		await expect(page.getByRole("heading", { name: /check your email/i })).toHaveCount(0);
	});

	test("an address opens the code field, in place", async ({ page }) => {
		await page.goto("/login");

		await page.locator('input[autocomplete="username"]').fill(addr());
		await page.getByRole("button", { name: /^continue$/i }).click();

		await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();
		await expect(page.locator('input[aria-label^="Code character"]')).toHaveCount(6);
		// Stays on /login. Sending someone to the signup page to sign in is what this replaced.
		expect(new URL(page.url()).pathname).toBe("/login");

		// 🚨 The lede is conditional — "if there's an Anthers account for …" — because the
		// endpoint answers identically whether or not one exists, and a page that promised
		// a code had been sent would answer the question the API refuses to.
		await expect(page.getByText(/if there's an anthers account/i)).toBeVisible();
	});

	test("a wrong code is refused, and signs nobody in", async ({ page }) => {
		await page.goto("/login");
		await page.locator('input[autocomplete="username"]').fill(addr());
		await page.getByRole("button", { name: /^continue$/i }).click();

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
