// SPDX-License-Identifier: Apache-2.0
/**
 * Discovery's recipe, as three named stages rather than a sentence about a query.
 *
 * The page promises that a reader can always see how the corpus is being drawn and
 * change it, and the promise is architectural: **candidates** decide what is eligible,
 * **signals** decide what is scored and how, and **mix** decides the order the reader
 * actually sees. The page and the route read this module, so the recipe the bar renders
 * and the ranking the route ran are the same object rather than two descriptions that
 * drift.
 *
 * ⭐ **The mix stage is not decoration.** A stream of every creator, newest first, hands
 * the page to whoever posts most; `interleaveByAuthor` is the smallest rule that keeps
 * one busy account from filling it, and it never drops an entry. The reference for the
 * shape, and for saying the stages out loud, is MySky's open feed infrastructure
 * (https://atproto.com/blog/mysky-feed-infrastructure).
 *
 * ⭐ **A recipe is a choice at each stage, and every choice is one the route obeys.**
 * The candidate set is the feed's `scope` (`everyone` is the whole site, `network` is the
 * creator set the Network tab reads), the mix is `spread` or `straight`, and the window
 * narrows what came back. There is deliberately no third candidate source or second
 * signal offered: a control whose only setting is the one already chosen is a costume,
 * not a recipe.
 *
 * ⭐ **Every entry carries a reason.** `reasonForSource` turns the feed's `source` into
 * the structured object a card renders (visually where it differs, as its accessible
 * name where the whole stream shares one), which is the machine-readable half of the
 * layered feed's "why am I seeing this" milestone. Labels are prose; `code` is what a
 * client may switch on and is never parsed out of the label.
 */

/** The three stages every Discovery recipe names, in the reading order of its bar. */
export const DISCOVERY_STAGES = ["candidates", "signals", "mix"] as const;
export type DiscoveryStage = (typeof DISCOVERY_STAGES)[number];

/** The heading each stage renders under. */
export const DISCOVERY_STAGE_LABELS: Record<DiscoveryStage, string> = {
	candidates: "Candidates",
	signals: "Signals",
	mix: "Mix",
};

/**
 * Why a feed entry is in front of the reader, as the API states it. `discovery` is
 * unique to Discovery's whole-site stream; the rest are the network feed's own routes in.
 */
export const FEED_ENTRY_SOURCES = ["own", "following", "subscribed", "saved", "discovery"] as const;
export type FeedEntrySource = (typeof FEED_ENTRY_SOURCES)[number];

export interface DiscoveryReason {
	/** The stage that put the entry there. */
	stage: DiscoveryStage;
	/** Stable code; the label beside it is prose and may change. */
	code: FeedEntrySource;
	/** The sentence a card renders, or announces. */
	label: string;
}

/** One stage of a recipe, as the bar shows it. */
export interface RecipeStage {
	stage: DiscoveryStage;
	label: string;
}

/** A recipe the page can render and a reader can hold the ranking against. */
export interface DiscoveryRecipe {
	/** One sentence saying what the recipe does. */
	sentence: string;
	/** The three stages, each saying what it did in this run. */
	stages: RecipeStage[];
}

/** The recipe's window, over the entries the route already returned. */
export const RECIPE_WINDOWS = ["all", "day", "week"] as const;
export type RecipeWindow = (typeof RECIPE_WINDOWS)[number];

/**
 * Which creators a recipe may draw from: everyone on Anthers, or the network the
 * reader built (follows, Badge subscriptions, and the creators behind saved or
 * purchased work). The second is the same creator set the Network tab reads.
 */
export const RECIPE_CANDIDATES = ["everyone", "network"] as const;
export type RecipeCandidates = (typeof RECIPE_CANDIDATES)[number];

/**
 * How the recipe orders the page it drew: interleaved one card per creator per round,
 * or left in the order the signals gave it.
 */
export const RECIPE_MIXES = ["spread", "straight"] as const;
export type RecipeMix = (typeof RECIPE_MIXES)[number];

/**
 * The three URL values a recipe is made of, parsed once so the page and the route agree
 * on what an absent or misspelled parameter means. Each default is the recipe Discovery
 * opens with, so a bare `/discovery` is a real recipe rather than a broken one.
 */
export function asRecipeWindow(value: string | null | undefined): RecipeWindow {
	return (RECIPE_WINDOWS as readonly string[]).includes(value ?? "")
		? (value as RecipeWindow)
		: "all";
}

export function asRecipeCandidates(value: string | null | undefined): RecipeCandidates {
	return (RECIPE_CANDIDATES as readonly string[]).includes(value ?? "")
		? (value as RecipeCandidates)
		: "everyone";
}

export function asRecipeMix(
	value: string | null | undefined,
	fallback: RecipeMix = "spread",
): RecipeMix {
	return (RECIPE_MIXES as readonly string[]).includes(value ?? "")
		? (value as RecipeMix)
		: fallback;
}

/** Which corpus the Graph draws from: the reader's network, or everyone. */
export type GraphBasis = "network" | "followers";

const SOURCE_LABELS: Record<FeedEntrySource, string> = {
	own: "You published this",
	following: "You follow the creator",
	subscribed: "You support the creator",
	saved: "You saved this creator's work",
	discovery: "Newest across Anthers",
};

/**
 * The reason an entry is present, from the `source` the feed states for it. Every one
 * of these is a candidate-stage reason: none of them is a score, which is exactly the
 * distinction a reader is owed when a card says why it is there.
 */
export function reasonForSource(source: FeedEntrySource): DiscoveryReason {
	return { stage: "candidates", code: source, label: SOURCE_LABELS[source] };
}

/**
 * Whether a value the client received is a reason it can render. The API's JSON is
 * untrusted at the type boundary, and a tile that printed an object would be worse
 * than one that stayed quiet.
 */
export function isDiscoveryReason(value: unknown): value is DiscoveryReason {
	if (typeof value !== "object" || value == null) return false;
	const reason = value as Record<string, unknown>;
	return (
		typeof reason.label === "string" &&
		typeof reason.code === "string" &&
		(DISCOVERY_STAGES as readonly string[]).includes(reason.stage as string)
	);
}

/**
 * Interleave entries so one creator contributes one card per round, in the order their
 * first card appeared. The input is already ranked (newest first, today), so the output
 * reads as "the newest of everyone, then the next of everyone" rather than as a
 * re-ranking.
 *
 * Nothing is dropped and nothing is duplicated: `interleaveByAuthor` is a permutation,
 * so a caller may cap the result afterwards and know the cap fell on a mixed page. An
 * entry with no author is its own round-robin lane — grouping unknowns would interleave
 * unrelated entries as though one person had made them all.
 */
export function interleaveByAuthor<T>(
	entries: readonly T[],
	authorOf: (entry: T) => string | number | null | undefined,
): T[] {
	const buckets = new Map<string, T[]>();
	const lanes: string[] = [];

	entries.forEach((entry, index) => {
		const author = authorOf(entry);
		const key = author == null ? `\u0000${index}` : `${typeof author}:${author}`;
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(entry);
			return;
		}
		buckets.set(key, [entry]);
		lanes.push(key);
	});

	const deepest = lanes.reduce((most, key) => Math.max(most, buckets.get(key)?.length ?? 0), 0);
	const mixed: T[] = [];
	for (let round = 0; round < deepest; round += 1) {
		for (const key of lanes) {
			const bucket = buckets.get(key);
			if (bucket && round < bucket.length) mixed.push(bucket[round]);
		}
	}
	return mixed;
}

/**
 * Discovery's recipe: the newest Works and Posts from the candidate set the reader
 * chose, over the window they chose, ordered the way they chose. The window is applied
 * by the page over the page the route returned, so it is stated here rather than
 * pretending the server filtered it; the candidate and mix stages are the route's own.
 */
export function streamRecipe(input: {
	window: RecipeWindow;
	candidates: RecipeCandidates;
	mix: RecipeMix;
}): DiscoveryRecipe {
	const windowLabel =
		input.window === "day"
			? "Published in the last 24 hours, newest first"
			: input.window === "week"
				? "Published in the last seven days, newest first"
				: "Newest first";
	const windowClause =
		input.window === "day"
			? ", from the last 24 hours"
			: input.window === "week"
				? ", from the last seven days"
				: "";
	const candidateLabel =
		input.candidates === "network"
			? "You and the creators you follow, support or have saved"
			: "Every creator's newest Works and Posts";
	const candidateClause =
		input.candidates === "network"
			? "by you and the creators you follow, support or have saved"
			: "across Anthers";
	const mixLabel =
		input.mix === "spread" ? "One card per creator per round" : "Straight, no interleaving";

	return {
		sentence: `The newest Works and Posts ${candidateClause}${windowClause}, ${
			input.mix === "spread" ? "mixed so one creator cannot take the page" : "with no mixing pass"
		}.`,
		stages: [
			{ stage: "candidates", label: candidateLabel },
			{ stage: "signals", label: windowLabel },
			{ stage: "mix", label: mixLabel },
		],
	};
}

/**
 * The Graph's recipe. With a network to trace, the candidate set is the creators the
 * people the reader follows follow, and the one signal is how many of those people
 * share the follow; with nobody followed, the route says so and falls back to follower
 * count, which this builder renders as the recipe it actually ran.
 *
 * No page draws this today: the graph ranks nearly everyone a reader can already see
 * until there is enough content for the edges to say something. It stays beside
 * `GET /me/graph` for the page that returns to it.
 */
export function graphRecipe(input: { basis: GraphBasis; minShared: number }): DiscoveryRecipe {
	if (input.basis === "followers") {
		return {
			sentence:
				"You follow nobody yet, so there is no network to trace. This shows creators ordered by followers; it becomes a map of your network as soon as you follow someone.",
			stages: [
				{ stage: "candidates", label: "Every creator" },
				{ stage: "signals", label: "Follower count" },
				{ stage: "mix", label: "Ranked straight, one card per creator" },
			],
		};
	}

	return {
		sentence: `Creators followed by at least ${input.minShared} of the people you follow, ranked by how many of them share the follow.`,
		stages: [
			{ stage: "candidates", label: "Creators the people you follow follow" },
			{
				stage: "signals",
				label: `How many of those people share the follow (at least ${input.minShared})`,
			},
			{ stage: "mix", label: "Ranked straight, one card per creator" },
		],
	};
}
