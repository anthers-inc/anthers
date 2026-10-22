// SPDX-License-Identifier: Apache-2.0
/**
 * `discovery`'s suite — the two claims Discovery's formula bar makes: the mix is a real
 * permutation that spreads one creator's run across the page, and the stages the bar
 * renders say what actually ran on both modes.
 *
 * 🚨 **The absence is half the test.** An `interleaveByAuthor` that returned its input
 * unchanged would pass every "every entry survives" assertion, so each mix test names
 * the order it must not produce, not only the entries it must contain.
 */
import { describe, expect, test } from "bun:test";
import {
	type DiscoveryReason,
	graphFormula,
	interleaveByAuthor,
	isDiscoveryReason,
	reasonForSource,
	tickerFormula,
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

	test("says the Ticker's own reason rather than borrowing a follow", () => {
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

describe("the formula bar's stages", () => {
	test("names all three stages for both Ticker windows", () => {
		for (const window of ["all", "day", "week"] as const) {
			const formula = tickerFormula({ window });
			expect(formula.stages.map((stage) => stage.stage)).toEqual(["candidates", "signals", "mix"]);
			expect(formula.sentence).toContain("newest Works and Posts");
		}
	});

	test("states the window the reader chose and the mix that actually ran", () => {
		expect(tickerFormula({ window: "day" }).sentence).toContain("last 24 hours");
		expect(tickerFormula({ window: "week" }).stages[1]?.label).toContain("seven days");
		expect(tickerFormula({ window: "all" }).stages[1]?.label).toBe("Newest first");
		expect(tickerFormula({ window: "all" }).stages[2]?.label).toBe(
			"One card per creator per round",
		);
	});

	test("renders the graph's follower fallback as the formula that ran, not the network one", () => {
		const fallback = graphFormula({ basis: "followers", minShared: 2 });
		expect(fallback.sentence).toContain("You follow nobody yet");
		expect(fallback.stages.map((stage) => stage.label)).toEqual([
			"Every creator",
			"Follower count",
			"Ranked straight, one card per creator",
		]);

		const network = graphFormula({ basis: "network", minShared: 3 });
		expect(network.sentence).toContain("at least 3 of the people you follow");
		expect(network.stages[1]?.label).toContain("at least 3");
	});
});
