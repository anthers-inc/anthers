// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who appears on the supporters page, and in what order.
 *
 * ⭐ **Names, never amounts** (Parker, 2026-09-04). A display name beside a dollar figure is
 * a statement about somebody's finances, and the page is a thank-you rather than a
 * leaderboard. Supporters are grouped by lifetime total and ordered alphabetically inside
 * each group, so the page has a shape without ever publishing a number.
 *
 * ⚠️ **A band still leaks a range, and that is the accepted trade.** Anything ordered by
 * money discloses something about the money; grouping discloses a bracket rather than a
 * figure, which is the least an ordered page can disclose. What it must never do is publish
 * the figure itself, sort within a band by amount, or let the group sizes be small enough
 * that a band identifies one person.
 *
 * 🚨 **Eligibility is having EVER supported, not supporting now.** Somebody who gave for
 * three months and stopped keeps their place if they want it, so this can never be a query
 * over live standing — it reads the per-cycle record, which is the only durable one.
 */

/**
 * The lifetime-total thresholds that separate the groups, ascending.
 *
 * ⚠️ **A dial, and a pre-launch guess.** Nobody has supported Anthers for long enough for
 * these to be shaped by real totals; they are spaced so that a year at each Badge lands in a
 * different band ($3/mo for a year is $36, $12/mo is $144). Revisit them against real
 * distribution rather than leaving them where a guess put them.
 *
 * 🚨 **Raising a threshold moves people DOWN a group in public.** That is a visible demotion
 * of somebody who did nothing, so a change here is a change to what the page says about
 * named people — not a tuning knob to adjust casually.
 */
export const SUPPORTER_BAND_THRESHOLDS = [500, 150, 36] as const;

/** How many groups the page has, including the one below the lowest threshold. */
export const SUPPORTER_BAND_COUNT = SUPPORTER_BAND_THRESHOLDS.length + 1;

/**
 * Which group a lifetime total falls in — `0` is the most-supported.
 *
 * ⚠️ **The groups are deliberately UNLABELED.** Naming them would invent a vocabulary of
 * standing that Anthers has not decided on and that would collide with Badges, which are a
 * monthly level rather than a lifetime one. Order carries the meaning; nothing is called
 * anything.
 */
export function supporterBand(lifetimeDollars: number): number {
	for (let i = 0; i < SUPPORTER_BAND_THRESHOLDS.length; i++) {
		if (lifetimeDollars >= SUPPORTER_BAND_THRESHOLDS[i]) return i;
	}
	return SUPPORTER_BAND_THRESHOLDS.length;
}

/** One person as the page knows them: a name, and nothing about what they gave. */
export interface SupporterEntry {
	username: string;
	displayName: string | null;
}

/**
 * Sort one group's names for display.
 *
 * 🚨 **Alphabetical, case- and accent-insensitively, and never by amount.** Sorting a group
 * by what people gave would republish the ordering the bands exist to withhold — the page
 * would disclose a ranking it declines to state. `localeCompare` with `sensitivity: "base"`
 * is what stops `ada` and `Ada` landing in different halves of the list.
 */
export function sortSupporters(entries: SupporterEntry[]): SupporterEntry[] {
	return [...entries].sort((a, b) =>
		(a.displayName ?? a.username).localeCompare(b.displayName ?? b.username, undefined, {
			sensitivity: "base",
		}),
	);
}

/**
 * The smallest group Anthers will publish as its own band.
 *
 * ⭐ **A band of one names an amount.** With unlabeled groups a reader cannot read a figure
 * off the page — unless a group holds a single person, at which point their bracket is
 * exactly identified and the anonymity the bands provide has failed for the one person most
 * exposed by it. Groups below this are merged downward before rendering.
 */
export const MIN_BAND_SIZE = 3;

/**
 * Group supporters for display: bands descending, names alphabetical inside each.
 *
 * ⚠️ **Merges a band that is too small into the one below it**, rather than dropping it or
 * publishing it. Dropping would remove somebody who asked to be listed; publishing a band of
 * one discloses their bracket. Merging downward keeps everybody on the page and can only
 * ever understate what a person gave.
 */
export function groupSupporters(
	people: (SupporterEntry & { lifetimeDollars: number })[],
): SupporterEntry[][] {
	const bands: (SupporterEntry & { lifetimeDollars: number })[][] = Array.from(
		{ length: SUPPORTER_BAND_COUNT },
		() => [],
	);
	for (const person of people) bands[supporterBand(person.lifetimeDollars)].push(person);

	// Walk from the most-supported down, carrying anything too small into the next group.
	const out: SupporterEntry[][] = [];
	let carried: (SupporterEntry & { lifetimeDollars: number })[] = [];
	for (let i = 0; i < bands.length; i++) {
		const merged = [...carried, ...bands[i]];
		carried = [];
		if (merged.length === 0) continue;
		// The last band has nowhere to carry to, so it always renders.
		if (merged.length < MIN_BAND_SIZE && i < bands.length - 1) {
			carried = merged;
			continue;
		}
		// 🚨 **Projected to names, not merely typed as names.** These objects carry the
		// lifetime total that put them in this band, and returning them unchanged satisfies
		// `SupporterEntry[]` while shipping the figure straight into the JSON — a structural
		// type strips nothing at runtime. The one place the amount is dropped is here.
		out.push(
			sortSupporters(merged).map(({ username, displayName }) => ({ username, displayName })),
		);
	}
	// Nothing can still be carried: the last band has no `i < length - 1` to defer on, so it
	// always renders whatever it holds.
	return out;
}
