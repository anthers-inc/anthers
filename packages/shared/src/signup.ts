// SPDX-License-Identifier: Apache-2.0
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
	/** Creator handles to support directly, at the Badge each creator's ladder names. */
	badges: string[];
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
		badges: names(raw.badges),
	};
}

/** Whether anything at all was chosen. An empty answer is a complete answer, not an error. */
export function picksAreEmpty(picks: SignupPicks): boolean {
	return picks.badge === null && picks.follow.length === 0 && picks.badges.length === 0;
}

/**
 * What the whole charge comes to, in **dollars a month**.
 *
 * 🚨 **This was a COUNT until 2026-08-16, and both of its consumers take an amount.**
 * `anthers` was `1` for "ticked" and the total was `1 + directed.length`, which the page
 * then handed to `preview/:amount` and to the signup body's `anthersSupport`. That was
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
