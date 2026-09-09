// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Asking Anthers for a handle from settings, walked in a browser.
 *
 * 🚨 **A route with no surface is a route nobody can reach**, which is the whole reason this
 * spec exists: `hosted-handle-request.test.ts` can prove every refusal and every status code
 * while nothing in the front end ever calls the endpoint. Route tests cannot see that gap, and
 * neither can a signed-out page check — every route on this app renders the same marketing page
 * when logged out, so those assertions pass whether or not the control exists.
 *
 * 🚨 **This is not a signup door and the spec is one of the things keeping it that way.**
 * `/subscribe` mints accounts; this acts on one that is already signed in. What is asserted
 * here is that the control is reached as somebody, and that it asks the route rather than
 * doing anything locally.
 *
 * ⚠️ **What it cannot assert.** Issuing a handle means creating an account on a real server,
 * which no test may do — `playwright.config.ts` points the suite at `node.invalid`, so the ask
 * always comes back a refusal, and what is checked is that the ask happened and that whatever
 * came back is shown. The three refusals themselves, and which of them applies to which
 * account, are pinned in `hosted-handle-request.test.ts`. **Which card an account sees** — the
 * offer, the issued handle, or the Bluesky form — depends on holding an identity, and this
 * viewer holds none, so only that third of it is walked here.
 */
import { expect, type Page, test } from "@playwright/test";

/** The offer card. Scoped, because "handle" is an ordinary enough word on a settings page. */
const offer = (page: Page) => page.locator(".card").filter({ hasText: "An Anthers Handle" });

/** Answer the availability check without leaving the browser, as its `/subscribe` sibling does. */
async function stubAvailability(page: Page, status: "available" | "taken") {
	await page.route("**/api/atproto/handle-available**", async (route) => {
		const name = new URL(route.request().url()).searchParams.get("name") ?? "";
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ status, handle: `${name}.node.invalid` }),
		});
	});
}

test("an account with no identity is offered one, beside the door it could bring one through", async ({
	page,
}) => {
	await page.goto("/settings");

	await expect(offer(page), "no way to ask for a handle from settings").toBeVisible();

	// ⭐ **Both doors, because an account with neither has two ways to get one** — the same
	// pair `/subscribe` offers a visitor. A settings page showing only one of them would make
	// whichever it dropped unreachable for everybody who already has an account.
	await expect(page.locator(".card").filter({ hasText: "Bluesky / ATProto" })).toBeVisible();

	// The custody sentence. It is the one thing here that is easy to soften into something
	// false, and an offer that described the name without describing who holds the keys would
	// be selling the good half of the arrangement.
	await expect(offer(page)).toContainText(/holds the keys/i);
});

test("the field says whether a name is free, and refuses to ask for one that is not", async ({
	page,
}) => {
	await stubAvailability(page, "taken");
	await page.goto("/settings");

	const card = offer(page);
	await card.getByLabel("The handle you'd like").fill("alice");

	await expect(card.getByText(/alice\.node\.invalid is taken/i)).toBeVisible();
	await expect(card.getByRole("button", { name: "Get this handle" })).toBeDisabled();
});

test("asking goes to the route, and whatever comes back is shown", async ({ page }) => {
	await stubAvailability(page, "available");
	await page.goto("/settings");

	const card = offer(page);
	await card.getByLabel("The handle you'd like").fill("alice");
	await expect(card.getByText(/alice\.node\.invalid is yours/i)).toBeVisible();

	const asked = page.waitForRequest(
		(req) => req.method() === "POST" && req.url().includes("/api/atproto/handle"),
	);
	await card.getByRole("button", { name: "Get this handle" }).click();
	await asked;

	// 🚨 **The refusal has to reach the page.** The node cannot be reached from a test, so this
	// is the failing path by construction — and a card that swallowed the answer would leave
	// somebody pressing a button that appears to do nothing.
	await expect(card.locator(".alert-error")).toBeVisible();
});
