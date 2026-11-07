// SPDX-License-Identifier: Apache-2.0
/**
 * A Work read signed out sits on the app's quiet meadow, inside the marketing chrome.
 *
 * 🚨 **The bug this pins:** the share link landed on the Work's own address, which renders
 * through the logged-out shell, and that shell's decor is the marketing composition's
 * full-strength vines and floor. The quiet, blurred layer existed only in the signed-in
 * shell. A screenshot is the only other way to see it, and the two shells look equally
 * "themed" until the art is over the text.
 *
 * The scope is the surface rather than the `?share=` parameter: a reader arriving from a
 * search result sees the same page, so every signed-out Work does this. Marketing pages
 * keep their own composition, which the second test pins.
 *
 * Signed out by clearing this context's cookies — the `authed` project exists for the
 * media fixture's seed, and the page under test carries no session.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { expect, test } from "./fixtures";

const CLIP = mediaFixtureWork("video");
const backdrop = (page: import("@playwright/test").Page) => page.locator("[data-meadow-backdrop]");

test("a Work read signed out mounts the quiet backdrop, not the marketing composition", async ({
	page,
	context,
}) => {
	await context.clearCookies();
	await page.goto(`/works/${CLIP.slug}-${CLIP.publicId}`);

	const layer = backdrop(page);
	await expect(layer, "the signed-out Work mounted no quiet backdrop").toBeAttached();

	const style = await layer.evaluate((el) => {
		const s = getComputedStyle(el);
		return {
			opacity: s.opacity,
			filter: s.filter,
			zIndex: s.zIndex,
			pointerEvents: s.pointerEvents,
		};
	});
	expect(parseFloat(style.opacity), "the quiet layer lost its reduced opacity").toBeCloseTo(0.15);
	expect(style.filter, "the quiet layer lost its blur").toContain("blur(6px)");
	expect(parseInt(style.zIndex, 10), "the layer must paint beneath the page").toBeLessThan(0);
	expect(style.pointerEvents).toBe("none");

	// The marketing chrome is the point of the combination: header above, footer below,
	// quiet art behind.
	await expect(page.getByRole("banner")).toBeVisible();
	await expect(page.getByRole("contentinfo")).toBeVisible();
});

test("a marketing page keeps the full-strength composition", async ({ page }) => {
	await page.goto("/for-creators");
	await expect(page.getByRole("banner")).toBeVisible();
	await expect(backdrop(page), "the quiet layer leaked onto a marketing page").toHaveCount(0);
});
