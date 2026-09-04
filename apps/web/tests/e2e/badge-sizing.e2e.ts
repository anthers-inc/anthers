// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A Badge's art fills its Badge, at every size the Badge is drawn at.
 *
 * 🚨 **This measures pixels because the defect it guards is invisible to everything else.**
 * Anthers' rungs sized their emoji with `font-size: 46%`, which is a share of the INHERITED
 * FONT rather than of the badge — so the emblem drew at roughly seven pixels inside a
 * ninety-six pixel patch, and grew not at all when the patch did. Nothing threw, no test
 * failed, and the markup read as though it meant 46% of the badge. A ratio is the only
 * assertion that separates "sized to the badge" from "sized to something else that happens
 * to be small".
 *
 * ⭐ **Two sizes, and that is the whole design.** One measurement cannot tell a foreground
 * that scales from a fixed one that happens to look right at the size you checked. The same
 * ratio at `h-24` on `/for-users` and `h-14` on `/subscribe` can only come from a foreground
 * measured against its badge, so anything absolute fails the second half even if it passes
 * the first.
 *
 * ⚠️ **Measured as rendered pixels, never as the value in the markup.** An SVG `font-size`
 * is in viewBox units, so `getComputedStyle` reports the same number on a 96-pixel badge and
 * a 56-pixel one — it is constant *because* the sizing is correct, and reading it would call
 * a working badge broken. Only the box the browser actually paints answers the question.
 *
 * ⭐ **It needs no API, so it runs in the static `chromium` project.** Both routes render
 * the ladder from `BADGE_ART` with nothing fetched.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The share of the badge's width its art must cover.
 *
 * A circle's `emblemBox` is 52% of the badge, and both branches land near it: an emblem
 * fills the box, and an emoji is set at 0.8 of it and draws 1.25× its font-size. The floor
 * sits well under that because a machine with no emoji font paints a narrower fallback
 * glyph, and this is asserting proportion rather than a pixel-exact rendering. The defect it
 * replaced measured about 0.07, so there is a wide gap either way.
 */
const MIN_SHARE = 0.22;

/** Above this the art would be running into the edging, which is 9% of the badge a side. */
const MAX_SHARE = 0.75;

const badgeNamed = (page: Page, name: string) =>
	page.getByRole("img", { name: `${name} badge` }).first();

/** The badge's rendered width, and the size of the art sitting on it as a share of it. */
async function artShare(badge: Locator) {
	const box = await badge.boundingBox();
	if (!box) throw new Error("the badge did not render");
	const art = await badge.locator("svg text, img, .brand-glyph").first().boundingBox();
	if (!art) throw new Error("the badge rendered with no art on it");
	return { share: art.width / box.width, badgeWidth: box.width };
}

test.describe("Badge art is sized to its Badge", () => {
	for (const [route, name] of [
		["/for-users", "Blossom"],
		["/subscribe", "Sprout"],
	] as const) {
		test(`🚨 the art fills its share of the Badge on ${route}`, async ({ page }) => {
			await page.goto(route);
			const badge = badgeNamed(page, name);
			await expect(badge).toBeVisible();
			const { share, badgeWidth } = await artShare(badge);
			const seen = `${name} art covers ${(share * 100).toFixed(1)}% of a ${badgeWidth}px badge`;
			expect(badgeWidth, "the badge itself has to have rendered at a real size").toBeGreaterThan(
				30,
			);
			expect(share, seen).toBeGreaterThan(MIN_SHARE);
			expect(share, seen).toBeLessThan(MAX_SHARE);
		});
	}

	test("⭐ the same art fills the same share at two different Badge sizes", async ({ page }) => {
		await page.goto("/for-users");
		const big = await artShare(badgeNamed(page, "Sprout"));
		await page.goto("/subscribe");
		const small = await artShare(badgeNamed(page, "Sprout"));
		expect(
			small.badgeWidth,
			"the two routes have to draw the badge at different sizes",
		).toBeLessThan(big.badgeWidth);
		expect(
			Math.abs(big.share - small.share),
			`${big.share.toFixed(3)} at ${big.badgeWidth}px vs ${small.share.toFixed(3)} at ${small.badgeWidth}px`,
		).toBeLessThan(0.05);
	});
});
