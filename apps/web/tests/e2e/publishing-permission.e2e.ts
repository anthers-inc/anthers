// SPDX-License-Identifier: Apache-2.0
/**
 * Somebody whose identity is held elsewhere loses the permission Anthers writes their records
 * with, is told what that means wherever they go, and gives it back from the banner.
 *
 * 🚨 **Deny is walked for real, on the session's Bluesky stand-in**, because a consent screen
 * declines by refusing the whole authorization rather than by granting less — and the API had only
 * ever been tested against the narrower grant, so a real Deny showed a signed-in creator "sign-in
 * didn't work". What the browser proves beyond the API suites is that the refusal, the banner and
 * the controls all agree, and that the banner is what gets somebody to the fix.
 *
 * ⚠️ **It runs on `127.0.0.1`**, for the reason `bluesky-door.e2e.ts` gives: a loopback OAuth
 * client's redirect lands on a literal IP, and cookies are host-scoped.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "@anthers/db/client";
import { atprotoSessions, users } from "@anthers/db/schema";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { emailedCode, expect, test } from "./fixtures";

const ORIGIN = `http://127.0.0.1:${process.env.PREVIEW_PORT ?? 4173}`;
const API = `http://127.0.0.1:${process.env.API_PORT ?? 8000}`;
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const BANNER_TEXT = "doesn't have your permission to write";

/** The stand-in's own authorization pages: signing in when it asks, then the consent. */
async function atConsent(page: Page, password: string): Promise<void> {
	await page.waitForURL(/\/oauth\/authorize/);
	const passwordField = page.locator('input[name="password"]');
	if (await passwordField.isVisible().catch(() => false)) {
		await passwordField.fill(password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
	}
}

/**
 * An account holding an identity on the Bluesky stand-in, made the way anybody makes one: the
 * Bluesky door, its consent, the emailed code and a username.
 */
async function signUpWithBluesky(
	page: Page,
	prefix: string,
): Promise<{ name: string; handle: string; password: string; did: string }> {
	const server = process.env.BLUESKY_STAND_IN_URL;
	expect(server, "the browser suite runs with the session's Bluesky stand-in").toBeTruthy();

	const name = `${prefix}${Date.now().toString(36)}`;
	const handle = `${name}.bsky.test`;
	const address = `${name}@example.com`;
	const password = crypto.randomUUID();
	const created = await fetch(`${server}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle, email: address, password }),
	});
	expect(created.status).toBe(200);
	const { did } = (await created.json()) as { did: string };

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
	return { name, handle, password, did };
}

test("a creator who denies the publishing permission is warned until they give it", async ({
	page,
}) => {
	const { handle, password } = await signUpWithBluesky(page, "pp");

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

test("a reader whose permission lapsed cannot follow until they give it, and comes back to the page", async ({
	page,
}) => {
	const { did, password } = await signUpWithBluesky(page, "pr");

	// Somebody to follow, and a lapse: the stored grant narrowed to identity alone, which is where
	// a permission withdrawn at the reader's own server leaves it.
	const creator = `prc${Date.now().toString(36)}`;
	execFileSync("bun", ["run", "db:local-account", "--username", creator, "--creator"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	await db.update(atprotoSessions).set({ scope: "atproto" }).where(eq(atprotoSessions.did, did));

	await page.goto(`${ORIGIN}/@${creator}`);
	const banner = page.getByRole("alert").filter({ hasText: BANNER_TEXT });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("you can't comment, review, vote or follow");
	const follow = page.getByRole("button", { name: "Follow", exact: true });
	await expect(follow).toBeDisabled();

	await banner.getByRole("button", { name: "Give Permission" }).click();
	await atConsent(page, password);
	await page.getByRole("button", { name: "Authorize", exact: true }).click();

	// Back where they were rather than in a Studio a reader does not have.
	await expect(page).toHaveURL(new RegExp(`/@${creator}$`), { timeout: 15_000 });
	await page.waitForLoadState("networkidle");
	await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);
	await expect(follow).toBeEnabled();
	await follow.click();
	await expect(page.getByRole("button", { name: "Following", exact: true })).toBeVisible();
});

// 🚨 A delay, never a problem to fix: the banner says what waits and that nothing else does.
test("somebody whose identity's server is down is told their records are late, and nothing more", async ({
	page,
}) => {
	const { did } = await signUpWithBluesky(page, "pd");
	// A port nothing listens on, which a ping finds refused at once.
	await db
		.update(users)
		.set({ atprotoPdsUrl: "http://127.0.0.1:9" })
		.where(eq(users.atprotoDid, did));

	await page.goto(`${ORIGIN}/feed`);
	const notice = page.getByRole("status").filter({ hasText: "isn't answering right now" });
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("reach the network late");
	await expect(notice).toContainText("Everything on Anthers keeps working");
	// Not Bluesky's server, so there is no status page to offer, and nothing to press.
	await expect(notice.getByRole("link")).toHaveCount(0);
	await expect(notice.getByRole("button")).toHaveCount(0);
	await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);
});
