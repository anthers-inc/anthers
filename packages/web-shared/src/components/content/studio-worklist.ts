// SPDX-License-Identifier: Apache-2.0
/**
 * What needs the creator's attention, derived from what the Studio already fetches.
 *
 * 🚨 **Every item here is something that is WRONG and that the creator can fix.** A thing
 * merely in progress is not on this list — a transcode resolves itself, and the wiki's
 * *Releasing a Work* says plainly that a creator is waiting rather than fixing. A list that
 * includes what resolves itself is a list people learn to skim, which costs exactly the
 * items that needed reading.
 *
 * 🚨 **And none of it is a panel the creator can hide** (Parker, 2026-09-11). Payout setup
 * blocks every release they will ever attempt, and a released-but-locked Work is invisible
 * from their own side of the glass, because a creator can always open their own work. A
 * warning that can be removed is one that will be, silently, by the person it was for.
 *
 * Pure and kept out of the component that renders it, for the same reason `work-state.ts`
 * is: none of this can be checked by looking at the screen. A drifted condition renders a
 * perfectly plausible dashboard — an empty one — and an empty dashboard is exactly what a
 * creator with nothing wrong is supposed to see.
 */

import type { Work } from "../../lib/types";
import { accessState } from "./work-state";

/**
 * Why an item is on the list. The value is stable and is what a test names, so renaming one
 * is a change to the test rather than to a string a reader sees.
 */
export type WorklistKind = "locked" | "payouts" | "encode-failed" | "unrated" | "no-delivery";

export interface WorklistItem {
	kind: WorklistKind;
	/** What is wrong, as a complete sentence naming its own subject. */
	message: string;
	/** The link's own words — what doing something about it is called. */
	action: string;
	/** Where the action goes: the one Work when there is one, else the Catalog. */
	href: string;
	/**
	 * `blocking` is something already wrong out in the world or standing between the creator
	 * and every release; `attention` is one Work that cannot go out yet.
	 */
	severity: "blocking" | "attention";
}

/** How many Works this condition covers, and the single one if it covers exactly one. */
interface Group {
	count: number;
	only: Work | null;
}

function group(works: Work[]): Group {
	return { count: works.length, only: works.length === 1 ? works[0] : null };
}

/**
 * Where an item points.
 *
 * One Work gets its own page, because that is where the fix is. Several get the Catalog,
 * where every card already carries its own link — naming one of five would be picking a
 * Work for the creator, and listing five lines is how this list stops being read.
 */
function hrefFor(g: Group, editUrl: (work: Work) => string, catalogUrl: string): string {
	return g.only ? editUrl(g.only) : catalogUrl;
}

/** `"Tide"` for one, `"3 Works"` for several — the subject of the item's sentence. */
function subject(g: Group): string {
	if (g.only) return `“${g.only.title || "Untitled"}”`;
	return `${g.count} Works`;
}

export interface WorklistInput {
	works: Work[];
	/**
	 * Whether the creator can actually be paid. **`null` means the answer has not arrived**,
	 * and nothing is emitted for it — the same discipline the release control uses, so a
	 * failed status request never invents a problem the creator does not have.
	 */
	payoutsReady: boolean | null;
	/** The Studio path for one Work's own page. */
	editUrl: (work: Work) => string;
	/** The Studio's Catalog path, for an item covering several Works. */
	catalogUrl: string;
}

/**
 * The list, worst first.
 *
 * ⭐ **`locked` leads, above even payout setup.** It is the only condition here describing
 * something that is already wrong *in public*: the Work is listed, its page loads for the
 * person checking, and no reader can get in. Everything else on this list is work that has
 * not gone out yet.
 */
export function buildWorklist({
	works,
	payoutsReady,
	editUrl,
	catalogUrl,
}: WorklistInput): WorklistItem[] {
	const items: WorklistItem[] = [];

	const locked = group(works.filter((w) => accessState(w) === "locked"));
	if (locked.count > 0) {
		items.push({
			kind: "locked",
			message: `${subject(locked)} ${locked.only ? "is" : "are"} released, and nobody can open ${locked.only ? "it" : "them"}.`,
			action: locked.only ? "Set access" : "Set access on them",
			href: hrefFor(locked, editUrl, catalogUrl),
			severity: "blocking",
		});
	}

	if (payoutsReady === false) {
		items.push({
			kind: "payouts",
			message:
				"Your payout setup is not finished, and nothing can be released until it is — including anything you are giving away.",
			action: "Finish payout setup",
			href: "/studio/settings",
			severity: "blocking",
		});
	}

	const failed = group(works.filter((w) => w.transcoding?.status === "failed"));
	if (failed.count > 0) {
		items.push({
			kind: "encode-failed",
			message: `Processing failed on ${subject(failed)}.`,
			action: failed.only ? "Open it" : "Open your Catalog",
			href: hrefFor(failed, editUrl, catalogUrl),
			severity: "blocking",
		});
	}

	// Unreleased only: a released Work cannot be unrated, because the server refuses the
	// release while it is. Asking about one that is already out would be asking about a
	// state that cannot exist.
	const unrated = group(
		works.filter((w) => w.visibility !== "released" && (!w.maturity || w.maturity === "unrated")),
	);
	if (unrated.count > 0) {
		items.push({
			kind: "unrated",
			message: `${subject(unrated)} ${unrated.only ? "has" : "have"} no content rating, so ${unrated.only ? "it" : "they"} cannot be released.`,
			action: unrated.only ? "Rate it" : "Rate them",
			href: hrefFor(unrated, editUrl, catalogUrl),
			severity: "attention",
		});
	}

	const noDelivery = group(
		works.filter((w) => w.visibility !== "released" && !w.streamEnabled && !w.downloadEnabled),
	);
	if (noDelivery.count > 0) {
		items.push({
			kind: "no-delivery",
			message: `${subject(noDelivery)} can neither be streamed nor downloaded, so ${noDelivery.only ? "it" : "they"} cannot be released.`,
			action: noDelivery.only ? "Turn one on" : "Open your Catalog",
			href: hrefFor(noDelivery, editUrl, catalogUrl),
			severity: "attention",
		});
	}

	return items;
}
