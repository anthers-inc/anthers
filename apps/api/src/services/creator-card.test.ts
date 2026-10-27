// SPDX-License-Identifier: Apache-2.0
/**
 * The card a shared profile's link unfurls with.
 *
 * The composition has no page to look at and no unfurler in the suite, so what is asserted
 * here is geometry and the two fallbacks that decide what a creator without pictures gets:
 * the card is the size every unfurler crops to, a banner covers the ground, and a portrait is
 * cut to a disc so the ground shows at its corners.
 */

import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { CREATOR_CARD_HEIGHT, CREATOR_CARD_WIDTH, composeCreatorCard } from "./creator-card.js";

/** A flat image of the given color, standing in for a creator's upload. */
async function image(width: number, height: number, color: string): Promise<Buffer> {
	return await sharp({ create: { width, height, channels: 3, background: color } })
		.png()
		.toBuffer();
}

async function pixel(bytes: Buffer, left: number, top: number) {
	const { data } = await sharp(bytes)
		.extract({ left, top, width: 1, height: 1 })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return [data[0], data[1], data[2]];
}

// A portrait on its own is the larger, centered one: 300px in the card's field, with the
// wordmark's band kept clear beneath it.
const PORTRAIT_ALONE = 300;
const PORTRAIT_LEFT = (CREATOR_CARD_WIDTH - PORTRAIT_ALONE) / 2;
const PORTRAIT_TOP = (CREATOR_CARD_HEIGHT - 46 - 64) / 2 + 46 / 2 - PORTRAIT_ALONE / 2;

describe("composeCreatorCard", () => {
	it("renders the card's own dimensions", async () => {
		const card = await composeCreatorCard({
			banner: await image(1500, 500, "#0d1f12"),
			portrait: await image(400, 400, "#f9c370"),
		});
		const meta = await sharp(card).metadata();
		expect(meta.format).toBe("png");
		expect(meta.width).toBe(CREATOR_CARD_WIDTH);
		expect(meta.height).toBe(CREATOR_CARD_HEIGHT);
	});

	it("covers the card with the banner rather than padding it", async () => {
		const card = await composeCreatorCard({
			banner: await image(1500, 500, "#0d1f12"),
			portrait: null,
		});
		// The scrim is transparent at the top of the card, so the banner's own field shows.
		const [r, g, b] = await pixel(card, 600, 8);
		expect([r, g, b]).toEqual([13, 31, 18]);
	});

	it("draws the brand's cream ground when a creator has no banner", async () => {
		const card = await composeCreatorCard({ banner: null, portrait: null });
		const [r, g, b] = await pixel(card, 4, 4);
		expect([r, g, b]).toEqual([245, 243, 227]);
	});

	it("cuts the portrait to a disc, so the ground shows at its corner", async () => {
		const card = await composeCreatorCard({
			banner: null,
			portrait: await image(400, 400, "#f9c370"),
		});
		// The square's top-left corner lies outside the inscribed circle.
		expect(await pixel(card, PORTRAIT_LEFT + 2, PORTRAIT_TOP + 2)).toEqual([245, 243, 227]);
		// Its middle is the portrait itself.
		expect(await pixel(card, PORTRAIT_LEFT + 92, PORTRAIT_TOP + 92)).toEqual([249, 195, 112]);
	});

	it("still renders a card for a creator with no pictures at all", async () => {
		const card = await composeCreatorCard({ banner: null, portrait: null });
		const meta = await sharp(card).metadata();
		expect(meta.width).toBe(CREATOR_CARD_WIDTH);
		expect(meta.height).toBe(CREATOR_CARD_HEIGHT);
	});
});
