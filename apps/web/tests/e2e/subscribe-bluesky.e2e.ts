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
 * an account, and that it is about to ask Bluesky for an email address. Both are things to
 * learn before a consent screen appears rather than from it.
 *
 * ⭐ **The handle is collected on the card itself since 2026-08-24**, where it used to open
 * `BlueskyHandleModal` — two presses and a layer for one short field. `/login` still uses
 * the modal, because its card has flourishes an inline field cannot clear.
 *
 * ⚠️ **The panel then lost its explanatory paragraph the same day**, because it made the
 * Bluesky tab twice the height of the email one and switching tabs resized the card under
 * the reader. Two of the three promises it carried are said again by the flow itself
 * (`/welcome` takes the name and the terms; the emailed code arrives and explains itself),
 * so only the email-scope warning needed rehoming — it is in the note under the button now,
 * and it is the one assertion below that is about wording rather than structure.
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
 * ⚠️ **The two doors sit behind a tab switcher since 2026-08-23**, so neither the handle
 * field nor its button is on the page until the tab is chosen. The tab is named "Bluesky"
 * and the button "Sign up with Bluesky", which is what keeps `role=tab` + name from
 * colliding with `role=button` + name — worth preserving, because a locator that matched
 * both would be ambiguous rather than wrong, and strict mode would report it as a missing
 * element.
 */
async function openBlueskyDoor(page: Page) {
	await topSignup(page).getByRole("tab", { name: "Bluesky", exact: true }).click();
}

test.describe("signing up with Bluesky", () => {
	test("the tab reveals the handle field, and email is still the default door", async ({
		page,
	}) => {
		await page.goto("/subscribe");

		// 🚨 **Wait for the tab before asserting the field is absent.** The Bluesky door is
		// only drawn once `GET /api/atproto/config` answers, so on first paint there are no
		// tabs at all and *nothing* named "Bluesky handle" — which makes a bare
		// `toHaveCount(0)` pass instantly, for a reason that has nothing to do with which
		// door is selected. Caught by sabotage: defaulting the state to `"bluesky"` left
		// this test green while two others went red. The tab's presence is what proves the
		// switcher has rendered, so the count below is then about the selection.
		const blueskyTab = topSignup(page).getByRole("tab", { name: "Bluesky", exact: true });
		await expect(blueskyTab).toBeVisible();
		await expect(
			topSignup(page).getByLabel("Bluesky handle"),
			"email is the door a visitor meets; Bluesky is the other tab, not the default",
		).toHaveCount(0);

		await openBlueskyDoor(page);

		// 🚨 The handle is asked for HERE rather than in a modal (2026-08-24). The button
		// used to open `BlueskyHandleModal`, so joining this way cost two presses and a
		// layer for one short field. If a modal grows back, this assertion still passes —
		// which is why the next test checks the button carries the handle straight to the
		// API rather than merely that something happened.
		await expect(topSignup(page).getByLabel("Bluesky handle")).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /sign up with bluesky/i }),
			"the button should refuse until there is a handle to send",
		).toBeDisabled();
	});

	test("the handle typed into the card is what starts the round trip", async ({ page }) => {
		await page.goto("/subscribe");
		await openBlueskyDoor(page);

		// A button wired to nothing looks identical to one wired to something until you
		// press it — which is how the sign-in half of this shipped unreachable. Intercepting
		// is what lets the assertion be about the REQUEST rather than about a modal opening:
		// the handoff is the behaviour, and everything past it is somebody else's website.
		let payload: unknown = null;
		await page.route("**/api/atproto/auth", async (route) => {
			payload = route.request().postDataJSON();
			// A same-origin URL, so the browser goes somewhere harmless instead of to a real
			// consent screen. Nothing after the handoff is this spec's subject.
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ authorization_url: "/subscribe?handed-off=1" }),
			});
		});

		// ⚠️ Typed WITH the leading `@`, because that is how people write a handle and it is
		// not part of one. Stripping it is a real behaviour and this is the only test of it.
		await topSignup(page).getByLabel("Bluesky handle").fill("@alice.bsky.social");
		await topSignup(page)
			.getByRole("button", { name: /sign up with bluesky/i })
			.click();

		await expect.poll(() => payload).not.toBeNull();
		expect(payload).toMatchObject({ handle: "alice.bsky.social", intent: "signup" });
	});

	test("it warns that Bluesky will be asked for an email address", async ({ page }) => {
		await page.goto("/subscribe");
		await openBlueskyDoor(page);

		// ⭐ No press needed. This lives on the panel rather than behind the button, so a
		// reader meets it before touching anything — which is the point of saying it at all.
		//
		// ⚠️ **Scoped to the top card, where the modal made scoping unnecessary.** The page
		// renders two signup cards sharing one `door`, so choosing Bluesky renders this copy
		// TWICE and an unscoped `getByText` is a strict-mode violation. Naming the card is
		// the fix rather than `.first()`, whose answer changes if the page is reordered.
		//
		// 🚨 **This is the LAST of three promises the panel used to carry, and the only one
		// that has nowhere else to be said** (2026-08-24). The panel was cut to a field and
		// a button, because a paragraph made the Bluesky tab twice the height of the email
		// one and switching tabs resized the card. The other two survived the cut because
		// the flow says them anyway a moment later: `/welcome` takes the name and the terms,
		// and the emailed code speaks for itself on arrival. This one does not — the next
		// thing that mentions the email scope is `transition:email`'s own consent screen, on
		// somebody else's website, mid-flow. That is the moment this sentence exists to
		// pre-empt, so it is pinned even though the copy around it is free to move.
		await expect(topSignup(page).getByText(/ask to share your email address/i)).toBeVisible();
	});

	test("this door says it creates an account, where the login one says it cannot", async ({
		page,
	}) => {
		await page.goto("/subscribe");
		await openBlueskyDoor(page);
		await expect(page.getByText(/doesn't create one/i)).toHaveCount(0);

		// The other door, which still uses the modal because `/login`'s card has no room for
		// an inline field. Two doors, two promises, and neither may quietly become the other.
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
