// SPDX-License-Identifier: Apache-2.0
/**
 * Log out lives on both settings pages, in one card that names the account first.
 *
 * 🚨 **This spec exists because the header's account menu used to be the only door out of a
 * session.** Removing that item without a replacement would have stranded every signed-in
 * person with no way to sign out, and each settings page is reachable without the other — a
 * reader who never visits the Studio still needs the card on the user side, and a creator
 * working only in the Studio needs it on theirs. (The menu itself came out on 2026-10-26,
 * which leaves these two cards as the only doors.) Two pages, one shared component, so this
 * walks both rather than trusting the import.
 *
 * The click itself is exercised by `basket-account-scoping.authed.e2e.ts`, whose sign-out
 * walk now goes through this card. This spec asserts the card renders on both pages, names
 * the actual signed-in account, and offers the button — not that the session ends, which
 * would leave the shared `authed` cookie jar signed out for every later spec.
 */
import { API_URL, expect, signInAsCreator, test } from "./fixtures";

const card = (page: import("@playwright/test").Page) => page.locator("[data-signed-in-account]");

test("the user settings Account tab names the account and carries Log Out", async ({ page }) => {
	await page.goto("/settings");

	await expect(page.getByRole("tab", { name: "Account" })).toHaveAttribute("aria-selected", "true");

	const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
		user: { handle: string; displayName: string | null };
	};
	const signedIn = card(page);
	await expect(signedIn, "no signed-in account card on the Account tab").toBeVisible();
	await expect(signedIn.getByText("Signed in as")).toBeVisible();
	await expect(signedIn.getByText(`@${me.user.handle}`)).toBeVisible();
	await expect(
		signedIn.getByRole("button", { name: "Log Out" }),
		"the Account tab has no way to end the session",
	).toBeVisible();
});

test("the creator settings page names the account and carries Log Out", async ({ browser }) => {
	// The `authed` project's stored state is the walker, who is not a creator, so the
	// Studio's gate would bounce this page. A second context signs in as the creator
	// rather than replacing the shared session.
	const creatorContext = await browser.newContext();
	await signInAsCreator(creatorContext);
	const creatorPage = await creatorContext.newPage();
	await creatorPage.goto("/studio/settings");

	await expect(creatorPage.getByRole("heading", { name: "Creator Settings" })).toBeVisible();
	const signedIn = card(creatorPage);
	await expect(signedIn, "no signed-in account card on the creator settings page").toBeVisible();
	await expect(signedIn.getByText("Signed in as")).toBeVisible();
	await expect(
		signedIn.getByRole("button", { name: "Log Out" }),
		"the creator settings page has no way to end the session",
	).toBeVisible();

	await creatorContext.close();
});
