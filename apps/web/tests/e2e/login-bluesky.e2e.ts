// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Bluesky door on `/login`.
 *
 * 🚨 **This spec exists because of how the feature was broken before it shipped.** The
 * client function `signInWithBluesky` had been written, tested and merged — and **nothing
 * in the interface called it**, which is the only reason two canonical documents could
 * describe ATProto sign-in as absent while the API route sat open. A unit test cannot see
 * that: every piece passes on its own. Pressing the button and asserting something happens
 * is the assertion that would have caught it, so that is what this pins.
 *
 * ⚠️ **What it cannot assert.** Completing a sign-in means authorizing on a real Bluesky
 * account at bsky.social, which no test may do — so the round trip stops at the handoff.
 * What happens on the way back is pinned server-side in `atproto-login.test.ts`: an
 * unlinked handle is refused rather than signed up, and a destination that leaves the
 * origin is dropped at both ends.
 *
 * The other half of what it pins is **copy**, and that is not incidental here. This door
 * signs in an account that has already linked a Bluesky identity; it cannot create one.
 * Someone who reads it as "sign up with Bluesky" finds out at the end of a round trip
 * through another website, so the modal has to say so before it sends them.
 */
import { expect, test } from "./fixtures";

test.describe("logging in with Bluesky", () => {
	test("the button is wired to something", async ({ page }) => {
		await page.goto("/login");

		await page.getByRole("button", { name: /log in with bluesky/i }).click();

		// The modal opening IS the assertion: a button wired to nothing looks identical to
		// one wired to something until you press it.
		await expect(page.getByRole("heading", { name: /what's your handle/i })).toBeVisible();
		await expect(page.getByLabel("Bluesky handle")).toBeFocused();
	});

	test("it says it cannot create an account, before sending anyone anywhere", async ({ page }) => {
		await page.goto("/login");
		await page.getByRole("button", { name: /log in with bluesky/i }).click();

		await expect(page.getByText(/doesn't create one/i)).toBeVisible();

		// And the card offers exactly one way to actually join, which is not this one.
		//
		// 🚨 **Scoped to the card, and `.first()` was the bug.** This read
		// `getByRole("link", {name: /^sign up$/i}).first()` — and the first such link in the
		// document is the one in the HEADER, so the assertion has been checking the navbar
		// while claiming to check this page. Pointing the card's link at `/login` left it
		// green. Two lessons, and the second is the one worth carrying: an anchored name
		// (`/^sign up$/`) pins a call to action's *wording* while pretending to test where
		// it goes, and `.first()` answers a question about document order that nobody asked.
		const card = page.locator("[data-auth-fade]");
		await expect(card.getByRole("link", { name: /sign up/i })).toHaveAttribute(
			"href",
			"/subscribe",
		);
	});

	test("a handle that resolves to nothing is refused in place", async ({ page }) => {
		await page.goto("/login");
		await page.getByRole("button", { name: /log in with bluesky/i }).click();

		// Well-formed and unresolvable. `.invalid` is reserved by RFC 2606 so it can never
		// resolve — which makes this deterministic whether or not the runner has a network,
		// since both an answered lookup and an unreachable one end in a refusal.
		await page.getByLabel("Bluesky handle").fill("nobody.example.invalid");
		await page.getByRole("button", { name: /^continue$/i }).click();

		// 🚨 Scoped to the modal, and this is not tidiness. A bare `.text-error` also matches
		// the red asterisk on the required field behind the backdrop — so the assertion
		// passed on whichever element rendered first, which for one run was the asterisk. A
		// selector that can match furniture is a selector that can pass without the feature.
		await expect(page.locator(".modal-box .text-error")).toHaveText(/couldn't find that handle/i);
		// Still here, and still signed out. A failed handoff that navigated anyway would be
		// a worse bug than the refusal it is reporting.
		expect(new URL(page.url()).pathname).toBe("/login");
		const me = await page.request.get("http://localhost:8000/api/auth/me");
		expect((await me.json()).user, "a refused handle must not create a session").toBeNull();
	});

	test("cancelling leaves the sign-in form exactly as it was", async ({ page }) => {
		await page.goto("/login");
		await page.locator('input[autocomplete="username"]').first().fill("alice@example.com");

		await page.getByRole("button", { name: /log in with bluesky/i }).click();
		await page.getByRole("button", { name: /^cancel$/i }).click();

		await expect(page.getByRole("heading", { name: /what's your handle/i })).toHaveCount(0);
		await expect(page.locator('input[autocomplete="username"]').first()).toHaveValue(
			"alice@example.com",
		);
	});
});
