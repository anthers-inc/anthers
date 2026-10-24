// SPDX-License-Identifier: Apache-2.0
/**
 * The **Channel Guide**'s pure model — the part of the lens that is arithmetic and
 * ordering, kept testable and separate from the component.
 *
 * 🚨 **The guide is ordinal, not temporal across channels.** A channel is its creator's
 * programming sorted by recency *for that creator*: creator A's second-most-recent video
 * and creator B's second-most-recent video render at the same rank even when one is five
 * minutes old and the other five days old — both are "latest plus one". The blocks never
 * align to real release times (Parker, 2026-10-11); there is no shared clock on this
 * surface, and a channel is a rank, not a schedule.
 *
 * ⭐ **Next is toward the newer end.** The guide reads in one of two orientations
 * (Parker, 2026-10-24), and the rank order is the same in both. In the default *columns*
 * reading, latest sits at the top of each column, so next runs *upward*, deliberately
 * reversing the downward convention other platforms' players teach. In *rows*, creators
 * stack top to bottom and each one's programs run left (older) to right (newer), so next
 * runs *rightward*. Everything a player needs to offer follows from the axis: next is one
 * rank more recent, previous is one rank older, and the UI's arrow language must make the
 * active direction unmistakable.
 *
 * **One vocabulary, contextual corpus.** A channel is always *a creator* and its blocks
 * are always *that creator's videos*, but which videos ride the lens's context — the
 * Feed's variant carries every released video from the creator, followed or not, while
 * the Library's variant carries only the ones the user has on their shelf. The component
 * takes already-translated channels; this model defines the shape both translators
 * produce.
 */
import type { Work } from "@anthers/web-shared/types";

/** One channel: a creator and their programming, latest-first in the model's rank order. */
export interface GuideChannel {
	/** Stable key for React and for selection bookkeeping — `creator:{id}`. */
	id: string;
	creatorId: number | null;
	handle: string | null;
	/** The channel's name: the creator's display name, falling back to their handle. */
	name: string | null;
	avatar: string | null;
	/**
	 * The channel's programming, **always latest-first** — the model's rank order.
	 * Consumers never re-sort it: the next arithmetic reads this order directly, and a
	 * row-oriented reading reverses only what it draws, never the array.
	 */
	programs: Work[];
}

/**
 * Which way the guide is turned. `"columns"` is the default and the original reading: a
 * real schedule's — creators left to right, each one's programs stacked downward with the
 * newest at the top. `"rows"` rotates the metaphor: creators top to bottom, each one's
 * programs running left (older) to right (newer). The corpus, the per-creator ranks and
 * the next arithmetic are identical in both; only the axis the ranks advance along changes.
 */
export type GuideOrientation = "columns" | "rows";

const ORIENTATION_KEY = "anthers_guide_orientation";

/** The guide's orientation, remembered on this device — `"columns"` when nothing is stored. */
export function readOrientation(): GuideOrientation {
	try {
		return localStorage.getItem(ORIENTATION_KEY) === "rows" ? "rows" : "columns";
	} catch {
		/* Storage disabled — the default reading. */
		return "columns";
	}
}

export function writeOrientation(orientation: GuideOrientation): void {
	try {
		if (orientation === "rows") localStorage.setItem(ORIENTATION_KEY, "rows");
		else localStorage.removeItem(ORIENTATION_KEY);
	} catch {
		/* Storage disabled — the preference simply never sticks. */
	}
}

/**
 * Release recency, latest first: when a Work arrived here (`releasedAt`), falling back to
 * the upload date the Work carries for its creator, with the id as the deterministic
 * tie-break so an equal-timestamp column never reshuffles between visits.
 */
export function compareRecencyLatestFirst(a: Work, b: Work): number {
	const at = a.releasedAt ?? a.createdAt;
	const bt = b.releasedAt ?? b.createdAt;
	if (at !== bt) return (bt ?? "").localeCompare(at ?? "");
	return b.id - a.id;
}

/**
 * Channel order: alphabetically by channel name (Parker, 2026-10-11 — richer sorts are
 * later dials, including a user-driven re-sort to taste). A creator with no display name
 * and no handle sorts as "Unknown" and stays deterministic.
 */
export function compareChannelNames(a: GuideChannel, b: GuideChannel): number {
	const an = (a.name ?? "Unknown").trim();
	const bn = (b.name ?? "Unknown").trim();
	return an.localeCompare(bn, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
}

/**
 * The next program's index: one rank more recent. In the columns reading that is the
 * block *above* the current one; in rows it is the block to its *right*. `null` ends the
 * guide — the channel's newest video is playing, and there is no next to reach.
 */
export function nextProgramIndex(index: number): number | null {
	return index > 0 ? index - 1 : null;
}

/** The previous program's index: one rank older — down in columns, left in rows. `null` when already the oldest. */
export function previousProgramIndex(index: number, count: number): number | null {
	return index + 1 < count ? index + 1 : null;
}

/**
 * The autoplay preference, deliberately **off by default** (Parker, 2026-10-11: autoplay
 * is not the default — it is something a user flips on when they are in the mood for
 * multi-video play) and remembered on this device once they do.
 */
const GUIDE_AUTOPLAY_KEY = "anthers_guide_autoplay";

export function readAutoplay(): boolean {
	try {
		return localStorage.getItem(GUIDE_AUTOPLAY_KEY) === "1";
	} catch {
		/* Storage disabled — autoplay simply never remembers. */
		return false;
	}
}

export function writeAutoplay(on: boolean): void {
	try {
		if (on) localStorage.setItem(GUIDE_AUTOPLAY_KEY, "1");
		else localStorage.removeItem(GUIDE_AUTOPLAY_KEY);
	} catch {
		/* Storage disabled — the preference simply never sticks. */
	}
}
