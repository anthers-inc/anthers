// SPDX-License-Identifier: Apache-2.0
/**
 * `flipDeltas` is the part of FLIP that can be wrong without a browser: how far each
 * identified element travelled between the two measurements, and which elements have
 * nothing to travel. The hook around it only reads rectangles and plays the result.
 *
 * The subpixel case is the one worth keeping: a layout nudge below half a pixel is not a
 * move, and starting an animation for it makes an idle list shimmer.
 */

import { describe, expect, it } from "bun:test";
import { type FlipRect, flipDeltas } from "./flip";

const rect = (left: number, top: number, width = 100, height = 40): FlipRect => ({
	left,
	top,
	width,
	height,
});

describe("flipDeltas", () => {
	it("returns the distance each element travelled", () => {
		const before = new Map([
			["a", rect(0, 0)],
			["b", rect(0, 40)],
		]);
		const after = new Map([
			["a", rect(0, 40)],
			["b", rect(0, 0)],
		]);

		expect(flipDeltas(before, after)).toEqual([
			{ id: "a", dx: 0, dy: -40 },
			{ id: "b", dx: 0, dy: 40 },
		]);
	});

	it("skips an element that only arrived or only left", () => {
		const before = new Map([["a", rect(0, 0)]]);
		const after = new Map([["b", rect(0, 0)]]);
		expect(flipDeltas(before, after)).toEqual([]);
	});

	it("skips a subpixel nudge", () => {
		const before = new Map([["a", rect(0, 0)]]);
		const after = new Map([["a", rect(0.2, 0.2)]]);
		expect(flipDeltas(before, after)).toEqual([]);
	});

	it("measures a horizontal move as well", () => {
		const before = new Map([["a", rect(0, 0)]]);
		const after = new Map([["a", rect(24, 0)]]);
		expect(flipDeltas(before, after)).toEqual([{ id: "a", dx: -24, dy: 0 }]);
	});
});
