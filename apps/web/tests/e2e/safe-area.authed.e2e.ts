// SPDX-License-Identifier: Apache-2.0
/**
 * The chrome keeps clear of the system bars in a packaged shell.
 *
 * A native launch runs edge-to-edge, so the status bar, camera cutout and gesture bar are
 * painted over the page. The shell measures them and writes `--anthers-inset-*` onto the
 * document (see `anthers-mobile`'s `MainActivity`); the CSS utilities in `globals.css` are
 * what turn those into the header's safe strip and the bottom padding.
 *
 * ⚠️ **The values are injected here rather than waited for.** A browser has no system bars,
 * so `env(safe-area-inset-*)` is zero and the real bridge only exists in the Android shell.
 * What this pins is the web half: given an inset, every shell's chrome claims it in one
 * place. The native half — that Android reports real numbers — is the emulator's check.
 */
import { expect, type Page, test } from "@playwright/test";

const TOP = 24;
const BOTTOM = 16;
const LEFT = 12;

/** Stand in for the values `MainActivity` writes before the app's scripts run. */
async function injectInsets(page: Page, top = TOP, bottom = BOTTOM, left = LEFT) {
	await page.addInitScript(
		({ top, bottom, left }: { top: number; bottom: number; left: number }) => {
			const apply = () => {
				document.documentElement.style.setProperty("--anthers-inset-top", `${top}px`);
				document.documentElement.style.setProperty("--anthers-inset-bottom", `${bottom}px`);
				document.documentElement.style.setProperty("--anthers-inset-left", `${left}px`);
			};
			if (document.documentElement) apply();
			else document.addEventListener("DOMContentLoaded", apply, { once: true });
		},
		{ top, bottom, left },
	);
}

const safeStrip = (page: Page) => page.locator("header .safe-top");
const shell = (page: Page) => page.locator("div.safe-bottom:has(> header)");

test.describe("the shell's chrome claims the safe area", () => {
	test("the marketing shell leaves the status bar and the gesture bar clear", async ({
		browser,
	}) => {
		// ⚠️ Explicitly empty: this project is configured with the authed storage state,
		// and a context that inherits it lands on `/discovery` — which is not a marketing
		// shell, and whose redirect can tear the header down under the measurement.
		const context = await browser.newContext({
			storageState: { cookies: [], origins: [] },
		});
		const page = await context.newPage();
		await injectInsets(page);
		await page.goto("/");

		await expect(safeStrip(page)).toHaveCSS("height", `${TOP}px`);
		// The strip is inside the header, so the header paints under the status bar while
		// the nav row itself starts below it.
		const nav = await page.locator("header .navbar").boundingBox();
		expect(nav, "the nav row rendered").not.toBeNull();
		expect(nav?.y ?? 0, "the nav row starts under the status bar").toBeGreaterThanOrEqual(TOP);
		await expect(shell(page)).toHaveCSS("padding-bottom", `${BOTTOM}px`);
		await expect(shell(page)).toHaveCSS("padding-left", `${LEFT}px`);

		await context.close();
	});

	test("the signed-in shell leaves them clear too", async ({ page }) => {
		await injectInsets(page);
		await page.goto("/discovery");

		await expect(safeStrip(page)).toHaveCSS("height", `${TOP}px`);
		const nav = await page.locator("header .navbar").boundingBox();
		expect(nav?.y ?? 0, "the nav row starts under the status bar").toBeGreaterThanOrEqual(TOP);
		await expect(shell(page)).toHaveCSS("padding-bottom", `${BOTTOM}px`);
		await expect(shell(page)).toHaveCSS("padding-left", `${LEFT}px`);
	});
});
