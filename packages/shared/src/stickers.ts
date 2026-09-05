// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Sticker batch: what a person may give, and what giving it directs.
 *
 * ⭐ **The art IS the denomination** (Parker, 2026-09-04). A batch runs from a simple
 * drawing to an elaborate one, and choosing which butterfly to give is choosing how
 * much to direct — there is no second control asking for an amount. That is what keeps
 * a Sticker a gesture rather than a price, and it is why the server reads the money off
 * the art instead of accepting it from a client.
 *
 * 🚨 **A batch is a fixed list Anthers chooses, and deliberately not a picker over a
 * library.** A Sticker attaches to somebody else's Work and is a *user*-facing gesture,
 * so a freely chosen emblem would be a far worse content surface than a creator's own
 * Badge. Keeping the batch curated is also what preserves the option of commissioning
 * one from an illustrator later, since a fixed list is a fixed list either way.
 */

import { STICKER_DENOMINATIONS } from "./constants";

/** One giveable Sticker. */
export interface StickerArt {
	/** Stored on the row and sent by a client. Stable forever — rows outlive batches. */
	key: string;
	/** The `@anthers/brand` icon id that draws it. */
	emblem: string;
	/** What giving it directs, in dollars. Always a {@link STICKER_DENOMINATIONS} value. */
	amount: number;
	/** What a person calls it, and what a screen reader says. */
	label: string;
	/** The shape and field it is drawn on, matching the Badge vocabulary. */
	shape: string;
	color: string;
}

/**
 * The batch now on offer.
 *
 * ⚠️ **Ordered simple to elaborate, and that order is the meaning.** A reader should be
 * able to tell what a Sticker cost from how much drawing is in it, without a number
 * beside it — so a future batch has to preserve the progression rather than only the
 * count.
 */
export const STICKER_BATCH: readonly StickerArt[] = [
	{
		key: "butterfly-small",
		emblem: "sticker-butterfly-small",
		amount: 0.25,
		label: "Small butterfly",
		shape: "circle",
		color: "meadow",
	},
	{
		key: "butterfly-medium",
		emblem: "sticker-butterfly-medium",
		amount: 0.5,
		label: "Medium butterfly",
		shape: "circle",
		color: "sun",
	},
	{
		key: "butterfly-large",
		emblem: "sticker-butterfly-large",
		amount: 1,
		label: "Large butterfly",
		shape: "circle",
		color: "clay",
	},
] as const;

/**
 * Every Sticker that has ever been giveable, by key.
 *
 * 🚨 **A row outlives the batch it was given from, so this can never be only the current
 * batch.** Somebody who gave a butterfly in one season still has it on a page in the
 * next, and a lookup that only knew the live batch would render their Sticker as
 * nothing — silently removing a gift somebody paid for. Retired batches are appended
 * here rather than deleted.
 */
const BY_KEY = new Map<string, StickerArt>(STICKER_BATCH.map((s) => [s.key, s]));

/** The art for a stored key, live or retired, or `undefined` if nothing ever had it. */
export function stickerArt(key: string | null | undefined): StickerArt | undefined {
	return key ? BY_KEY.get(key) : undefined;
}

/** Whether this key may be GIVEN — a stricter question than whether it can be drawn. */
export function isGiveable(key: string | null | undefined): boolean {
	return Boolean(key) && STICKER_BATCH.some((s) => s.key === key);
}

/**
 * What giving this Sticker directs, in dollars.
 *
 * 🚨 **The server reads the amount from here and never from the request.** A client that
 * could send art and amount separately could pair the most elaborate drawing with the
 * smallest sum, and the art is what tells a creator and a page how generous somebody
 * was — so the mismatch would be a misrepresentation rather than a rounding problem.
 */
export function stickerAmount(key: string): number | undefined {
	return BY_KEY.get(key)?.amount;
}

/** Every amount in the batch is a real denomination — asserted, not assumed. */
export function batchAmountsAreDenominations(): boolean {
	return STICKER_BATCH.every((s) => STICKER_DENOMINATIONS.some((d) => d === s.amount));
}
