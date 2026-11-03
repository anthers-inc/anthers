// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in app's phone navigation is a bottom tab bar, not a drawer.
 *
 * Library, Discovery and Settings were all behind the sidebar's chevron below `md`, so every
 * destination on the surface a reader uses most cost two taps. The bar puts them one tap away
 * and leaves the drawer for filters and page sections. It is a phone-only third shape: the
 * desktop sidebar is unchanged, and the Studio keeps the drawer because its seven places are
 * a tool's nav rather than a reader's.
 *
 * ⚠️ **The reserved-space assertion is the one that catches the invisible half.** A fixed bar
 * over a scroll area looks right until the last row of a page is underneath it; `main`'s
 * bottom padding is the contract, and a bar with no space reserved would still pass every
 * "is it visible" check.
 */
import { MEDIA_FIXTURE_PROJECT, MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { creatorProjectUrl } from "@anthers/web-shared/profile";
import { expect, type Page, test } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const tabs = (page: Page) => page.getByRole("navigation", { name: "Anthers tabs" });
const ALBUM_URL = creatorProjectUrl(MEDIA_FIXTURE_USERNAME, MEDIA_FIXTURE_PROJECT.slug);

test.describe("on a phone", () => {
	test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

	test("the three tabs are one tap away, and the page reserves their height", async ({ page }) => {
		await page.goto("/discovery");

		const bar = tabs(page);
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("link")).toHaveCount(3);
		await expect(bar.getByRole("link", { name: "Discovery" })).toHaveAttribute(
			"aria-current",
			"page",
		);

		// The shell reserves the bar's height; padding-bottom transitions in when it mounts,
		// so read the settled value rather than a frame mid-animation.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const main = document.querySelector("main");
					return main ? getComputedStyle(main).paddingBottom : null;
				}),
			)
			.toBe("64px");
	});

	test("a tab navigates without opening the drawer", async ({ page }) => {
		await page.goto("/discovery");
		await tabs(page).getByRole("link", { name: "Library" }).click();

		await expect(page).toHaveURL(/\/library/);
		await expect(tabs(page).getByRole("link", { name: "Library" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		const drawer = await page.evaluate(
			() => document.querySelector("aside")?.getBoundingClientRect().width ?? -1,
		);
		expect(drawer, "tapping a tab left the drawer open over the page").toBe(0);
	});

	test("the drawer takes the bar's place while it is open", async ({ page }) => {
		await page.goto("/discovery");
		await expect(tabs(page)).toBeVisible();

		await page.getByRole("button", { name: "Toggle sidebar" }).click();
		await expect(tabs(page), "the drawer and the tab bar competed for the same tap").toBeHidden();

		await page
			.getByRole("button", { name: "Close sidebar" })
			.click({ position: { x: PHONE.width - 30, y: 300 } });
		await expect(tabs(page)).toBeVisible();
	});

	test("Settings is the third tab", async ({ page }) => {
		await page.goto("/discovery");
		await tabs(page).getByRole("link", { name: "Settings" }).click();

		await expect(page).toHaveURL(/\/settings/);
		await expect(tabs(page).getByRole("link", { name: "Settings" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	});

	test("the player bar stacks above the tabs instead of covering them", async ({ page }) => {
		await page.goto(ALBUM_URL);
		await page.getByRole("button", { name: "Play", exact: true }).first().click();
		await expect(page.locator(".player-bar-root")).toBeVisible();

		// The padding is transitioned when the track starts, so read the settled value.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const main = document.querySelector("main");
					return main ? getComputedStyle(main).paddingBottom : null;
				}),
			)
			.toBe("128px");

		const geometry = await page.evaluate(() => {
			const player = document.querySelector(".player-bar-root")?.getBoundingClientRect();
			const bar = document.querySelector("[data-phone-tabs]")?.getBoundingClientRect();
			return {
				playerBottom: player?.bottom ?? -1,
				tabsTop: bar?.top ?? -1,
				playerStyle: getComputedStyle(document.querySelector(".player-bar-root") as Element).bottom,
			};
		});
		// They meet at the same line: the player bar sits on top of the tab bar, not over it.
		expect(geometry.playerBottom).toBeGreaterThanOrEqual(geometry.tabsTop - 1);
		expect(geometry.tabsTop).toBeGreaterThan(0);
		// The player bar's own safe-bottom padding is cleared so there is no gap between the
		// two fixed bars; the tab bar owns the inset on this shell.
		expect(geometry.playerStyle).toBe("64px");
	});
});

test.describe("on a desktop", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("the phone tabs are not in the desktop shell", async ({ page }) => {
		await page.goto("/discovery");
		await expect(tabs(page)).toBeHidden();
	});
});
