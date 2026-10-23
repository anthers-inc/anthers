// SPDX-License-Identifier: Apache-2.0
//
// Which rung a viewer's "Your Badge" highlight lands on.
//
// The grid hands every unlocked rung the same subdued "Included" treatment except one, so
// this decision is what the highlight means: the highest amount the viewer's giving covers,
// not the last id the server happened to list. Break it to `unlocked[unlocked.length - 1]`
// and the reordered-ladder and string-threshold cases below must fail.

import { describe, expect, test } from "bun:test";
import type { CreatorBadge } from "@anthers/web-shared/types";
import { currentRungId } from "./badge-ladder";

function rung(id: number, threshold: string): CreatorBadge {
	return {
		id,
		creatorId: 1,
		threshold,
		label: `Rung ${id}`,
		description: null,
		hasArt: false,
		artShape: null,
		artColor: null,
		sortOrder: id,
		createdAt: "",
		updatedAt: "",
	};
}

describe("currentRungId", () => {
	test("is null when nothing is unlocked", () => {
		expect(currentRungId([rung(1, "3.00"), rung(2, "6.00")], [])).toBeNull();
	});

	test("is null when the ladder is empty", () => {
		expect(currentRungId([], [1, 2])).toBeNull();
	});

	test("picks the only unlocked rung", () => {
		expect(currentRungId([rung(1, "3.00"), rung(2, "6.00")], [2])).toBe(2);
	});

	test("picks the highest threshold, not the last id", () => {
		// The ids follow creation order; the amounts do not have to.
		const ladder = [rung(1, "3.00"), rung(2, "12.00"), rung(3, "6.00")];
		expect(currentRungId(ladder, [1, 2, 3])).toBe(2);
	});

	test("compares dollar strings as numbers", () => {
		// "10.00" sorts before "9.00" as a string, and the wrong answer is $9.
		expect(currentRungId([rung(1, "10.00"), rung(2, "9.00")], [1, 2])).toBe(1);
	});

	test("ignores unlocked ids the ladder no longer holds", () => {
		expect(currentRungId([rung(1, "3.00")], [1, 99])).toBe(1);
	});

	test("resolves a duplicate threshold to the later rung in ladder order", () => {
		expect(currentRungId([rung(1, "6.00"), rung(2, "6.00")], [1, 2])).toBe(2);
	});
});
