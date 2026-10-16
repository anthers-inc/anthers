// SPDX-License-Identifier: Apache-2.0
//
// The allowance math the Sticker picker shows the giver: how many of each denomination
// they still have left this month. A wrong direction here is never a crash — it is a
// picker offering a Sticker the server refuses, or refusing one it would accept, and it
// reads to the giver as Anthers' arithmetic being arbitrary.
import { describe, expect, test } from "bun:test";
import { stickersLeftFor } from "./StickerBar";

describe("how many Stickers of one denomination the allowance affords", () => {
	test("a whole number of the denomination, exactly", () => {
		expect(stickersLeftFor(2, 0.25)).toBe(8);
		expect(stickersLeftFor(2, 0.5)).toBe(4);
		expect(stickersLeftFor(2, 1)).toBe(2);
	});

	// The floor is the honest answer: a remainder too small to afford the whole drawing
	// affords none of it. Rounding up would promise a Sticker the server refuses.
	test("a remainder that does not reach the denomination floors off", () => {
		expect(stickersLeftFor(1.49, 0.5)).toBe(2);
		expect(stickersLeftFor(0.24, 0.25)).toBe(0);
		expect(stickersLeftFor(0.24, 1)).toBe(0);
	});

	/**
	 * 🚨 The case the epsilon exists for. `remaining` travels over JSON as a binary float
	 * and arrives one ulp under a true whole-dollar figure, so a naive `floor` reads a
	 * Sticker the giver genuinely can afford as unaffordable — a $0.75 shown as one
	 * affordable $0.25 where there are three.
	 */
	test("float drift just below a whole figure never costs the giver a Sticker", () => {
		expect(stickersLeftFor(0.9999999999999999, 0.25)).toBe(4);
		expect(stickersLeftFor(0.49999999999999994, 0.5)).toBe(1);
	});

	test("nothing is left below zero, and a spent allowance affords nothing", () => {
		expect(stickersLeftFor(0, 0.25)).toBe(0);
		expect(stickersLeftFor(-1, 0.25)).toBe(0);
	});
});
