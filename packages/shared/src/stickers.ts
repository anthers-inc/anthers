// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Sticker batches: what a person may give, and what giving it directs.
 *
 * ⭐ **The art IS the denomination** (Parker, 2026-09-04). A batch runs from a simple
 * drawing to an elaborate one, and choosing which Sticker to give is choosing how much to
 * direct — there is no second control asking for an amount. That is what keeps a Sticker a
 * gesture rather than a price, and it is why the server reads the money off the art
 * instead of accepting it from a client.
 *
 * ⭐ **Three per batch, one per denomination, four batches a year** (Parker, 2026-09-04).
 * The count is what keeps the amount readable off the drawing: with two Stickers at the
 * same price a reader has to compare numbers, and the whole point is that they do not have
 * to. {@link batchesAreWellFormed} asserts it rather than trusting it.
 *
 * 🚨 **Nothing is ever retired from giving** (Parker, 2026-09-04). A past batch stays
 * giveable forever, so a Sticker somebody liked never becomes something they may no longer
 * send. ⚠️ **The picker therefore grows by three every quarter** — twelve a year — so any
 * surface offering these has to lead with the current batch and let the rest be reached
 * rather than listing everything flat. That is a real cost of the rule and it lands on the
 * interface, not here.
 *
 * 🚨 **A batch is a fixed list Anthers chooses, and deliberately not a picker over a
 * library.** A Sticker attaches to somebody else's Work and is a *user*-facing gesture, so
 * a freely chosen emblem would be a far worse content surface than a creator's own Badge.
 * Keeping the batch curated is also what preserves the option of commissioning one from an
 * illustrator later, since a fixed list is a fixed list either way.
 */

import { STICKER_DENOMINATIONS } from "./constants";

/** One giveable Sticker. */
export interface StickerArt {
	/** Stored on the row and sent by a client. Stable forever — rows outlive everything. */
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

/** A season's three, released together. */
export interface StickerBatch {
	/** Stable id, for grouping a growing picker. */
	id: string;
	/** What the season is called, for a heading. */
	name: string;
	/** When it became giveable, as `YYYY-MM`. Newest first in {@link STICKER_BATCHES}. */
	released: string;
	/**
	 * Ordered simple to elaborate, and that order is the meaning: a reader should be able
	 * to tell what a Sticker cost from how much drawing is in it.
	 */
	art: readonly StickerArt[];
}

/** Every batch ever released, newest first. Nothing is ever removed from this list. */
export const STICKER_BATCHES: readonly StickerBatch[] = [
	{
		id: "butterflies-2026q3",
		name: "Butterflies",
		released: "2026-09",
		art: [
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
		],
	},
] as const;

/** The batch on offer now — what a picker should lead with. */
export const CURRENT_BATCH = STICKER_BATCHES[0] as StickerBatch;

/** Every Sticker ever released, flat. */
export const ALL_STICKER_ART: readonly StickerArt[] = STICKER_BATCHES.flatMap((b) => b.art);

const BY_KEY = new Map<string, StickerArt>(ALL_STICKER_ART.map((s) => [s.key, s]));

/** The art for a stored key, or `undefined` if nothing ever had it. */
export function stickerArt(key: string | null | undefined): StickerArt | undefined {
	return key ? BY_KEY.get(key) : undefined;
}

/**
 * Whether this key may be given.
 *
 * ⚠️ **Every released Sticker is giveable, so this is membership and nothing more** — but
 * it stays a named question rather than collapsing into `stickerArt`, because the two ask
 * different things. This one gates a *write*; `stickerArt` answers a *display*, and a row
 * must keep drawing even if a key were ever withdrawn from giving.
 */
export function isGiveable(key: string | null | undefined): boolean {
	return Boolean(key) && BY_KEY.has(key as string);
}

/**
 * What giving this Sticker directs, in dollars.
 *
 * 🚨 **The server reads the amount from here and never from the request.** A client that
 * could send art and amount separately could pair the most elaborate drawing with the
 * smallest sum, and the art is what tells a creator and a page how generous somebody was
 * — so the mismatch would be a misrepresentation rather than a rounding problem.
 */
export function stickerAmount(key: string): number | undefined {
	return BY_KEY.get(key)?.amount;
}

/**
 * Every way a batch could be malformed, as a list of sentences.
 *
 * 🚨 **Checked rather than trusted, because every failure here is silent.** A batch with a
 * price that is not a denomination puts un-chargeable sums on rows; two Stickers at one
 * price breaks the rule that the drawing tells you the amount; a duplicated key makes two
 * batches disagree about what a stored row means.
 */
export function batchProblems(): string[] {
	const out: string[] = [];
	const seenKeys = new Set<string>();
	const seenEmblems = new Set<string>();
	for (const batch of STICKER_BATCHES) {
		const amounts = batch.art.map((a) => a.amount);
		for (const art of batch.art) {
			if (!STICKER_DENOMINATIONS.some((d) => d === art.amount)) {
				out.push(`${batch.id}/${art.key} is priced ${art.amount}, which is not a denomination`);
			}
			if (seenKeys.has(art.key)) out.push(`${art.key} appears in more than one batch`);
			if (seenEmblems.has(art.emblem)) out.push(`${art.emblem} draws more than one Sticker`);
			if (!art.label.trim()) out.push(`${batch.id}/${art.key} has nothing to call it`);
			seenKeys.add(art.key);
			seenEmblems.add(art.emblem);
		}
		if (new Set(amounts).size !== amounts.length) {
			out.push(
				`${batch.id} prices two Stickers the same, so the drawing stops telling you the amount`,
			);
		}
		if (amounts.length !== STICKER_DENOMINATIONS.length) {
			out.push(`${batch.id} holds ${amounts.length} Stickers; a batch is one per denomination`);
		}
		if (amounts.some((a, i) => i > 0 && a < (amounts[i - 1] as number))) {
			out.push(`${batch.id} is not ordered simple to elaborate`);
		}
	}
	return out;
}

export const batchesAreWellFormed = (): boolean => batchProblems().length === 0;
