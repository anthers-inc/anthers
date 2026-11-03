// SPDX-License-Identifier: Apache-2.0
/**
 * What `/` means in a packaged shell.
 *
 * A shell has no address bar and no way to type its way back to the site, so launching
 * into the marketing pitch is the wrong door for somebody who already installed the app.
 * A native launch opens at the app's front door instead — the sign-in handoff when signed
 * out, the account's starting tab when signed in — while a browser keeps the marketing
 * homepage it has always had.
 *
 * ⚠️ **The signed-in half needs the shell's bearer transport, not just the cookie.** A
 * native runtime carries the session in `Authorization: Bearer` (there is no cookie in
 * `tauri://localhost`), so this injects the runtime AND hands it the token the authed
 * project's storage state already minted. Injecting only `platform` would leave every API
 * call signed out and the test would pass on the sign-in surface for the wrong reason.
 */
import { expect, type Page, test } from "@playwright/test";
import { API_URL } from "./fixtures";

/** The runtime `anthers-mobile` injects before app JS, reproduced for the browser. */
async function injectAndroidRuntime(page: Page, token: string | null) {
	await page.addInitScript(
		({ apiBaseUrl, token }: { apiBaseUrl: string; token: string | null }) => {
			let current = token;
			(globalThis as { __ANTHERS_NATIVE__?: unknown }).__ANTHERS_NATIVE__ = {
				platform: "android",
				apiBaseUrl,
				getToken: () => current,
				setToken: (next: string | null) => {
					current = next;
				},
			};
		},
		{ apiBaseUrl: API_URL, token },
	);
}

const signInButton = (page: Page) =>
	page.getByRole("button", { name: /sign in with your identity server/i });
const marketingHeading = (page: Page) => page.getByRole("heading", { name: /creative garden/i });

test.describe("the app's launch destination", () => {
	test("a signed-out shell opens at the sign-in handoff, not the marketing page", async ({
		browser,
	}) => {
		const context = await browser.newContext({
			storageState: { cookies: [], origins: [] },
		});
		const page = await context.newPage();
		await injectAndroidRuntime(page, null);
		await page.goto("/");

		await expect(signInButton(page)).toBeVisible();
		await expect(page.getByText(/sign in through your browser/i)).toBeVisible();
		// The pitch is the thing being replaced, so its hero is the assertion that it did
		// not render. It would also be visible on a shell that ignored `isNative()`.
		await expect(marketingHeading(page)).toHaveCount(0);
		await expect(page).toHaveURL(/\/$/);

		await context.close();
	});

	test("a browser still gets the marketing homepage", async ({ browser }) => {
		// ⚠️ Explicitly empty: this project is configured with the authed storage state, and
		// a context that inherits it would land on `/discovery` and call that "a browser".
		const context = await browser.newContext({
			storageState: { cookies: [], origins: [] },
		});
		const page = await context.newPage();
		await page.goto("/");

		await expect(marketingHeading(page)).toBeVisible();
		await expect(signInButton(page)).toHaveCount(0);

		await context.close();
	});

	test("a signed-in shell opens at the account's starting tab", async ({ page }) => {
		const session = (await page.context().cookies()).find((c) => c.name === "session")?.value;
		expect(session, "the authed project's storage state carries a session").toBeTruthy();
		await injectAndroidRuntime(page, session ?? null);
		// A phone must not inherit the desktop's Studio preference: it is per-install and
		// the desktop's alone. Storing it here makes the redirect prove that, not just that
		// the default happens to agree.
		await page.addInitScript(() => localStorage.setItem("anthers_desktop_home", "studio"));

		await page.goto("/");

		// Discovery is the walker's starting tab (the prefs projects restore it before this
		// one runs), so the landing is the account's answer rather than a fixed app route.
		await expect(page).toHaveURL(/\/discovery$/);
		await expect(page.getByRole("navigation", { name: "Anthers" })).toBeVisible();
		await expect(signInButton(page)).toHaveCount(0);
	});
});
