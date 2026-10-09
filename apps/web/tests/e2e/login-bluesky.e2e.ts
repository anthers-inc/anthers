// SPDX-License-Identifier: Apache-2.0
/**
 * The Bluesky door on `/login` — which since 2026-10-09 is the field, and nothing else.
 *
 * 🚨 **This spec exists because of how the feature was broken before it shipped.** The
 * client function `signInWithBluesky` had been written, tested and merged — and **nothing
 * in the interface called it**, which is the only reason two canonical documents could
 * describe ATProto sign-in as absent while the API route sat open. A unit test cannot see
 * that: every piece passes on its own. What pins it now is the field: type a Bluesky
 * handle, press Continue, and something must leave for Bluesky.
 *
 * ⚠️ **What it cannot assert.** Completing a sign-in means authorizing on a real Bluesky
 * account at bsky.social, which no test may do — so the round trip stops at the handoff.
 * What happens on the way back is pinned server-side in `atproto-login.test.ts`: an
 * unlinked handle is refused rather than signed up, and a destination that leaves the
 * origin is dropped at both ends.
 *
 * ⚠️ **The hosted-handle half of the routing is asserted elsewhere**: `signup-ceremony.test.ts`
 * pins the server's resolution, and `emailed-code.e2e.ts` walks a hosted handle to a real
 * signed-in session. What is pinned here is that a handle typed at this page goes OUT to
 * the identity's own server — and never that a hosted one stays in.
 */
import { API_URL, expect, test } from "./fixtures";

test.describe("a Bluesky handle signs in through OAuth, from the one field", () => {
	test("the button and its modal are gone — the field is the door", async ({ page }) => {
		await page.goto("/login");

		// The routing a visitor can read before pressing anything: the label is
		// Bluesky-simple ("Email or handle"), the field's own drawing turns as they type,
		// and the hint under it names the door the typed handle is headed for.
		await expect(page.getByText(/^email or handle$/i)).toBeVisible();

		// 🚨 The old affordances stayed gone the day the field took the door over: a
		// second button and a modal would be a second Bluesky door, and the two would
		// drift exactly the way the login/signup split did.
		await expect(page.getByRole("button", { name: /log in with bluesky/i })).toHaveCount(0);
		await expect(page.getByRole("heading", { name: /what's your handle/i })).toHaveCount(0);

		// And the card still offers exactly one way to actually join, which is not this one.
		const card = page.locator("[data-auth-fade]");
		await expect(card.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/signup");
	});

	test("a Bluesky handle hands the browser to Bluesky, from the field", async ({ page }) => {
		await page.goto("/login");

		let payload: unknown = null;
		await page.route("**/api/atproto/auth", async (route) => {
			payload = route.request().postDataJSON();
			// A same-origin URL, so the browser goes somewhere harmless instead of to a real
			// consent screen. Nothing after the handoff is this spec's subject — the
			// unresolvable-handle refusal and the no-minting rule are pinned by the tests
			// around this one, server-side in `atproto-login.test.ts`.
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ authorization_url: "/login?handed-off=1" }),
			});
		});

		// Typed WITH the leading `@`, because that is how people write a handle and it is
		// not part of one — stripping it is a real behavior the flow downstream depends on.
		await page.locator('input[autocomplete="username"]').fill("@alice.bsky.social");
		await page.getByRole("button", { name: /^continue$/i }).click();

		await expect.poll(() => payload).not.toBeNull();
		expect(payload).toMatchObject({ handle: "alice.bsky.social", intent: "login" });
	});

	test("a handle that resolves to nothing is refused, in place, signed out", async ({ page }) => {
		await page.goto("/login");

		// Well-formed and unresolvable. `.invalid` is reserved by RFC 2606 so it can never
		// resolve — which makes this deterministic whether or not the runner has a network,
		// since both an answered lookup and an unreachable one end in a refusal. The page
		// hands it to the OAuth door like any other foreign handle, and the refusal comes
		// back to the card's own error line, where the modal used to put it.
		await page.locator('input[autocomplete="username"]').fill("nobody.example.invalid");
		await page.getByRole("button", { name: /^continue$/i }).click();

		// ⚠️ The 20s timeout is the fix for the "deterministically fails on main" version of
		// this spec, and the number is the point, not sloppiness. The refusal is produced by
		// the OAuth client's `authorize()` walking the SDK's full resolution chain for
		// `.invalid` — first asking the session's Bluesky stand-in, then the DoH DNS leg,
		// then a `.well-known` HTTP fetch that waits out the 10s fetch timeout before the
		// whole chain settles and returns `HandleNotFound`. Measured end to end at
		// **10.5s** on this runner, so the default 5s assertion expired while the refusal
		// was still legitimately in flight. The handle is not cached: `authorize()` resolves
		// it fresh every time, so the cost repeats on every run. Anything materially over
		// 20s is genuinely stuck, not merely slow.
		await expect(page.locator("[data-auth-fade] .alert-error")).toHaveText(
			/couldn't find that handle/i,
			{ timeout: 20_000 },
		);

		// Still here, and still signed out. A failed handoff that navigated anyway would be
		// a worse bug than the refusal it is reporting.
		expect(new URL(page.url()).pathname).toBe("/login");
		const me = await page.request.get(`${API_URL}/api/auth/me`);
		expect((await me.json()).user, "a refused handle must not create a session").toBeNull();
	});
});
