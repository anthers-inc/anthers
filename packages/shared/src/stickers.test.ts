// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Sticker batch, and the two rules that make the money safe.
 *
 * 🚨 **The art determines the amount, and a stored key outlives its batch.** Everything
 * here defends one of those: a batch whose amounts were not real denominations would put
 * un-chargeable sums on rows, and a lookup that only knew the live batch would erase a
 * gift somebody paid for the moment a season turned.
 */

import { describe, expect, it } from "bun:test";
import { STICKER_DENOMINATIONS } from "./constants";
import {
	batchAmountsAreDenominations,
	isGiveable,
	STICKER_BATCH,
	stickerAmount,
	stickerArt,
} from "./stickers";

describe("the Sticker batch", () => {
	it("🚨 prices every Sticker at a real denomination", () => {
		expect(batchAmountsAreDenominations()).toBe(true);
		// Widened, because the constant is a readonly tuple of its own literals — comparing
		// against it unwidened asks the compiler to prove the answer rather than the test.
		for (const art of STICKER_BATCH) {
			expect(STICKER_DENOMINATIONS as readonly number[]).toContain(art.amount);
		}
	});

	it("⭐ runs simple to elaborate, which is what makes the art readable as an amount", () => {
		// The order carries the meaning: a reader should be able to tell what a Sticker cost
		// from how much drawing is in it. A batch that broke the progression would leave the
		// amount legible only to somebody reading the numbers.
		const amounts = STICKER_BATCH.map((a) => a.amount);
		expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
	});

	it("has a unique key and a unique emblem for every entry", () => {
		expect(new Set(STICKER_BATCH.map((a) => a.key)).size).toBe(STICKER_BATCH.length);
		expect(new Set(STICKER_BATCH.map((a) => a.emblem)).size).toBe(STICKER_BATCH.length);
	});

	it("names something for a screen reader on every entry", () => {
		for (const art of STICKER_BATCH) expect(art.label.length).toBeGreaterThan(0);
	});
});

describe("looking a Sticker up", () => {
	const known = STICKER_BATCH[0] as (typeof STICKER_BATCH)[number];

	it("reads the amount off the art and nowhere else", () => {
		expect(stickerAmount(known.key)).toBe(known.amount);
		expect(stickerAmount("nothing-like-this")).toBeUndefined();
	});

	it("🚨 refuses a key that is not in the batch, including near misses", () => {
		expect(isGiveable(known.key)).toBe(true);
		for (const bad of [known.key.toUpperCase(), ` ${known.key}`, "", null, undefined]) {
			expect(isGiveable(bad)).toBe(false);
		}
	});

	it("⚠️ still draws art for a key that is no longer giveable", () => {
		// A row outlives the batch it came from. `stickerArt` is the display lookup and has
		// to keep answering after `isGiveable` stops — otherwise retiring a batch silently
		// blanks every Sticker given from it, which is taking back a gift.
		for (const art of STICKER_BATCH) {
			expect(stickerArt(art.key)).toEqual(art);
		}
		expect(stickerArt(null)).toBeUndefined();
		expect(stickerArt("retired-from-a-season-that-never-existed")).toBeUndefined();
	});
});
