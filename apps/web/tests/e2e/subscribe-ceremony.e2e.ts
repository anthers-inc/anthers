// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The signup ceremony on `/subscribe`.
 *
 * 🚨 **This page had no e2e coverage at all**, which is recorded in the Agents Hub as a
 * known gap — it was rebuilt wholesale in #223 with `make verify` green throughout, and
 * verified only by driving a browser by hand. That gap then cost a real bug during the
 * ceremony work: `/subscribe` renders inside `PublicShell`, which returns
 * `LoggedOutLayout` or `LoggedInLayout` depending on auth state, so refreshing the auth
 * context tore the page down mid-flow and the payment modal silently never opened. No
 * error, no failing test, and nothing a route test could have seen.
 *
 * ⚠️ **What this spec cannot assert, and why.** It cannot complete a verification,
 * because the emailed code is argon2-hashed at rest — there is deliberately no way to
 * read it back out of the database, and the only other copy goes to the API's stdout,
 * which Playwright's `webServer` owns. A test-only endpoint that handed back the live
 * code for an address was considered and rejected: it is precisely the thing that must
 * not exist, and having it in the codebase at all is a worse risk than this gap.
 *
 * So the successful path — code accepted, session issued, payment modal, `/welcome` —
 * is verified by hand against a live API, and what is pinned here is everything on the
 * near side of that: the ceremony **opens in place**, the field behaves, a bad code is
 * refused, and nobody is signed in by accident. The single most valuable of those is
 * the first, because "it redirected to /signup and the user lost their picks" is the
 * behaviour this whole change exists to remove.
 */
import { expect, test } from "./fixtures";

/** An address that cannot collide with a real account or another run. */
const addr = () =>
	`e2e-ceremony-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/**
 * There is exactly ONE way to mint an account from the browser, and it is `/subscribe`.
 *
 * 🚨 These are the *absence* assertions for the 2026-08-17 consolidation, and they exist
 * because the thing they guard cannot fail loudly. The four-field Create Account card at
 * `/signup` was deleted; nothing breaks if someone adds a second signup form back, and
 * the cost of one is not obvious from either page — two doors have to keep agreeing about
 * terms acceptance, onboarding, and where a new account lands, and the pair that existed
 * had already drifted (only `/welcome` asks for the terms now, so a second door that
 * doesn't ask would create accounts that never agreed to anything).
 *
 * Same family as the third-party-request spec: where a design claims there is only one of
 * something, that claim needs a test, because a second one arrives silently.
 */
test.describe("one signup door", () => {
	test("/signup is a redirect to /subscribe, not a form", async ({ page }) => {
		await page.goto("/signup");

		await expect(page.getByRole("heading", { name: /anthers is free/i })).toBeVisible();
		expect(new URL(page.url()).pathname).toBe("/subscribe");
	});

	test("no page in the logged-out surface offers a second account form", async ({ page }) => {
		// Asking for a password TWICE is the tell, and it is a structural one: the ceremony
		// has no password step at all (the handle and an optional password are asked for at
		// /welcome, after the account exists), and /login asks once. Two boxes on either
		// page means a Create Account card has grown back, whatever its fields are called.
		//
		// ⚠️ The first draft of this asserted `getByLabel(/confirm password/i)` had count 0,
		// which is a TAUTOLOGY: `FormField` renders its label as a *sibling* of the input
		// with no `htmlFor`, so `getByLabel` matches nothing on this site whether or not a
		// form is there. It passed against the deleted card as happily as against the live
		// page. Count what the DOM actually contains.
		for (const path of ["/subscribe", "/login"]) {
			await page.goto(path);
			await expect(page.locator("h1").first()).toBeVisible();
			const passwords = await page.locator('input[type="password"]').count();
			expect(
				passwords,
				`${path} asks for a password ${passwords}× — a signup form is back`,
			).toBeLessThanOrEqual(1);
			await expect(
				page.getByText(/confirm password/i),
				`${path} asks to confirm a password — a signup form is back`,
			).toHaveCount(0);
		}
	});

	test("the header offers both doors, and they lead to different places", async ({ page }) => {
		await page.goto("/");

		const header = page.locator("header").first();
		await expect(header.getByRole("link", { name: "Log In", exact: true })).toHaveAttribute(
			"href",
			"/login",
		);
		await expect(header.getByRole("link", { name: "Sign Up", exact: true })).toHaveAttribute(
			"href",
			"/subscribe",
		);
	});

	test("/login signs people in and sends everyone else to the one door", async ({ page }) => {
		await page.goto("/login");

		await expect(page.getByRole("heading", { name: "Log In" })).toBeVisible();
		// Scoped to the card, because the header and the footer both offer a "Sign Up"
		// too — three routes to one door is the intended state, and an unscoped locator
		// just fails on strict mode rather than telling you anything.
		const card = page.locator("[data-auth-fade]");
		// The prompt used to flip this same card into signup mode. It is a link now, and
		// where it points is the whole property.
		await expect(card.getByRole("link", { name: /sign up/i })).toHaveAttribute(
			"href",
			"/subscribe",
		);
	});
});

test.describe("starting an account from /subscribe", () => {
	test("the ceremony opens on the page, and does not send anyone to /signup", async ({ page }) => {
		await page.goto("/subscribe");

		await page.locator("#subscribe-email").fill(addr());
		await page.getByRole("button", { name: /create my free account/i }).click();

		await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();

		// The property that matters. The old flow bounced to /signup, and the picks only
		// survived because they were being mirrored into session storage on every change —
		// they left the screen at the exact moment they were being agreed to.
		expect(new URL(page.url()).pathname).toBe("/subscribe");
	});

	test("a chosen Seed changes the ask, and the ceremony says there is a second step", async ({
		page,
	}) => {
		await page.goto("/subscribe");
		await page.getByRole("button", { name: /yes — \$3 a month/i }).click();

		// The page's own arithmetic, which is the only number a reader is agreeing to.
		await expect(page.getByText("$3", { exact: true }).last()).toBeVisible();

		const cta = page.getByRole("button", { name: /create my account & continue/i });
		await expect(cta, "the CTA should promise more than a free account").toBeVisible();

		await page.locator("#subscribe-email").fill(addr());
		await cta.click();

		// A paying start is two steps; a free one is one, and says so rather than counting
		// to a step it will never reach.
		await expect(page.getByText("Step 1 of 2")).toBeVisible();
	});

	test("the free path promises one step only", async ({ page }) => {
		await page.goto("/subscribe");
		await page.locator("#subscribe-email").fill(addr());
		await page.getByRole("button", { name: /create my free account/i }).click();

		await expect(page.getByText("Verify your email")).toBeVisible();
		await expect(page.getByText("Step 1 of 2")).toHaveCount(0);
	});
});

test.describe("the code field", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/subscribe");
		await page.locator("#subscribe-email").fill(addr());
		await page.getByRole("button", { name: /create my free account/i }).click();
		await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();

		// 🚨 Wait for the autofocus, not just for the modal. Every test below drives the
		// field with bare `keyboard.type`, which goes wherever focus currently is — and
		// the modal becoming *visible* is a different moment from its focus effect having
		// run. Asserting only visibility passed in isolation and failed under the full
		// suite's parallel load, which is the classic shape of an e2e flake: the race is
		// real, the test just usually wins it.
		await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();
	});

	test("is six boxes, focused, and types forward", async ({ page }) => {
		const boxes = page.locator('input[aria-label^="Code character"]');
		await expect(boxes).toHaveCount(6);
		// Focus is already asserted in beforeEach; restated here because it is this
		// test's own subject rather than a precondition.
		await expect(boxes.first()).toBeFocused();

		await page.keyboard.type("AB");
		await expect(boxes.nth(0)).toHaveValue("A");
		await expect(boxes.nth(1)).toHaveValue("B");
		// Auto-advance is the whole reason this can be six boxes rather than one field.
		await expect(boxes.nth(2)).toBeFocused();
	});

	test("backspace deletes, and a typed code can actually be corrected", async ({ page }) => {
		const boxes = page.locator('input[aria-label^="Code character"]');
		await page.keyboard.type("AB");
		// Focus sits on box 3, which is empty.
		await expect(boxes.nth(2)).toBeFocused();

		// Empty box → clear the one before and go there. Stepping back without clearing
		// would strand a character the cursor has already passed.
		await page.keyboard.press("Backspace");
		await expect(boxes.nth(1)).toBeFocused();
		await expect(boxes.nth(1)).toHaveValue("");

		await page.keyboard.press("Backspace");
		await expect(boxes.nth(0)).toBeFocused();
		await expect(boxes.nth(0)).toHaveValue("");

		// 🚨 The assertion that matters, and the one that caught a real bug: these are
		// CONTROLLED inputs, so a backspace that is merely "not prevented" gets swallowed
		// and React writes the old character straight back. A code field you cannot
		// correct is worse than one that never accepted the keystroke.
		await page.keyboard.type("XY");
		await expect(boxes.nth(0)).toHaveValue("X");
		await expect(boxes.nth(1)).toHaveValue("Y");
	});

	test("refuses to submit until all six are filled", async ({ page }) => {
		const verify = page.getByRole("button", { name: /verify my email/i });
		await expect(verify).toBeDisabled();

		await page.keyboard.type("ABCDE");
		await expect(verify, "five characters is not a code").toBeDisabled();

		await page.keyboard.type("F");
		// The sixth character submits on its own, so by now the button has either gone
		// busy or the request has already been refused — either way it is no longer the
		// inert control it was at five.
		await expect(page.getByText(/didn't work|Checking/i)).toBeVisible();
	});

	test("a wrong code is refused, clears the boxes, and signs nobody in", async ({ page }) => {
		// Valid shape, wrong value — so this reaches the endpoint rather than the client
		// guard, which is the half worth testing.
		await page.keyboard.type("ZZZZZZ");

		await expect(page.getByText(/that code didn't work/i)).toBeVisible();

		// Cleared rather than left half-corrected: the next thing anyone does is retype it,
		// and six stale characters is how the second attempt goes wrong too.
		const boxes = page.locator('input[aria-label^="Code character"]');
		for (let i = 0; i < 6; i++) await expect(boxes.nth(i)).toHaveValue("");
		await expect(boxes.first()).toBeFocused();

		// 🚨 And nobody is signed in. A failed verification that still minted a session
		// would be invisible here — the modal looks identical — so it is asserted against
		// the API rather than the page.
		const me = await page.request.get("http://localhost:8000/api/auth/me");
		expect((await me.json()).user, "a refused code must not create a session").toBeNull();
	});
});
