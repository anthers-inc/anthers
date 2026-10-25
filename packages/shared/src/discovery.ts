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
 * Which creators a recipe may draw from.
 *
 * ⭐ **The membership narrowing is a value here rather than a second control.** The
 * network is a union of follows, Badge subscriptions and the creators behind saved or
 * purchased work, and a reader who wants one route in is answering the same question
 * this stage asks — *whose work am I drawing from* — so `following`, `subscribed` and
 * `saved` are candidates rather than a filter applied after them.
 *
 * ⚠️ **This is the set that let the Network tab retire into a preset.** Before it, the
 * narrowing lived in a section of its own on a page whose every other control was a
 * recipe value; with it, one control set expresses both surfaces exactly. The feed
 * route still takes `scope` and `network_source` separately — `recipeQuery` is the one
 * place the five values become those two parameters.
 */
export const RECIPE_CANDIDATES = [
	"everyone",
	"network",
	"following",
	"subscribed",
	"saved",
] as const;
export type RecipeCandidates = (typeof RECIPE_CANDIDATES)[number];

/** What each candidate value is called, wherever a reader sees it. */
export const RECIPE_CANDIDATE_LABELS: Record<RecipeCandidates, string> = {
	everyone: "Everyone",
	network: "Everyone in your network",
	following: "Creators you follow",
	subscribed: "Creators you support",
	saved: "Saved or purchased from",
};

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

/** A whole recipe, as the URL, the account and a preset all state it. */
export interface Recipe {
	window: RecipeWindow;
	candidates: RecipeCandidates;
	mix: RecipeMix;
}

/**
 * The feed route's two parameters, from the candidate stage's one value.
 *
 * The route took `scope` and `network_source` before there was a recipe system, and
 * they still are what it reads; this is the only place the five candidate values turn
 * into the two. A caller that mapped them by hand would be the second place the
 * vocabulary lived, and the first to drift.
 */
export function recipeQuery(
	candidates: RecipeCandidates,
	mix: RecipeMix,
): {
	scope: "global" | "network";
	network_source?: "following" | "subscribed" | "saved";
	mix: RecipeMix;
} {
	if (candidates === "everyone") return { scope: "global", mix };
	if (candidates === "network") return { scope: "network", mix };
	return { scope: "network", network_source: candidates, mix };
}

/**
 * The colors a recipe chip may carry.
 *
 * ⭐ **A token rather than a hex value in the row.** The stored value names a choice; the
 * hex lives here, so a palette that has to change for contrast or for the brand does not
 * rewrite every saved recipe. The client renders the chip from this record, and the route
 * validates against the same list, which is why it sits in the shared module rather than
 * in the page.
 *
 * ⚠️ **Color is an accent, never the only signal.** Two chips can share a color, and a
 * reader who cannot distinguish them still has the label and the pressed state; the
 * swatch picker marks its selection with a check as well as a ring.
 */
export const RECIPE_COLORS = [
	"moss",
	"sky",
	"violet",
	"rose",
	"amber",
	"teal",
	"clay",
	"slate",
] as const;
export type RecipeColor = (typeof RECIPE_COLORS)[number];

export const RECIPE_COLOR_VALUES: Record<RecipeColor, { label: string; hex: string }> = {
	moss: { label: "Moss", hex: "#3f7d58" },
	sky: { label: "Sky", hex: "#2f6fae" },
	violet: { label: "Violet", hex: "#7a5db5" },
	rose: { label: "Rose", hex: "#b5486b" },
	amber: { label: "Amber", hex: "#a97612" },
	teal: { label: "Teal", hex: "#1f7f7f" },
	clay: { label: "Clay", hex: "#a5543a" },
	slate: { label: "Slate", hex: "#5b6b7a" },
};

export function asRecipeColor(value: string | null | undefined): RecipeColor {
	return (RECIPE_COLORS as readonly string[]).includes(value ?? "")
		? (value as RecipeColor)
		: "moss";
}

/** One named recipe a reader can select in a click. */
export interface RecipePreset {
	/** Stable identity, for the chip's key. Saved recipes carry their own ids. */
	id: string;
	label: string;
	/** What the preset draws, for the chip's title. */
	blurb: string;
	color: RecipeColor;
	recipe: Recipe;
}

/**
 * One recipe a reader saved, as the account stores it.
 *
 * ⭐ **The recipe is stored whole rather than as a preset id**, the same rule
 * `homeRecipe` follows: a saved chip is a name and a color over three values, so it keeps
 * working when a built-in preset is renamed or retired, and a combination no preset would
 * ever name can be saved at all.
 */
export interface SavedRecipe {
	/** Client-generated and stable for the row's life; the chips key on it. */
	id: string;
	label: string;
	color: RecipeColor;
	recipe: Recipe;
}

/** How many recipes one account may hold. A line of chips is the surface; this keeps it. */
export const SAVED_RECIPE_LIMIT = 24;

/** The longest name a chip renders without crowding every other chip. */
export const SAVED_RECIPE_LABEL_MAX = 40;

/**
 * The color a newly saved recipe opens with: the first one this account has not used, so
 * a second chip is visibly a second thing, and a reader who has used the whole palette
 * cycles rather than getting a duplicate everywhere.
 */
export function nextRecipeColor(saved: readonly SavedRecipe[]): RecipeColor {
	const used = new Set(saved.map((recipe) => recipe.color));
	return (
		RECIPE_COLORS.find((color) => !used.has(color)) ??
		RECIPE_COLORS[saved.length % RECIPE_COLORS.length]
	);
}

/**
 * What a newly saved recipe is called before the reader renames it.
 *
 * The candidate stage is the part that makes one recipe different from another at a
 * glance, so the suggestion names that rather than the whole sentence. It is a
 * suggestion: the name field opens with it selected, and every chip is renameable.
 */
export function suggestedRecipeName(recipe: Recipe): string {
	const names: Record<RecipeCandidates, string> = {
		everyone: "Everyone on Anthers",
		network: "My network",
		following: "Creators I follow",
		subscribed: "Creators I support",
		saved: "Creators I saved",
	};
	return names[recipe.candidates];
}

/** Whether two recipes name the same three stages. */
export function sameRecipe(a: Recipe, b: Recipe): boolean {
	return a.window === b.window && a.candidates === b.candidates && a.mix === b.mix;
}

/** One chip in the row: a built-in preset, or a recipe this reader saved. */
export interface RecipeChoice extends RecipePreset {
	/** The saved recipe this choice is, or null for a built-in. */
	savedId: string | null;
}

/**
 * The chips, in the order they render: the site's presets first, then the reader's own in
 * the order they arranged them.
 *
 * Built-ins ahead of saved recipes is the one ordering the reader cannot change, because
 * they are different kinds of thing — the site's named recipes come first and stay put.
 * The saved ones are moveable among themselves, which is what "which of them renders
 * first" means.
 */
export function recipeChoices(saved: readonly SavedRecipe[]): RecipeChoice[] {
	return [
		...RECIPE_PRESETS.map((preset) => ({ ...preset, savedId: null })),
		...saved.map((recipe) => ({
			id: `saved:${recipe.id}`,
			label: recipe.label,
			blurb: streamRecipe(recipe.recipe).sentence,
			color: recipe.color,
			recipe: recipe.recipe,
			savedId: recipe.id,
		})),
	];
}

/**
 * The choice a recipe is, or null for a combination no chip names.
 *
 * Exact rather than nearest, for `presetFor`'s reason: a chip that lit up for a recipe it
 * would not reproduce is a chip that lies about what a click does.
 */
export function choiceForRecipe(
	choices: readonly RecipeChoice[],
	recipe: Recipe,
): RecipeChoice | null {
	return choices.find((choice) => sameRecipe(choice.recipe, recipe)) ?? null;
}

/**
 * Saved recipes as the account payload delivers them, parsed row by row.
 *
 * The payload is untrusted at the type boundary and may predate this build. A row missing
 * an id, a name or a recipe is left out rather than rendered as a half-chip; a stage or a
 * color this build does not recognize degrades to its default instead, so a row written by
 * a later build still opens the reader's own name and recipe rather than vanishing.
 * Duplicate ids keep the first: two chips with one key are one chip React cannot tell from
 * the other.
 */
export function savedRecipesFrom(
	raw:
		| ReadonlyArray<{
				id?: unknown;
				label?: unknown;
				color?: unknown;
				recipe?: { window?: unknown; candidates?: unknown; mix?: unknown } | null;
		  }>
		| null
		| undefined,
): SavedRecipe[] {
	if (!raw) return [];
	const seen = new Set<string>();
	const out: SavedRecipe[] = [];
	for (const row of raw) {
		if (out.length >= SAVED_RECIPE_LIMIT) break;
		if (typeof row?.id !== "string" || row.id === "" || seen.has(row.id)) continue;
		if (typeof row.label !== "string" || row.label.trim() === "") continue;
		if (typeof row.recipe !== "object" || row.recipe === null) continue;
		const parsed = recipeFrom({
			window: typeof row.recipe?.window === "string" ? row.recipe.window : null,
			candidates: typeof row.recipe?.candidates === "string" ? row.recipe.candidates : null,
			mix: typeof row.recipe?.mix === "string" ? row.recipe.mix : null,
		});
		seen.add(row.id);
		out.push({
			id: row.id,
			label: row.label.slice(0, SAVED_RECIPE_LABEL_MAX),
			color: asRecipeColor(typeof row.color === "string" ? row.color : null),
			recipe: parsed,
		});
	}
	return out;
}

/**
 * The presets a new account starts with, in the order the chips render.
 *
 * ⭐ **My Network first, because it is where a new account opens.** The merged Discovery
 * was the Network tab's home as much as its own, and a reader whose only interest is the
 * chronological feed should land on it without learning the recipe system first — the
 * preset is that page, named.
 *
 * ⭐ **Across Anthers is the opening recipe Discovery always had.** It stays second
 * rather than first: the whole site's newest entries are what a reader goes looking for,
 * and the feed is what they come back for.
 *
 * ⭐ **These are the site's own recipes, and they stay code.** A reader's saved recipes are
 * rows on their account (`savedRecipes`), rendered after these; a built-in is not
 * renameable, deletable or reorderable because it is not the reader's to change. Both
 * kinds reach the chips through `recipeChoices`, so the row does not care which is which.
 */
export const RECIPE_PRESETS: readonly RecipePreset[] = [
	{
		id: "my-network",
		label: "My Network",
		blurb: "Works and Posts from you and the creators you follow, support or have saved.",
		color: "moss",
		recipe: { window: "all", candidates: "network", mix: "straight" },
	},
	{
		id: "across-anthers",
		label: "Across Anthers",
		blurb: "The newest Works and Posts from every creator on Anthers.",
		color: "sky",
		recipe: { window: "all", candidates: "everyone", mix: "spread" },
	},
];

/** The recipe a reader lands on when their account has never chosen one. */
export const DEFAULT_RECIPE: Recipe = RECIPE_PRESETS[0].recipe;

/**
 * The preset whose recipe is exactly this one, or null for a combination no preset
 * names.
 *
 * Exact rather than nearest: a chip that lit up for a recipe it would not reproduce is
 * a chip that lies about what a click does. A reader who has narrowed My Network to
 * "Creators you follow" is on no preset, and the chips say so.
 */
export function presetFor(recipe: Recipe): RecipePreset | null {
	return (
		RECIPE_PRESETS.find(
			(preset) =>
				preset.recipe.window === recipe.window &&
				preset.recipe.candidates === recipe.candidates &&
				preset.recipe.mix === recipe.mix,
		) ?? null
	);
}

/**
 * A recipe as stored or as received, parsed stage by stage.
 *
 * Null — an account that never answered — reads as `DEFAULT_RECIPE`, so the merged tab
 * opens on My Network without a row being written. A stage this build does not know
 * degrades to that stage's opening value rather than to the whole default: a future
 * build's new candidate name still opens the reader's saved window and mix.
 */
export function recipeFrom(
	raw:
		| { window?: string | null; candidates?: string | null; mix?: string | null }
		| null
		| undefined,
): Recipe {
	if (!raw) return DEFAULT_RECIPE;
	return {
		window: asRecipeWindow(raw.window),
		candidates: asRecipeCandidates(raw.candidates),
		mix: asRecipeMix(raw.mix),
	};
}

/**
 * A recipe as a `/discovery` address, for a link that names one.
 *
 * Every stage is written rather than only the ones that differ from a default, so the
 * address means the recipe in full: a link that left a stage out would mean "whatever
 * the account says" for that stage, which is right for a bare tab link and wrong for one
 * that names a recipe.
 */
export function recipePath(recipe: Recipe): string {
	const params = new URLSearchParams({
		window: recipe.window,
		candidates: recipe.candidates,
		mix: recipe.mix,
	});
	return `/discovery?${params.toString()}`;
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
	// Each candidate value says what it draws in the stage row, and how the sentence
	// reads around it. Two records rather than one sentence per value: the stage row is a
	// noun phrase and the sentence needs a preposition, and trying to share one string
	// between them produces prose that reads like a database row.
	const candidateLabel: Record<RecipeCandidates, string> = {
		everyone: "Every creator's newest Works and Posts",
		network: "You and the creators you follow, support or have saved",
		following: "The creators you follow",
		subscribed: "The creators you support",
		saved: "Creators you saved work from or bought from",
	};
	const candidateClause: Record<RecipeCandidates, string> = {
		everyone: "across Anthers",
		network: "by you and the creators you follow, support or have saved",
		following: "by the creators you follow",
		subscribed: "by the creators you support",
		saved: "by creators you saved from or bought from",
	};
	const mixLabel =
		input.mix === "spread" ? "One card per creator per round" : "Straight, no interleaving";

	return {
		sentence: `The newest Works and Posts ${candidateClause[input.candidates]}${windowClause}, ${
			input.mix === "spread" ? "mixed so one creator cannot take the page" : "with no mixing pass"
		}.`,
		stages: [
			{ stage: "candidates", label: candidateLabel[input.candidates] },
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
