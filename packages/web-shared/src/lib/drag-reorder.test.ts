// SPDX-License-Identifier: Apache-2.0
/**
 * `moveKey` is the one rule the drag preview and the drop both use: take the key being
 * carried out of its slot and put it in the target's slot, leaving every other key in
 * order. The hook around it only turns pointer events into these calls, so this is where
 * the off-by-one lives.
 */

import { describe, expect, it } from "bun:test";
import { moveKey } from "./drag-reorder";

describe("moveKey", () => {
	it("moves an item down and shifts the crossed item up", () => {
		expect(moveKey(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
	});

	it("moves an item up and shifts the crossed item down", () => {
		expect(moveKey(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
	});

	it("returns the same order for a no-op move", () => {
		expect(moveKey(["a", "b"], 1, 1)).toEqual(["a", "b"]);
	});

	it("returns the same order for an out-of-range index", () => {
		expect(moveKey(["a", "b"], 0, 2)).toEqual(["a", "b"]);
		expect(moveKey(["a", "b"], -1, 0)).toEqual(["a", "b"]);
	});

	it("does not mutate the input", () => {
		const keys = ["a", "b", "c"];
		moveKey(keys, 0, 2);
		expect(keys).toEqual(["a", "b", "c"]);
	});
});
