// SPDX-License-Identifier: Apache-2.0
/**
 * A creator whose identity is held elsewhere says no to the publishing permission at their own
 * server's consent screen, is told what that means everywhere they go, and gives it.
 *
 * 🚨 **Deny is walked for real, on the session's Bluesky stand-in**, because a consent screen
 * declines by refusing the whole authorization rather than by granting less — and the API had only
 * ever been tested against the narrower grant, so a real Deny showed a signed-in creator "sign-in
 * didn't work". What the browser proves beyond the API suites is that the refusal, the banner and
 * the Studio settings card all agree, and that the banner is what gets somebody to the fix.
 *
 * ⚠️ **It runs on `127.0.0.1`**, for the reason `bluesky-door.e2e.ts` gives: a loopback OAuth
 * client's redirect lands on a literal IP, and cookies are host-scoped.
 */
import type { Page } from "@playwright/test";
import { emailedCode, expect, test } from "./fixtures";

const ORIGIN = `http://127.0.0.1:${process.env.PREVIEW_PORT ?? 4173}`;
const API = `http://127.0.0.1:${process.env.API_PORT ?? 8000}`;

const BANNER_TEXT = "doesn't have your permission to publish";

/** The stand-in's own authorization pages: signing in when it asks, then the consent. */
async function atConsent(page: Page, password: string): Promise<void> {
	await page.waitForURL(/\/oauth\/authorize/);
	const passwordField = page.locator('input[name="password"]');
	if (await passwordField.isVisible().catch(() => false)) {
		await passwordField.fill(password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
	}
}

test("a creator who denies the publishing permission is warned until they give it", async ({
	page,
}) => {
	const server = process.env.BLUESKY_STAND_IN_URL;
	expect(server, "the browser suite runs with the session's Bluesky stand-in").toBeTruthy();

	const name = `pp${Date.now().toString(36)}`;
	const handle = `${name}.bsky.test`;
	const address = `${name}@example.com`;
	const password = crypto.randomUUID();
	const created = await fetch(`${server}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle, email: address, password }),
	});
	expect(created.status).toBe(200);

	// An account holding the brought identity, made the way anybody makes one.
	await page.goto(`${ORIGIN}/subscribe`);
	const card = page.locator('[data-signup="top"]');
	await card.getByRole("tab", { name: "Bluesky", exact: true }).click();
	await card.getByLabel("Bluesky handle").fill(handle);
	await card.getByRole("button", { name: /sign up with bluesky/i }).click();
	await atConsent(page, password);
	await page.getByRole("button", { name: "Authorize", exact: true }).click();
	await page.waitForURL(`${ORIGIN}/finish`);
	await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();
	await page.keyboard.type(await emailedCode(address));
	await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
	await page.locator("#welcome-username").fill(name);
	await page.getByRole("button", { name: /email me a code each time/i }).click();
	await page.getByRole("checkbox", { name: /13 or older/i }).check();
	await page.getByRole("button", { name: "Finish setting up" }).click();
	await expect(page.getByText(`You're in, @${name}`)).toBeVisible({ timeout: 15_000 });

	// Becoming a creator asks for the permission at once, and they say no.
	await page.goto(`${ORIGIN}/settings`);
	await page.getByRole("checkbox", { name: /enable creator mode/i }).check();
	await atConsent(page, password);
	await page.getByRole("button", { name: /deny/i }).click();

	// Studio settings says what it means, and carries the one button — the banner stays off here.
	await expect(page).toHaveURL(/\/studio\/settings\?publishing=declined/, { timeout: 15_000 });
	await expect(page.getByText("No permission was given.")).toBeVisible();
	await expect(
		page.getByText(/You can't release Works or publish posts and projects/),
	).toBeVisible();
	// Settled first, so the banner's own request has answered before its absence is believed.
	await page.waitForLoadState("networkidle");
	await expect(page.getByRole("button", { name: "Give Permission" })).toHaveCount(1);
	await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);

	// Anywhere else, the banner, which is what leads back to the consent screen.
	await page.goto(`${ORIGIN}/studio`);
	const banner = page.getByRole("alert").filter({ hasText: BANNER_TEXT });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText(`@${handle}`);
	await banner.getByRole("button", { name: "Give Permission" }).click();
	await atConsent(page, password);
	await page.getByRole("button", { name: "Authorize", exact: true }).click();

	await expect(page).toHaveURL(/\/studio\/settings\?publishing=on/, { timeout: 15_000 });
	await expect(page.getByText("Your records are on their way to your repository.")).toBeVisible();
	const state = (await (await page.request.get(`${API}/api/atproto/publishing`)).json()) as {
		route: string;
	};
	expect(state.route).toBe("granted");

	await page.goto(`${ORIGIN}/studio`);
	await page.waitForLoadState("networkidle");
	await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);
});
