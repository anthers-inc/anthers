// SPDX-License-Identifier: Apache-2.0
/**
 * The Lenses section belongs to both user tabs (Parker, 2026-10-19), and every lens is
 * live on both (Parker, 2026-10-23): a lens is a view over whichever corpus the tab hands
 * it, so a per-tab live set is not a rollout schedule.
 *
 * A source-text guard: the shared component renders every row and grays the ones a tab
 * has not built, so the only per-tab choices are the `live` set and the adapter. This
 * pins the section's presence on Library and Discovery, the one all-lenses set both pass,
 * both tabs' render of all three lenses over their own corpus, Discovery's lens riding
 * the URL over its one stream, and the graying contract that keeps a future lens a
 * visible promise rather than a missing word.
 *
 * ⚠️ **The Network tab's rows moved here when it merged into Discovery (2026-10-24).**
 * Its lens adapters now serve Discovery's network-shaped recipes: the merged page picks
 * the lens's empty-state words from whether the recipe draws the whole site or the
 * reader's network, which is the distinction the two tabs used to carry.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const library = read("LibraryPage.tsx");
const discovery = read("DiscoverPage.tsx");
const section = read("../components/layout/SharedLensesSection.tsx");

const TABS = [
	["Library", library],
	["Discovery", discovery],
] as const;

/** Every lens's render branch, keyed by the id each page's adapter uses. */
const LENS_BRANCHES = ['lens === "music"', 'lens === "channel-guide"', 'lens === "bookshelf"'];

describe("the Lenses section on both tabs", () => {
	it("is rendered by Library and Discovery", () => {
		for (const [tab, source] of TABS) {
			expect(source, `${tab} does not import the shared lenses section`).toContain(
				'from "../components/layout/SharedLensesSection"',
			);
			expect(source, `${tab} does not render the shared lenses section`).toContain(
				"<SharedLensesSection",
			);
		}
	});

	it("passes the one all-lenses set on every tab", () => {
		for (const [tab, source] of TABS) {
			expect(source, `${tab} does not import the all-lenses set`).toContain("ALL_LENS_IDS");
			expect(source, `${tab} does not pass the all-lenses set`).toContain("live={ALL_LENS_IDS}");
		}
		// The set is derived from the rows, so a lens added to the vocabulary cannot be
		// forgotten on one tab.
		expect(section).toContain("export const ALL_LENS_IDS");
		expect(section).toContain("new Set(LENSES.map((lens) => lens.id))");
	});

	it("renders all three lenses on every tab", () => {
		for (const [tab, source] of TABS) {
			for (const branch of LENS_BRANCHES) {
				expect(source, `${tab} does not render ${branch.slice(8)}`).toContain(branch);
			}
		}
	});

	it("gives each tab the corpus adapter its own surface needs", () => {
		// The Library draws on the shelf, Discovery on its stream.
		expect(library).toContain("channelGuideChannelsFromShelf(lensDraw");
		expect(discovery).toContain("feedLensItems(visibleEntries)");
	});

	/**
	 * The one corpus is drawn two ways, and the lens's words follow the recipe rather than
	 * the tab. A lens over the whole site says something different from a lens over the
	 * reader's own network, and before the merge that difference was two tabs.
	 */
	it("picks the lens's corpus words from the recipe, not from a tab", () => {
		expect(discovery).toContain('const drawsEveryone = recipe.candidates === "everyone";');
		expect(discovery).toContain('scope={drawsEveryone ? "discovery" : "feed"}');
		expect(discovery).toContain('source={drawsEveryone ? "discovery" : "network"}');
	});
});

describe("Discovery carries its lens over the one stream", () => {
	it("carries the lens in the URL, with no mode beside it", () => {
		expect(discovery).toContain('searchParams.get("lens")');
		expect(discovery).toContain("updateParams({ lens: id })");
		expect(discovery).not.toContain('searchParams.get("mode")');
	});

	it("draws the lens before the page's own empty state", () => {
		// A lens with nothing to draw says so in its own words rather than showing the
		// stream's empty state above a view that organizes the stream.
		expect(discovery.indexOf('lens === "music"')).toBeGreaterThan(-1);
		expect(discovery.indexOf('lens === "music"')).toBeLessThan(
			discovery.indexOf("Nothing here yet"),
		);
	});
});

describe("an unbuilt lens is grayed, never missing", () => {
	it("renders every row and disables the unbuilt ones", () => {
		expect(section).toContain("LENSES.map");
		expect(section).toContain("disabled={!built}");
		expect(section).toContain("(Coming Soon)");
	});
});
