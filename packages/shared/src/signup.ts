// SPDX-License-Identifier: Apache-2.0
import { PUBLIC_ACCESS_PRICE } from "./constants";

/**
 * The choices a signup carries from `/signup` to the page that finishes it.
 *
 * 🚨 **This shape crosses three boundaries, which is why it lives here rather than in the
 * page that collects it.** `/signup` builds it, `POST /auth/signup/begin` validates and
 * stores it as jsonb on the pending signup, and `/finish` reads it back to say what is
 * about to be committed. A second copy of the shape in any of the three would be a second
 * thing to keep in step, and the one that drifted would do so silently — a pick the page
 * shows and the charge does not is exactly the class of defect `supportTotal` exists for.
 */

/**
 * One backed creator, with the rung of their ladder the visit picked.
 *
 * ⭐ **The choice is per rung, the charge is per creator** (2026-10-17): a backed creator
 * carries exactly one pick, and a card's Badge chips offer the rungs of the ladder that
 * creator actually set — the image and the amount on a chip are that rung's own data.
 * `badgeId` names the rung exactly as the ladder rendered it, so what a chip shows is what
 * the charge bills, and no page substitutes a price of its own for one the creator set.
 */
export interface SignupBadgePick {
	/** The creator's handle — the same address `follow` carries. */
	handle: string;
	/**
	 * The chosen rung's id, as `GET /api/accounts/creators` reported the ladder. Null reads
	 * as **the ladder's lowest rung**, and a rung id the ladder no longer reports resolves
	 * the same way: the page that charges resolves against the ladder it just fetched, so a
	 * pick never carries a price, only a pointer the ladder can still answer.
	 */
	badgeId: number | null;
}

/** What a visitor chose on `/signup`, before any of it was committed. */
export interface SignupPicks {
	/**
	 * The Anthers Badge the visitor picked, by name — `"root"`, …, `"blossom"`.
	 *
	 * Null or absent means **Free**, which is a real Badge at $0 in the seeded ladder
	 * rather than the absence of an answer. A badge name that is not in Anthers' set is
	 * read as Free by `normalizePicks`, exactly like any other shape it does not
	 * recognize.
	 */
	badge: string | null;
	/** Creator handles to follow. Following costs nothing and is applied first. */
	follow: string[];
	/** Creators to support directly, one pick each, at the rung that creator's ladder names. */
	badges: SignupBadgePick[];
}

export const EMPTY_PICKS: SignupPicks = { badge: null, follow: [], badges: [] };

/**
 * How many creators one signup may carry.
 *
 * A bound rather than a product rule: this arrives from a browser and is stored, so it
 * needs a ceiling that is not "whatever was posted". Fifty is far above what the creator
 * finder can realistically produce and far below anything worth storing by accident.
 */
export const MAX_PICKED_CREATORS = 50;

/** The largest monthly amount a signup may name, in dollars. Above this is a typo or a probe. */
export const MAX_SIGNUP_AMOUNT = 10_000;

/**
 * Read picks from somewhere that may hold anything — session storage, or a jsonb column
 * written by an older version of this shape.
 *
 * 🚨 **`badge` is coerced rather than spread through.** Until 2026-10-02 this field was
 * `anthers: number`, and a raw dollar amount in stored picks is not a Badge name;
 * spreading it through would leave the ceremony charging for a rung the page cannot
 * display. Anything that is not a non-empty string reads as Free (null), which is what
 * a badge-less signup actually is.
 *
 * ⚠️ **The same tolerance is how this shape itself crossed `badges`.** Until 2026-10-17
 * a `badges` entry was a bare handle, and the convention those picks resolved by — the
 * ladder's lowest rung — is what a bare entry still reads as (`badgeId: null`), so stored
 * signups older than the per-rung picker keep working without a ladder in storage.
 */
export function normalizePicks(value: unknown): SignupPicks {
	const raw = (value ?? {}) as Partial<Record<keyof SignupPicks, unknown>>;
	const names = (list: unknown): string[] =>
		Array.isArray(list)
			? list.filter((name): name is string => typeof name === "string" && name.length > 0)
			: [];
	return {
		badge: typeof raw.badge === "string" && raw.badge.length > 0 ? raw.badge : null,
		follow: names(raw.follow),
		badges: badgePicks(raw.badges),
	};
}

/** Coerce a `badges` list of mixed age into one pick per creator, handles intact. */
function badgePicks(list: unknown): SignupBadgePick[] {
	if (!Array.isArray(list)) return [];
	const picks = new Map<string, SignupBadgePick>();
	for (const entry of list) {
		if (typeof entry === "string" && entry.length > 0) {
			picks.set(entry, { handle: entry, badgeId: null });
			continue;
		}
		const asObject = entry as Partial<Record<keyof SignupBadgePick, unknown>> | null;
		if (asObject && typeof asObject.handle === "string" && asObject.handle.length > 0) {
			const badgeId = asObject.badgeId;
			picks.set(asObject.handle, {
				handle: asObject.handle,
				badgeId:
					typeof badgeId === "number" && Number.isInteger(badgeId) && badgeId > 0 ? badgeId : null,
			});
		}
	}
	return [...picks.values()];
}

/** Whether anything at all was chosen. An empty answer is a complete answer, not an error. */
export function picksAreEmpty(picks: SignupPicks): boolean {
	return picks.badge === null && picks.follow.length === 0 && picks.badges.length === 0;
}

/**
 * The monthly amount **one backed creator's pick bills**.
 *
 * 🚨 **The page that shows the pick and the page that charges it call this same function**
 * — the display/charged rule `supportTotal` carries, held at the resolution too. A pick
 * carries a rung id, never a price: the amount comes from the ladder as it was just
 * fetched, so a ladder an edit changed between pick and commit charges what it now names.
 *
 * The fallbacks, in order: a rung whose id no longer resolves reads as **the ladder's
 * lowest rung** (the one every real ladder has, and what the handle-only shape of
 * 2026-10-16 and before resolved every pick by); a creator with no ladder at all reads as
 * the entry price, which is what that creator's "Back" meant while backing was a fixed
 * figure. The ladder arrives ascending by threshold, the way the listing ships it.
 */
export function directedAmountFor(
	pick: { badgeId: number | null },
	ladder: readonly { id: number; threshold: string }[] | undefined,
): number {
	const rungs = ladder ?? [];
	if (rungs.length === 0) return PUBLIC_ACCESS_PRICE;
	if (pick.badgeId !== null) {
		const chosen = rungs.find((r) => r.id === pick.badgeId);
		if (chosen) return Number(chosen.threshold);
	}
	return Number(rungs[0].threshold);
}

/**
 * What the whole charge comes to, in **dollars a month**.
 *
 * 🚨 **This was a COUNT until 2026-08-16, and both of its consumers take an amount.**
 * `anthers` was `1` for "ticked" and the total was `1 + directed.length`, which the page
 * then handed to `preview/:amount` and to the signup body's Anthers amount. That was
 * correct while amounts were multiples of one price the server multiplied by; the
 * retirement made the server take dollars and multiply by nothing, so the ceremony
 * **quoted $3 for a $9 charge** and then subscribed the user at **$1 a month** — under the
 * $3 that lifts the Public Access limit they had just agreed to pay for.
 *
 * ⚠️ **The Anthers side is a Badge pick now, and its dollars are the Badge's
 * threshold** — the caller resolves the picked name against the ladder (e.g. via
 * `thresholdForBadge`) before handing it here, so the total still contains no number
 * this function could invent: every dollar in it was chosen somewhere in the UI.
 *
 * ⚠️ **It moved here from `pages/SignupPage.tsx` on 2026-08-26**, when the page that
 * finishes a signup began quoting the same total. Two pages importing it from one of
 * themselves is how a page module becomes a library by accident; the picks it adds up
 * already live here, so it belongs beside them.
 *
 * `null` is still accepted, deliberately: the signature is the boundary with the ceremony
 * rather than with any one page's state, and Free (a picked Badge at $0) and "hasn't
 * said" both arrive as zero dollars here.
 */
export function supportTotal(anthers: number | null, directed: { amount: number }[]): number {
	return directed.reduce((sum, d) => sum + d.amount, anthers ?? 0);
}
