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
	asRecipeMix,
	asRecipeWindow,
	type DiscoveryReason,
	graphRecipe,
	interleaveByAuthor,
	isDiscoveryReason,
	reasonForSource,
	streamRecipe,
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
