// SPDX-License-Identifier: Apache-2.0
/**
 * The two-tab rework's structural contract (Parker, 2026-10-24).
 *
 * A source-text guard in the family of `basket-layout.test.ts`: the pieces that make
 * Library and Discovery one family are a shared header, one nav vocabulary, and a
 * Discovery body that shows one stream under a recipe the reader can see and change.
 * Each is a decision a refactor can quietly undo — a page growing its own heading again,
 * a retired tab surviving beside its replacement, a second mode picker creeping back over
 * a single stream — so each is pinned here.
 *
 * ⚠️ **This file guarded three tabs until the merge.** Network retired into Discovery as
 * the My Network recipe preset, so the guards that pinned it as a page now pin its
 * absence: no Network page in the router, one redirect that lands on the preset, and the
 * membership narrowing living as candidate values rather than as a section of its own.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const library = read("LibraryPage.tsx");
const discovery = read("DiscoverPage.tsx");
const layout = read("../components/layout/LoggedInLayout.tsx");
const tabs = read("../lib/user-tabs.ts");
const app = read("../App.tsx");

describe("the two user tabs share one header", () => {
	it("renders TabHeader on both pages", () => {
		for (const [page, source] of [
			["Library", library],
			["Discovery", discovery],
		] as const) {
			expect(source, `${page} does not import the shared header`).toContain(
				'from "../components/layout/TabHeader"',
			);
			expect(source, `${page} does not render the shared header`).toContain("<TabHeader");
		}
	});

	it("carries the settled copy on each tab", () => {
		expect(library).toContain(
			"All of the Works, Projects, and Posts you've purchased or otherwise saved",
		);
		// The merged tab's subtitle has to be true of both jobs it now does: the reader's
		// own network and the whole site. The anti-algorithm claim is the part of the old
		// copy that survives verbatim, because it is a promise rather than a description.
		expect(discovery).toContain("Your network, and everything else on Anthers");
		expect(discovery).toContain("There's no paid promotion or hidden algorithms");
	});
});

describe("the two user tabs share one page shell", () => {
	/**
	 * The header sits inside each page's own wrapper, not in the layout, so the wrapper's
	 * padding is what places it. Library carried `container mx-auto px-4 py-8` and its
	 * header sat eight pixels off in both directions beside the other's `px-6 py-6`.
	 */
	it("pads every tab's content area the same way", () => {
		for (const [page, source] of [
			["Library", library],
			["Discovery", discovery],
		] as const) {
			expect(source, `${page} does not use the shared content padding`).toContain("px-6 py-6");
		}
	});

	it("brings no padded container of its own", () => {
		for (const [page, source] of [
			["Library", library],
			["Discovery", discovery],
		] as const) {
			expect(source, `${page} wraps its content in a container`).not.toContain(
				"container mx-auto px-4",
			);
		}
	});

	/**
	 * The grid was the one visual difference the two pages kept to the end: the feed used
	 * an auto-filling 280px minimum and Discovery a fixed four-column ladder, so the same
	 * cards breathed differently depending on which tab you were on. One stream means one
	 * geometry.
	 */
	it("draws the stream on the feed's auto-filling grid", () => {
		expect(discovery).toContain("repeat(auto-fill,minmax(280px,1fr))");
		expect(discovery, "the old fixed ladder is back").not.toContain("xl:grid-cols-4");
	});

	/**
	 * The width, not only the columns. Discovery's centered `max-w-7xl` container capped the
	 * grid 48 pixels short of the content area at a wide window, which is the difference the
	 * old feed's full-width wrapper existed to avoid.
	 */
	it("lets the grid use the width the layout gives it", () => {
		expect(discovery).not.toContain("max-w-7xl");
		expect(discovery).toContain('<div className="w-full px-6 py-6">');
	});
});

describe("the nav speaks the one vocabulary", () => {
	it("orders the tabs Library and Discovery", () => {
		const links = [
			...tabs.matchAll(/to: "(\/[a-z]+)",\s+id: "([a-z]+)",\s+label: "([A-Za-z]+)"/g),
		].map((match) => [match[1], match[3]]);
		expect(links).toEqual([
			["/library", "Library"],
			["/discovery", "Discovery"],
		]);
	});

	it("offers no way to rearrange them — the order is fixed", () => {
		expect(layout, "the sidebar renders the one tab list").toContain("{USER_TABS.map(");
		expect(layout, "a drag grip would rearrange what may not be rearranged").not.toContain(
			"Drag to reorder",
		);
		expect(layout, "no row carries drag handlers").not.toContain("onDragStart");
	});

	it("keeps the retired tab's address as a redirect onto its preset", () => {
		// The site is publicly reachable and /network was where most accounts landed, so
		// the address survives as a redirect rather than a 404 — and it names the recipe
		// it meant instead of landing on whatever this reader's account opens on.
		expect(app).toContain('path="/network"');
		expect(app).toContain("recipePath(RECIPE_PRESETS[0].recipe)");
		expect(app, "the retired page still has a route").not.toContain("AuthenticatedHomePage");
		expect(app).toContain('path="/discovery"');
		expect(app).not.toContain('path="/feed"');
		expect(app).not.toContain('path="/discover"');
	});
});

describe("Discovery shows one stream", () => {
	it("carries no mode section or mode picker in the sidebar", () => {
		expect(discovery).not.toContain(">Modes<");
		expect(discovery).not.toContain("DISCOVERY_MODES");
		expect(discovery).not.toContain('searchParams.get("mode")');
	});

	it("draws no Graph and no Browse or Inbox mode", () => {
		expect(discovery).not.toContain("GRAPH_PRESETS");
		expect(discovery).not.toContain('id: "graph"');
		expect(discovery).not.toContain('id: "browse"');
		expect(discovery).not.toContain('id: "inbox"');
	});

	it("shows the active recipe above the content", () => {
		expect(discovery).toContain("Active recipe");
		expect(discovery).toContain("<RecipeBar");
	});
});

describe("Discovery's recipe can be cooked, not only read", () => {
	it("offers a choice at each stage the route can run, and sends all three", () => {
		expect(discovery).toContain("WINDOW_OPTIONS");
		expect(discovery).toContain("CANDIDATE_OPTIONS");
		expect(discovery).toContain("MIX_OPTIONS");
		// One place turns the candidate stage into the route's two parameters, so the
		// vocabulary cannot drift between the page and the query.
		expect(discovery).toContain("recipeQuery(recipe.candidates, recipe.mix)");
		expect(discovery).toContain("streamRecipe(recipe)");
	});

	it("names its recipes as presets above the controls", () => {
		expect(discovery).toContain("RECIPE_PRESETS");
		expect(discovery).toContain("<PresetChips");
		expect(discovery).toContain("aria-pressed={selected}");
		// A chip sets a recipe; it is not a fourth control, so it writes every stage.
		expect(discovery).toContain("onPreset={(next) => applyRecipe(next.recipe)}");
	});

	it("writes all three stages when the reader chooses, never only the changed one", () => {
		// Omitting a stage would make it mean "whatever the account says" rather than
		// "this value", so a chip whose stage matched the built-in default would leave the
		// previous recipe in force until the account write landed.
		expect(discovery).toContain('params.set("window", next.window)');
		expect(discovery).toContain('params.set("candidates", next.candidates)');
		expect(discovery).toContain('params.set("mix", next.mix)');
	});

	it("remembers the choice on the account, and reads it back as the default layer", () => {
		expect(discovery).toContain("body: JSON.stringify({ homeRecipe: next })");
		expect(discovery).toContain("recipeFrom(user?.homeRecipe)");
		// The URL answers for a stage it names; every stage it does not comes from the
		// account. That is what makes a shared link an override rather than a rewrite.
		expect(discovery).toContain('const candidates = searchParams.get("candidates");');
		expect(discovery).toContain(": accountRecipe.candidates");
	});

	it("has no single-parameter preset control left", () => {
		expect(discovery).not.toContain("updateParams({ preset:");
	});
});
