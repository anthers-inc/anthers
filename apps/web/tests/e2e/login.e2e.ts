// SPDX-License-Identifier: Apache-2.0
/**
 * `/login` — one field, and every identity leaves for its own server.
 *
 * 🚨 **Nothing on this page authenticates anybody.** Since 2026-10-27 signing in is OAuth for
 * every identity, an Anthers one included: the browser goes to whichever server holds the
 * handle, that server takes the credential and shows what is being granted, and the round trip
 * comes back with a grant. That is why there is no password field here at all, and why a handle
 * Anthers issued is not a special case.
 *
 * ⭐ **What this pins is the handoff, at both ends of the range.** An Anthers handle and a Bluesky
 * handle must produce the same request to `/api/atproto/auth`; an email address must produce none,
 * because it cannot start an OAuth flow and asking Anthers what it belongs to would confirm
 * registration to anybody who typed it.
 *
 * ⚠️ **What it cannot assert.** Completing a sign-in means authorizing at a real identity server,
 * which no test may do, so the round trip stops at the handoff. What happens on the way back is
 * pinned server-side in `atproto-login.test.ts`: an unlinked handle is refused rather than signed
 * up, a suspended account is refused rather than signed in, and a destination that leaves the
 * origin is dropped at both ends.
 */
import type { Page } from "@playwright/test";
import { API_URL, expect, test } from "./fixtures";

const field = (page: Page) => page.locator('input[autocomplete="username"]');
const submit = (page: Page) =>
	page.getByRole("button", { name: /continue with your identity server/i });

/** The suffix the session's node issues, so an Anthers handle is real in this run. */
async function hostedSuffix(page: Page): Promise<string> {
	const config = (await (await page.request.get(`${API_URL}/api/atproto/config`)).json()) as {
		hostedHandleSuffix: string;
	};
	return config.hostedHandleSuffix;
}

/**
 * Watch what the page asks the API for, and answer with somewhere harmless.
 *
 * A same-origin URL, so the browser goes nowhere near a real consent screen. Nothing after the
 * handoff is this spec's subject — the refusals and the no-minting rule live server-side.
 */
async function watchHandoff(page: Page): Promise<{ current: () => unknown }> {
	let payload: unknown = null;
	await page.route("**/api/atproto/auth", async (route) => {
		payload = route.request().postDataJSON();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ authorization_url: "/login?handed-off=1" }),
		});
	});
	return { current: () => payload };
}

test.describe("the one field is the door", () => {
	test("asks for a handle, never a password, and offers no second door", async ({ page }) => {
		await page.goto("/login");

		await expect(page.getByLabel(/your handle/i)).toBeVisible();
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		// The old affordances stayed gone: a second button and a modal would be a second door.
		await expect(page.getByRole("button", { name: /log in with bluesky/i })).toHaveCount(0);
		await expect(page.getByRole("heading", { name: /what's your handle/i })).toHaveCount(0);

		// The card still offers exactly one way to actually join, which is not this one.
		const card = page.locator("[data-auth-fade]");
		await expect(card.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/signup");
	});

	test("an Anthers handle hands off to the server Anthers runs", async ({ page }) => {
		await page.goto("/login");
		const handoff = await watchHandoff(page);

		// Typed with the leading `@`, because that is how people write a handle and it is not
		// part of one; stripping it is a real behavior the request depends on.
		await field(page).fill(`@jane.${await hostedSuffix(page)}`);
		await submit(page).click();

		await expect.poll(handoff.current).toMatchObject({
			handle: `jane.${await hostedSuffix(page)}`,
			intent: "login",
		});
	});

	test("a Bluesky handle makes the same request, with no second path", async ({ page }) => {
		await page.goto("/login");
		const handoff = await watchHandoff(page);

		await field(page).fill("@alice.bsky.social");
		await submit(page).click();

		await expect.poll(handoff.current).toMatchObject({
			handle: "alice.bsky.social",
			intent: "login",
		});
	});

	// 🚨 An address cannot start OAuth, and the refusal has to happen before anything is asked.
	// Resolving it would mean answering "does this mailbox have an account?" for anybody who
	// typed one, which is the enumeration the emailed-code design spent its shape refusing.
	test("an email address is refused in place, and asks the server nothing", async ({ page }) => {
		await page.goto("/login");
		let asked = false;
		await page.route("**/api/atproto/auth", async (route) => {
			asked = true;
			await route.abort();
		});

		await field(page).fill("jane@example.com");
		await submit(page).click();

		await expect(page.locator("[data-auth-fade] .alert-error")).toHaveText(
			/rather than your email/i,
		);
		expect(asked, "an address must not reach the identity-server lookup").toBe(false);
		expect(new URL(page.url()).pathname).toBe("/login");
	});

	test("a bare word is told to finish, rather than sent anywhere", async ({ page }) => {
		await page.goto("/login");
		let asked = false;
		await page.route("**/api/atproto/auth", async (route) => {
			asked = true;
			await route.abort();
		});

		await field(page).fill("alice");
		await submit(page).click();

		await expect(page.locator("[data-auth-fade] .alert-error")).toHaveText(/whole handle/i);
		expect(asked).toBe(false);
	});

	test("a handle that resolves to nothing is refused, in place, signed out", async ({ page }) => {
		await page.goto("/login");

		// Well-formed and unresolvable. `.invalid` is reserved by RFC 2606 so it can never
		// resolve — which makes this deterministic whether or not the runner has a network,
		// since both an answered lookup and an unreachable one end in a refusal.
		//
		// ⚠️ The 20s timeout is the fix for the version of this that failed deterministically:
		// the refusal comes from the OAuth client's `authorize()` walking the SDK's full
		// resolution chain for `.invalid` — the session's stand-in, then DoH, then a
		// `.well-known` fetch that waits out the 10s fetch timeout — measured at 10.5s here.
		await field(page).fill("nobody.example.invalid");
		await submit(page).click();

		await expect(page.locator("[data-auth-fade] .alert-error")).toHaveText(
			/couldn't find that handle/i,
			{ timeout: 20_000 },
		);

		// Still here, and still signed out. A failed handoff that navigated anyway would be a
		// worse bug than the refusal it is reporting.
		expect(new URL(page.url()).pathname).toBe("/login");
		const me = await page.request.get(`${API_URL}/api/auth/me`);
		expect((await me.json()).user, "a refused handle must not create a session").toBeNull();
	});

	// 🚨 A suspended account is refused by the OAuth callback rather than signed in, because its
	// sessions authenticate nothing. The card is where it lands and where it says why.
	test("a suspended account is told so on the card, not bounced with nothing said", async ({
		page,
	}) => {
		await page.goto("/login?suspended=1&until=2027-01-01T00:00:00.000Z");

		await expect(page.getByRole("heading", { name: /account suspended/i })).toBeVisible();
		await expect(page.getByText(/reply to that email to appeal/i)).toBeVisible();
	});
});
