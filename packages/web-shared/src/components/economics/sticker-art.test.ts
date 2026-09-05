// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every Sticker in the batch has art that actually exists.
 *
 * 🚨 **`BadgeMark` warns and draws nothing for an unknown emblem id**, so a batch naming
 * art that was never added to `@anthers/brand` renders as an empty patch — a Sticker
 * somebody paid for, showing as a blank. Nothing else in the system can catch it: the
 * catalog typechecks, the server stores the key happily, and the page renders without
 * error. This is the only place the two lists are compared.
 */

import { describe, expect, it } from "bun:test";
import { icons } from "@anthers/brand";
import { STICKER_BATCH } from "@anthers/shared/stickers";

describe("the Sticker batch's art", () => {
	it("🚨 names an emblem the brand package actually carries", () => {
		const missing = STICKER_BATCH.filter((art) => !(art.emblem in icons)).map(
			(art) => `${art.key} → ${art.emblem}`,
		);
		expect(missing).toEqual([]);
	});
});
