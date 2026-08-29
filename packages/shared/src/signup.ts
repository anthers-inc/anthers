// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The choices a signup carries from `/subscribe` to the page that finishes it.
 *
 * 🚨 **This shape crosses three boundaries, which is why it lives here rather than in the
 * page that collects it.** `/subscribe` builds it, `POST /auth/signup/begin` validates and
 * stores it as jsonb on the pending signup, and `/finish` reads it back to say what is
 * about to be committed. A second copy of the shape in any of the three would be a second
 * thing to keep in step, and the one that drifted would do so silently — a pick the page
 * shows and the charge does not is exactly the class of defect `supportTotal` exists for.
 *
 * ⚠️ **`seed` keeps its name, and the name is retired copy.** "Seed" is no longer a
 * user-facing noun (63.01), but identifiers were deliberately left alone — `seed_allocations`
 * and `works.seed_access` still exist and still mean what they say. Renaming this one field
 * would put a third spelling of the same concept in the codebase to fix a word no reader
 * ever sees.
 */

/** What a visitor chose on `/subscribe`, before any of it was committed. */
export interface SignupPicks {
	/**
	 * Monthly dollars given to Anthers: `0` for Free, a rung's threshold otherwise.
	 *
	 * Not nullable. Free is a real answer rather than the absence of one, so there is no
	 * "hasn't said" state left for this to carry.
	 */
	anthers: number;
	/** Usernames to follow. Following costs nothing and is applied first. */
	follow: string[];
	/** Usernames to support directly, at the Public Access price each. */
	seed: string[];
}

export const EMPTY_PICKS: SignupPicks = { anthers: 0, follow: [], seed: [] };

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
 * 🚨 **`anthers` is coerced rather than spread through.** Until 2026-08-25 it could be
 * `null` for "hasn't said", a value the ladder can no longer display; spreading that back
 * leaves the matrix with nothing lit and the breakdown describing a rung nobody chose.
 * Anything that is not a finite number reads as Free, which is what an account with no
 * support for Anthers actually is.
 */
export function normalizePicks(value: unknown): SignupPicks {
	const raw = (value ?? {}) as Partial<Record<keyof SignupPicks, unknown>>;
	const names = (list: unknown): string[] =>
		Array.isArray(list)
			? list.filter((name): name is string => typeof name === "string" && name.length > 0)
			: [];
	return {
		anthers:
			typeof raw.anthers === "number" && Number.isFinite(raw.anthers) && raw.anthers >= 0
				? raw.anthers
				: 0,
		follow: names(raw.follow),
		seed: names(raw.seed),
	};
}

/** Whether anything at all was chosen. An empty answer is a complete answer, not an error. */
export function picksAreEmpty(picks: SignupPicks): boolean {
	return picks.anthers === 0 && picks.follow.length === 0 && picks.seed.length === 0;
}

/**
 * What the whole charge comes to, in **dollars a month**.
 *
 * 🚨 **This was a COUNT until 2026-08-16, and both of its consumers take an amount.**
 * `anthers` was `1` for "ticked" and the total was `1 + directed.length`, which the page
 * then handed to `preview/:amount` and to the subscribe body's `anthersSupport`. That was
 * correct while amounts were multiples of one price the server multiplied by; the
 * retirement made the server take dollars and multiply by nothing, so the ceremony
 * **quoted $3 for a $9 charge** and then subscribed the user at **$1 a month** — under the
 * $3 that lifts the Public Access limit they had just agreed to pay for.
 *
 * ⚠️ **The Anthers side is now an AMOUNT rather than a flag**, which removed the last
 * place this function could invent a number: it used to substitute `PUBLIC_ACCESS_PRICE`
 * for `true`, so a page offering Sprout would have quoted Root. There is nothing left to
 * assume — every dollar in the total was chosen somewhere in the UI.
 *
 * ⚠️ **It moved here from `pages/SubscribePage.tsx` on 2026-08-26**, when the page that
 * finishes a signup began quoting the same total. Two pages importing it from one of
 * themselves is how a page module becomes a library by accident; the picks it adds up
 * already live here, so it belongs beside them.
 *
 * `null` is still accepted, deliberately: the signature is the boundary with the ceremony
 * rather than with any one page's state, and the defect it exists for was a nullish amount
 * becoming a count.
 */
export function supportTotal(anthers: number | null, directed: { amount: number }[]): number {
	return directed.reduce((sum, d) => sum + d.amount, anthers ?? 0);
}
