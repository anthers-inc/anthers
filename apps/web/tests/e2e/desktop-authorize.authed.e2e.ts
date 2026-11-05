// SPDX-License-Identifier: Apache-2.0
/**
 * The browser half of the app's sign-in, as a phone meets it.
 *
 * The page is deliberately kept: it is where a browser with an Anthers session mints the
 * app's code directly, where one without starts the OAuth at the handle's server, and the
 * only surface that can explain a refusal after the app is behind the browser. This pins the
 * one piece of copy that has to know which device it is talking to.
 */
import { expect, test } from "@playwright/test";

test("an expired sign-in request names the app, not the desktop, on a phone", async ({ page }) => {
	await page.goto("/desktop/authorize?challenge=expired-fixture&redirect=mobile");

	await expect(page.getByRole("heading", { name: /expired/i })).toBeVisible();
	await expect(page.getByText(/start again from the anthers app on your phone/i)).toBeVisible();
	await expect(page.getByText(/anthers desktop on your computer/i)).toHaveCount(0);
});
