// SPDX-License-Identifier: Apache-2.0
/**
 * `discovery`'s suite — the claims Discovery's recipe bar makes: the mix is a real
 * permutation that spreads one creator's run across the page, the stages the bar
 * renders say what actually ran, and the Graph's deferred recipe still names the
 * fallback it would run.
 *
 * 🚨 **The absence is half the test.** An `interleaveByAuthor` that returned its input
 * unchanged would pass every "every entry survives" assertion, so each mix test names
 * the order it must not produce, not only the entries it must contain.
 */
import { describe, expect, test } from "bun:test";
import {
	asRecipeCandidates,
	asRecipeColor,
	asRecipeMix,
	asRecipeWindow,
	choiceForRecipe,
	DEFAULT_RECIPE,
	type DiscoveryReason,
	graphRecipe,
	interleaveByAuthor,
	isDiscoveryReason,
	nextRecipeColor,
	presetFor,
	RECIPE_CANDIDATE_LABELS,
	RECIPE_CANDIDATES,
	RECIPE_COLOR_VALUES,
	RECIPE_COLORS,
	RECIPE_PRESETS,
	reasonForSource,
	recipeChoices,
	recipeFrom,
	recipePath,
	recipeQuery,
	SAVED_RECIPE_LABEL_MAX,
	SAVED_RECIPE_LIMIT,
	type SavedRecipe,
	sameRecipe,
	savedRecipesFrom,
	streamRecipe,
	suggestedRecipeName,
} from "./discovery";

type Entry = { id: number; creatorId: number | null };

const author = (entry: Entry) => entry.creatorId;

describe("interleaveByAuthor", () => {
	test("gives every creator one card before any creator gets a second", () => {
		const entries: Entry[] = [
			{ id: 1, creatorId: 10 },
			{ id: 2, creatorId: 10 },
			{ id: 3, creatorId: 10 },
			{ id: 4, creatorId: 20 },
			{ id: 5, creatorId: 20 },
			{ id: 6, creatorId: 30 },
		];

		const mixed = interleaveByAuthor(entries, author).map((entry) => entry.id);

		expect(mixed).toEqual([1, 4, 6, 2, 5, 3]);
		// Newest-first unchanged would be the flood this stage exists to prevent.
		expect(mixed).not.toEqual([1, 2, 3, 4, 5, 6]);
	});

	test("keeps the newest of each creator in the order those cards first appeared", () => {
		const entries: Entry[] = [
			{ id: 1, creatorId: 30 },
			{ id: 2, creatorId: 20 },
			{ id: 3, creatorId: 10 },
		];

		expect(interleaveByAuthor(entries, author).map((entry) => entry.id)).toEqual([1, 2, 3]);
	});

	test("drops and duplicates nothing, whatever the shape of the run", () => {
		const entries: Entry[] = [
			{ id: 1, creatorId: 7 },
			{ id: 2, creatorId: 7 },
			{ id: 3, creatorId: 8 },
			{ id: 4, creatorId: 9 },
			{ id: 5, creatorId: 8 },
			{ id: 6, creatorId: 7 },
		];

		const mixed = interleaveByAuthor(entries, author);
		expect(mixed.map((entry) => entry.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
		expect(mixed).toHaveLength(entries.length);
	});

	test("gives an entry with no author its own lane rather than a shared bucket", () => {
		const entries: Entry[] = [
			{ id: 1, creatorId: null },
			{ id: 2, creatorId: null },
			{ id: 3, creatorId: 10 },
		];

		// The two unknown authors are unrelated entries; treating them as one person
		// would push the second below the creator's first card, saying something false
		// about who made it.
		expect(interleaveByAuthor(entries, author).map((entry) => entry.id)).toEqual([1, 2, 3]);
	});

	test("leaves a single creator and an empty stream alone", () => {
		const one: Entry[] = [
			{ id: 1, creatorId: 10 },
			{ id: 2, creatorId: 10 },
		];
		expect(interleaveByAuthor(one, author).map((entry) => entry.id)).toEqual([1, 2]);
		expect(interleaveByAuthor([] as Entry[], author)).toEqual([]);
	});

	test("distinguishes a numeric key from the string that spells it", () => {
		const entries = [
			{ id: 1, key: 10 as string | number },
			{ id: 2, key: "10" as string | number },
		];
		expect(interleaveByAuthor(entries, (entry) => entry.key).map((entry) => entry.id)).toEqual([
			1, 2,
		]);
	});
});

describe("reasonForSource", () => {
	test("names each route into the feed, and keeps the code machine-readable", () => {
		const reasons = (["own", "following", "subscribed", "saved", "discovery"] as const).map(
			reasonForSource,
		);

		expect(reasons.map((reason) => reason.code)).toEqual([
			"own",
			"following",
			"subscribed",
			"saved",
			"discovery",
		]);
		for (const reason of reasons) {
			expect(reason.stage).toBe("candidates");
			expect(reason.label.length).toBeGreaterThan(0);
		}
	});

	test("says Discovery's own reason rather than borrowing a follow", () => {
		expect(reasonForSource("discovery").label).toBe("Newest across Anthers");
		expect(reasonForSource("discovery").code).not.toBe("following");
	});

	test("refuses a reason the client cannot render", () => {
		const valid: DiscoveryReason = { stage: "mix", code: "discovery", label: "Mixed" };
		expect(isDiscoveryReason(valid)).toBe(true);
		expect(isDiscoveryReason({ stage: "ranking", code: "discovery", label: "Mixed" })).toBe(false);
		expect(isDiscoveryReason({ stage: "mix", code: "discovery" })).toBe(false);
		expect(isDiscoveryReason("why am I seeing this")).toBe(false);
		expect(isDiscoveryReason(null)).toBe(false);
	});
});

describe("the recipe bar's stages", () => {
	const recipe = (overrides: Partial<Parameters<typeof streamRecipe>[0]> = {}) =>
		streamRecipe({ window: "all", candidates: "everyone", mix: "spread", ...overrides });

	test("names all three stages for every window", () => {
		for (const window of ["all", "day", "week"] as const) {
			const built = recipe({ window });
			expect(built.stages.map((stage) => stage.stage)).toEqual(["candidates", "signals", "mix"]);
			expect(built.sentence).toContain("newest Works and Posts");
		}
	});

	test("states the window the reader chose and the mix that actually ran", () => {
		expect(recipe({ window: "day" }).sentence).toContain("last 24 hours");
		expect(recipe({ window: "week" }).stages[1]?.label).toContain("seven days");
		expect(recipe({ window: "all" }).stages[1]?.label).toBe("Newest first");
		expect(recipe({ window: "all" }).stages[2]?.label).toBe("One card per creator per round");
	});

	test("says when the stream is drawn from the reader's network, and not when it is not", () => {
		const network = recipe({ candidates: "network" });
		expect(network.sentence).toContain("by you and the creators you follow, support or have saved");
		expect(network.stages[0]?.label).toBe("You and the creators you follow, support or have saved");

		const everyone = recipe({ candidates: "everyone" });
		expect(everyone.sentence).toContain("across Anthers");
		expect(everyone.sentence).not.toContain("you and the creators");
	});

	test("says when the reader turned the mix off, and the stage list changes with it", () => {
		const straight = recipe({ mix: "straight" });
		expect(straight.sentence).toContain("with no mixing pass");
		expect(straight.sentence).not.toContain("mixed so one creator");
		expect(straight.stages[2]?.label).toBe("Straight, no interleaving");

		expect(recipe({ mix: "spread" }).sentence).toContain(
			"mixed so one creator cannot take the page",
		);
	});

	test("renders every combination as a sentence that names all three choices", () => {
		for (const candidates of ["everyone", "network"] as const) {
			for (const mix of ["spread", "straight"] as const) {
				for (const window of ["all", "day", "week"] as const) {
					const built = recipe({ candidates, mix, window });
					expect(built.stages).toHaveLength(3);
					expect(built.stages.every((stage) => stage.label.length > 0)).toBe(true);
					expect(built.sentence.endsWith(".")).toBe(true);
				}
			}
		}
	});

	test("renders the graph's follower fallback as the recipe that ran, not the network one", () => {
		const fallback = graphRecipe({ basis: "followers", minShared: 2 });
		expect(fallback.sentence).toContain("You follow nobody yet");
		expect(fallback.stages.map((stage) => stage.label)).toEqual([
			"Every creator",
			"Follower count",
			"Ranked straight, one card per creator",
		]);

		const network = graphRecipe({ basis: "network", minShared: 3 });
		expect(network.sentence).toContain("at least 3 of the people you follow");
		expect(network.stages[1]?.label).toContain("at least 3");
	});
});

describe("the recipe's URL values", () => {
	test("reads each value it knows and falls back to the opening recipe for the rest", () => {
		expect(asRecipeWindow("day")).toBe("day");
		expect(asRecipeWindow("fortnight")).toBe("all");
		expect(asRecipeWindow(null)).toBe("all");

		expect(asRecipeCandidates("network")).toBe("network");
		expect(asRecipeCandidates("friends")).toBe("everyone");
		expect(asRecipeCandidates(undefined)).toBe("everyone");

		expect(asRecipeMix("straight")).toBe("straight");
		expect(asRecipeMix("random")).toBe("spread");
		expect(asRecipeMix("")).toBe("spread");
		// The route's opening mix depends on the candidate set, so the parser takes the
		// fallback rather than deciding one for every caller.
		expect(asRecipeMix(null, "straight")).toBe("straight");
	});
});

describe("the candidate stage covers the whole membership narrowing", () => {
	/**
	 * The three membership values are the reason the Network tab could retire: they were
	 * the one control Discovery lacked, and they are answers to the same question the
	 * candidate stage asks. A suite that only knew `everyone` and `network` would let a
	 * narrower value reach the page and silently draw the whole network.
	 */
	test("names every route into the candidate set", () => {
		expect([...RECIPE_CANDIDATES]).toEqual([
			"everyone",
			"network",
			"following",
			"subscribed",
			"saved",
		]);
		for (const value of RECIPE_CANDIDATES) {
			expect(RECIPE_CANDIDATE_LABELS[value].length).toBeGreaterThan(0);
		}
	});

	test("turns each value into the route's own parameters", () => {
		expect(recipeQuery("everyone", "spread")).toEqual({ scope: "global", mix: "spread" });
		expect(recipeQuery("network", "straight")).toEqual({ scope: "network", mix: "straight" });
		// The narrowed three are the network scope plus the `network_source` the feed route
		// already read — not a third kind of request.
		for (const value of ["following", "subscribed", "saved"] as const) {
			expect(recipeQuery(value, "straight")).toEqual({
				scope: "network",
				network_source: value,
				mix: "straight",
			});
		}
	});

	test("says which candidate set drew the page, per value", () => {
		expect(
			streamRecipe({ window: "all", candidates: "following", mix: "straight" }).stages[0]?.label,
		).toBe("The creators you follow");
		expect(
			streamRecipe({ window: "all", candidates: "saved", mix: "straight" }).stages[0]?.label,
		).toBe("Creators you saved work from or bought from");
	});
});

describe("the presets", () => {
	test("opens on My Network, which is the retired Network tab", () => {
		expect(DEFAULT_RECIPE).toEqual({ window: "all", candidates: "network", mix: "straight" });
		expect(RECIPE_PRESETS[0]?.id).toBe("my-network");
		expect(RECIPE_PRESETS[0]?.label).toBe("My Network");
	});

	test("matches a preset exactly, and nothing for a recipe it would not reproduce", () => {
		expect(presetFor(RECIPE_PRESETS[0].recipe)?.id).toBe("my-network");
		expect(presetFor(RECIPE_PRESETS[1].recipe)?.id).toBe("across-anthers");
		// One stage away from a preset is no preset: a chip that lit up here would lie
		// about what clicking it does.
		expect(presetFor({ ...RECIPE_PRESETS[0].recipe, window: "week" })).toBeNull();
		expect(presetFor({ ...RECIPE_PRESETS[1].recipe, mix: "straight" })).toBeNull();
	});

	test("gives every preset a stable id and a blurb", () => {
		const ids = new Set<string>();
		for (const preset of RECIPE_PRESETS) {
			expect(preset.id).not.toBe("");
			expect(ids.has(preset.id)).toBe(false);
			ids.add(preset.id);
			expect(preset.blurb.length).toBeGreaterThan(10);
		}
	});
});

describe("a stored recipe", () => {
	test("reads back as the same recipe", () => {
		expect(recipeFrom({ window: "week", candidates: "following", mix: "straight" })).toEqual({
			window: "week",
			candidates: "following",
			mix: "straight",
		});
	});

	test("falls back to the opening recipe when the account never chose", () => {
		expect(recipeFrom(null)).toEqual(DEFAULT_RECIPE);
		expect(recipeFrom(undefined)).toEqual(DEFAULT_RECIPE);
	});

	test("degrades a value this build does not know rather than carrying it", () => {
		expect(recipeFrom({ window: "fortnight", candidates: "friends", mix: "chaos" })).toEqual({
			window: "all",
			candidates: "everyone",
			mix: "spread",
		});
	});

	test("writes every stage into a link, so the link means the recipe in full", () => {
		expect(recipePath({ window: "all", candidates: "network", mix: "straight" })).toBe(
			"/discovery?window=all&candidates=network&mix=straight",
		);
	});
});

describe("a reader's saved recipes", () => {
	const mine: SavedRecipe = {
		id: "seed-1",
		label: "Close friends",
		color: "rose",
		recipe: { window: "all", candidates: "following", mix: "straight" },
	};

	test("gives every color a label and a value, and defaults an unknown one", () => {
		for (const color of RECIPE_COLORS) {
			expect(RECIPE_COLOR_VALUES[color].label.length).toBeGreaterThan(0);
			expect(RECIPE_COLOR_VALUES[color].hex).toMatch(/^#[0-9a-f]{6}$/);
		}
		// One accent per token: a second value would make the stored token ambiguous.
		expect(new Set(RECIPE_COLORS.map((color) => RECIPE_COLOR_VALUES[color].hex)).size).toBe(
			RECIPE_COLORS.length,
		);
		expect(asRecipeColor("chartreuse")).toBe("moss");
		expect(asRecipeColor(undefined)).toBe("moss");
	});

	test("offers a color the account is not already using", () => {
		expect(nextRecipeColor([])).toBe(RECIPE_COLORS[0]);
		// The first unused token, so a second chip is visibly a second thing.
		const second = nextRecipeColor([mine]);
		expect(second).not.toBe("rose");
		expect(RECIPE_COLORS).toContain(second);
		// A full palette cycles rather than handing back a duplicate forever.
		const all = RECIPE_COLORS.map((color, index) => ({ ...mine, id: `row-${index}`, color }));
		expect(RECIPE_COLORS).toContain(nextRecipeColor(all));
	});

	test("suggests a name from the candidate stage", () => {
		expect(suggestedRecipeName({ window: "all", candidates: "following", mix: "spread" })).toBe(
			"Creators I follow",
		);
		expect(suggestedRecipeName({ window: "week", candidates: "everyone", mix: "spread" })).toBe(
			"Everyone on Anthers",
		);
	});

	test("compares recipes by all three stages, not by identity", () => {
		expect(sameRecipe(mine.recipe, { ...mine.recipe })).toBe(true);
		expect(sameRecipe(mine.recipe, { ...mine.recipe, window: "week" })).toBe(false);
	});

	test("renders the site's presets first and the reader's own after, in their order", () => {
		const second: SavedRecipe = { ...mine, id: "seed-2", label: "Wide net", color: "sky" };
		const choices = recipeChoices([mine, second]);
		expect(choices.map((choice) => choice.label)).toEqual([
			...RECIPE_PRESETS.map((preset) => preset.label),
			"Close friends",
			"Wide net",
		]);
		expect(choices[0].savedId).toBeNull();
		expect(choices[choices.length - 1].savedId).toBe("seed-2");
		// A saved chip's blurb is its own sentence, so the title describes the recipe even
		// after the reader renames it.
		expect(choices[choices.length - 1].blurb).toBe(streamRecipe(second.recipe).sentence);
	});

	test("names the chip a recipe is, and nothing for a combination no chip names", () => {
		const choices = recipeChoices([mine]);
		expect(choiceForRecipe(choices, mine.recipe)?.savedId).toBe("seed-1");
		expect(choiceForRecipe(choices, RECIPE_PRESETS[0].recipe)?.savedId).toBeNull();
		// One stage away is no chip: a chip that lit here would lie about what a click does.
		expect(choiceForRecipe(choices, { ...mine.recipe, window: "day" })).toBeNull();
	});
});

describe("reading saved recipes from the payload", () => {
	test("parses each row, keeping the stored order", () => {
		const rows = savedRecipesFrom([
			{
				id: "a",
				label: "One",
				color: "teal",
				recipe: { window: "day", candidates: "saved", mix: "spread" },
			},
			{
				id: "b",
				label: "Two",
				color: "clay",
				recipe: { window: "all", candidates: "network", mix: "straight" },
			},
		]);
		expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
		expect(rows[0].recipe).toEqual({ window: "day", candidates: "saved", mix: "spread" });
	});

	test("drops a row this build cannot render rather than drawing a half-chip", () => {
		const rows = savedRecipesFrom([
			{ id: "", label: "No id", color: "moss", recipe: null },
			{ id: "b", label: "   ", color: "moss", recipe: null },
			// A duplicate id is one chip React cannot tell from the other, so the first wins.
			{
				id: "a",
				label: "One",
				color: "teal",
				recipe: { window: "day", candidates: "following", mix: "straight" },
			},
			{
				id: "a",
				label: "Again",
				color: "teal",
				recipe: { window: "week", candidates: "saved", mix: "spread" },
			},
		]);
		expect(rows.map((row) => row.label)).toEqual(["One"]);
	});

	test("degrades an unknown stage or color instead of dropping the recipe", () => {
		const [row] = savedRecipesFrom([
			{
				id: "a",
				label: "From a later build",
				color: "ultraviolet",
				recipe: { window: "fortnight", candidates: "friends", mix: "chaos" },
			},
		]);
		expect(row.color).toBe("moss");
		expect(row.recipe).toEqual({ window: "all", candidates: "everyone", mix: "spread" });
	});

	test("caps the label and the list", () => {
		const [row] = savedRecipesFrom([
			{
				id: "a",
				label: "x".repeat(SAVED_RECIPE_LABEL_MAX + 20),
				color: "moss",
				recipe: { window: "all", candidates: "saved", mix: "spread" },
			},
		]);
		expect(row.label.length).toBe(SAVED_RECIPE_LABEL_MAX);

		const many = Array.from({ length: SAVED_RECIPE_LIMIT + 5 }, (_, index) => ({
			id: `row-${index}`,
			label: `Recipe ${index}`,
			color: "moss",
			recipe: { window: "all", candidates: "saved", mix: "spread" },
		}));
		expect(savedRecipesFrom(many)).toHaveLength(SAVED_RECIPE_LIMIT);
	});

	test("reads null and undefined as no saved recipes", () => {
		expect(savedRecipesFrom(null)).toEqual([]);
		expect(savedRecipesFrom(undefined)).toEqual([]);
		expect(savedRecipesFrom([])).toEqual([]);
	});
});
