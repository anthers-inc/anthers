// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Sticker batches, and the rules that keep the money and the art honest.
 *
 * 🚨 **The art determines the amount, and nothing is ever retired from giving.** Every
 * assertion here defends one of those: a batch that priced two Stickers the same would
 * break the rule that the drawing tells you the cost, and a key that stopped resolving
 * would erase a gift somebody paid for.
 */

import { describe, expect, it } from "bun:test";
import { STICKER_DENOMINATIONS } from "./constants";
import {
	ALL_STICKER_ART,
	batchesAreWellFormed,
	batchProblems,
	CURRENT_BATCH,
	isGiveable,
	STICKER_BATCHES,
	stickerAmount,
	stickerArt,
} from "./stickers";

describe("the batches", () => {
	it("🚨 are well formed, and say precisely what is wrong when they are not", () => {
		expect(batchProblems()).toEqual([]);
		expect(batchesAreWellFormed()).toBe(true);
	});

	it("⭐ hold one Sticker per denomination, so the drawing tells you the amount", () => {
		// Three per batch is the whole reason a reader never has to compare numbers. Two at
		// the same price would leave the elaborateness signal ambiguous.
		for (const batch of STICKER_BATCHES) {
			expect(batch.art.length).toBe(STICKER_DENOMINATIONS.length);
			expect([...batch.art.map((a) => a.amount)].sort((a, b) => a - b)).toEqual(
				[...STICKER_DENOMINATIONS].sort((a, b) => a - b),
			);
		}
	});

	it("⭐ run simple to elaborate within each batch", () => {
		for (const batch of STICKER_BATCHES) {
			const amounts = batch.art.map((a) => a.amount);
			expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
		}
	});

	it("never reuse a key or an emblem across batches", () => {
		expect(new Set(ALL_STICKER_ART.map((a) => a.key)).size).toBe(ALL_STICKER_ART.length);
		expect(new Set(ALL_STICKER_ART.map((a) => a.emblem)).size).toBe(ALL_STICKER_ART.length);
	});

	it("lead with the newest batch", () => {
		expect(CURRENT_BATCH).toBe(STICKER_BATCHES[0] as (typeof STICKER_BATCHES)[number]);
		const released = STICKER_BATCHES.map((b) => b.released);
		expect(released).toEqual([...released].sort().reverse());
	});
});

describe("giving and drawing", () => {
	const known = ALL_STICKER_ART[0] as (typeof ALL_STICKER_ART)[number];

	it("reads the amount off the art and nowhere else", () => {
		expect(stickerAmount(known.key)).toBe(known.amount);
		expect(stickerAmount("nothing-like-this")).toBeUndefined();
	});

	it("🚨 refuses a key that is not in any batch, including near misses", () => {
		expect(isGiveable(known.key)).toBe(true);
		for (const bad of [known.key.toUpperCase(), ` ${known.key}`, "", null, undefined]) {
			expect(isGiveable(bad)).toBe(false);
		}
	});

	it("⭐ keeps every released Sticker giveable, however old", () => {
		// Parker, 2026-09-04: nothing retires. A Sticker somebody liked never becomes one
		// they may no longer send — the cost is a picker that grows, which the interface
		// carries by leading with the current batch.
		for (const art of ALL_STICKER_ART) expect(isGiveable(art.key)).toBe(true);
	});

	it("⚠️ draws art for every key it will ever accept", () => {
		// A row outlives everything. If `isGiveable` ever narrows again, `stickerArt` must
		// not — otherwise a stored Sticker renders as nothing, which is taking back a gift.
		for (const art of ALL_STICKER_ART) expect(stickerArt(art.key)).toEqual(art);
		expect(stickerArt(null)).toBeUndefined();
		expect(stickerArt("a-season-that-never-existed")).toBeUndefined();
	});
});
