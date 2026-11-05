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
	page.getByRole("button", { name: /continue with your identity server/i });
const handleField = (page: Page) => page.getByLabel(/your handle/i);
const marketingHeading = (page: Page) => page.getByRole("heading", { name: /creative garden/i });

/**
 * A shell that has an enrollment waiting to be redeemed, with the answer deliberately late.
 *
 * The mobile shell's `has_pending_sign_in` is an invoke, so the sign-in screen cannot know
 * its answer on the first paint. This reproduces that window: the command answers after
 * enough of a delay to see what the screen shows while it is in flight, and `await_sign_in`
 * never resolves so the waiting state stays put. `__TAURI_INTERNALS__` is the seam the
 * Tauri API reads; the component never knows it is in a browser.
 */
async function injectPendingSignInRuntime(page: Page) {
	await injectAndroidRuntime(page, null);
	await page.addInitScript(() => {
		(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke: (cmd: string) => {
				if (cmd === "has_pending_sign_in") {
					return new Promise((resolve) => setTimeout(() => resolve(true), 1_000));
				}
				if (cmd === "await_sign_in") return new Promise(() => {});
				if (cmd === "session_token" || cmd === "take_pending_code") {
					return Promise.resolve(null);
				}
				return Promise.resolve(null);
			},
			transformCallback: () => 1,
			unregisterCallback: () => {},
		};
	});
}

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
		// The app asks for the handle itself, exactly as `/login` does: the browser leg starts
		// at the person's own identity server, so nothing about the flow depends on this phone
		// already holding a session in its browser.
		await expect(handleField(page)).toBeVisible();
		await expect(page.getByText(/your identity server confirms it's you/i)).toBeVisible();
		// The pitch is the thing being replaced, so its hero is the assertion that it did
		// not render. It would also be visible on a shell that ignored `isNative()`.
		await expect(marketingHeading(page)).toHaveCount(0);
		await expect(page).toHaveURL(/\/$/);

		await context.close();
	});

	test("a launch with a pending sign-in never paints the handle form", async ({ browser }) => {
		const context = await browser.newContext({
			storageState: { cookies: [], origins: [] },
		});
		const page = await context.newPage();
		await injectPendingSignInRuntime(page);
		await page.goto("/");

		// 🚨 The shell has not answered `has_pending_sign_in` yet. The handle form used to be
		// the first paint here, which is the half second after coming back from the browser
		// that read as a failed sign-in. The check is the only thing on screen until the
		// command answers.
		await expect(handleField(page)).toHaveCount(0);
		await expect(signInButton(page)).toHaveCount(0);
		await expect(page.getByText(/checking sign-in/i)).toBeVisible();

		// The answer was yes: the screen moves to the waiting state, still without the form.
		await expect(page.getByText(/finish signing in in your browser/i)).toBeVisible();
		await expect(handleField(page)).toHaveCount(0);
		await expect(signInButton(page)).toHaveCount(0);

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
