// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Bluesky door on `/subscribe`.
 *
 * `/subscribe` is the single signup door, and this spec's job is to keep it single. Adding
 * a way to join through Bluesky is the sort of change that grows a second one by accident —
 * the 2026-08-17 consolidation deleted a Create Account card for exactly that reason, and
 * the two doors it replaced had already drifted about terms and onboarding.
 *
 * ⚠️ **What it cannot assert.** Finishing a signup means authorizing on a real Bluesky
 * account, which no test may do, so the round trip stops at the handoff. What happens on
 * the way back — that no account is created without a reachable address, and that one
 * created this way still owes a handle and the terms — is pinned server-side in
 * `atproto-signup.test.ts`, where the PDS can be made to answer four different ways.
 *
 * What is pinned here is the promise made *before* anyone leaves: that this door creates
 * an account, that it is about to ask Bluesky for an email address, and that a name and
 * the terms come afterwards. All three are things to learn before a consent screen appears
 * rather than from it.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The signup control at the top of the page.
 *
 * ⚠️ **`/subscribe` renders two of them** (2026-08-22): one above the optional support
 * sections and one in the closing summary. Their buttons share a label, which is right for
 * a reader — it is the same act — and ambiguous for a locator. Naming which one is meant
 * beats `.first()`, whose answer changes the day somebody reorders the page.
 */
const topSignup = (page: Page) => page.locator('[data-signup="top"]');

/**
 * Open the Bluesky half of the signup card.
 *
 * ⚠️ **The two doors sit behind a tab switcher since 2026-08-23**, so the Bluesky button
 * is not on the page until the tab is chosen. The tab is named "Bluesky" and the button
 * "Sign up with Bluesky", which is what keeps `role=tab` + name from colliding with
 * `role=button` + name — worth preserving, because a locator that matched both would be
 * ambiguous rather than wrong, and strict mode would report it as a missing element.
 */
async function openBlueskyDoor(page: Page) {
	await topSignup(page).getByRole("tab", { name: "Bluesky", exact: true }).click();
}

test.describe("signing up with Bluesky", () => {
	test("the tab reveals a button, and the button is wired to something", async ({ page }) => {
		await page.goto("/subscribe");

		// 🚨 **Wait for the tab before asserting the button is absent.** The Bluesky door is
		// only drawn once `GET /api/atproto/config` answers, so on first paint there are no
		// tabs at all and *nothing* named "Sign up with Bluesky" — which makes a bare
		// `toHaveCount(0)` pass instantly, for a reason that has nothing to do with which
		// door is selected. Caught by sabotage: defaulting the state to `"bluesky"` left
		// this test green while two others went red. The tab's presence is what proves the
		// switcher has rendered, so the count below is then about the selection.
		const blueskyTab = topSignup(page).getByRole("tab", { name: "Bluesky", exact: true });
		await expect(blueskyTab).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /sign up with bluesky/i }),
			"email is the door a visitor meets; Bluesky is the other tab, not the default",
		).toHaveCount(0);

		await openBlueskyDoor(page);
		await topSignup(page)
			.getByRole("button", { name: /sign up with bluesky/i })
			.click();

		// A button wired to nothing looks identical to one wired to something until you
		// press it — which is how the sign-in half of this shipped unreachable.
		await expect(page.getByRole("heading", { name: /what's your handle/i })).toBeVisible();
		await expect(page.getByLabel("Bluesky handle")).toBeFocused();
	});

	test("it says what it will ask Bluesky for, and what comes after", async ({ page }) => {
		await page.goto("/subscribe");
		await openBlueskyDoor(page);
		await topSignup(page)
			.getByRole("button", { name: /sign up with bluesky/i })
			.click();

		// 🚨 The email ask is the part worth pinning. `transition:email` is a real consent
		// screen on somebody else's website, and meeting it unannounced is how a signup gets
		// abandoned at the last step.
		await expect(page.getByText(/ask it for your email address/i)).toBeVisible();
		// 🚨 And that Anthers confirms it regardless. A PDS calling an address confirmed is
		// somebody else's assertion; the code is ours. Copy implying otherwise would describe
		// a shortcut this flow deliberately does not take.
		await expect(page.getByText(/confirms that address with its own code/i)).toBeVisible();
		// ⚠️ Matched without the ordering word. This read `.../terms after/` and broke when
		// the sentence was rephrased to put "then" at the front — same promise, different
		// word order. What matters is that a name and the terms are named as still to come.
		await expect(page.getByText(/pick a name and agree to the terms/i)).toBeVisible();
	});

	test("this door says it creates an account, where the login one says it cannot", async ({
		page,
	}) => {
		await page.goto("/subscribe");
		await openBlueskyDoor(page);
		await topSignup(page)
			.getByRole("button", { name: /sign up with bluesky/i })
			.click();
		await expect(page.getByText(/doesn't create one/i)).toHaveCount(0);

		// The same component, the other mode. Two doors, two promises, and neither may
		// quietly become the other.
		await page.goto("/login");
		await page.getByRole("button", { name: /log in with bluesky/i }).click();
		await expect(page.getByText(/doesn't create one/i)).toBeVisible();
	});

	test("a fabricated ?atproto=1 gets no special treatment", async ({ page }) => {
		// 🚨 The parked signup is read from an httpOnly cookie, never from the URL. If the
		// query alone could put this page into "finishing a Bluesky signup" mode, the handle
		// it displayed would be whatever an attacker put in a link.
		await page.goto("/subscribe?atproto=1");

		await expect(page.getByText(/signing up as @/i)).toHaveCount(0);
		// ⚠️ Deliberately not asserting the Bluesky button here. Whether it renders depends
		// on the launch switch, which is not this test's subject — and an assertion that
		// drags in an unrelated condition is one that fails for unrelated reasons.
		//
		// 🚨 But wait for the tab switcher before reading the email door, for the same
		// reason as the test above: the card starts with no tabs and the email field
		// showing, so this assertion would pass on the first paint whatever the tabs
		// later decide. It is only meaningful once the switcher has rendered.
		await expect(topSignup(page).getByRole("tab", { name: "Bluesky", exact: true })).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /create my free account/i }),
		).toBeVisible();
	});
});
