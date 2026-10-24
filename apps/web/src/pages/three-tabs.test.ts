// SPDX-License-Identifier: Apache-2.0
/**
 * The three-tab rework's structural contract (Parker, 2026-10-19).
 *
 * A source-text guard in the family of `basket-layout.test.ts`: the pieces that make
 * Library, Network, and Discovery one family are a shared header, one nav vocabulary,
 * and a Discovery body that shows one stream. Each is a decision a refactor can quietly
 * undo — a page growing its own heading again, a renamed route surviving beside its
 * replacement, a mode picker creeping back over a single mode — so each is pinned here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const network = read("AuthenticatedHomePage.tsx");
const library = read("LibraryPage.tsx");
const discovery = read("DiscoverPage.tsx");
const layout = read("../components/layout/LoggedInLayout.tsx");
const tabs = read("../lib/user-tabs.ts");
const app = read("../App.tsx");

describe("the three user tabs share one header", () => {
	it("renders TabHeader on all three pages", () => {
		for (const [page, source] of [
			["Network", network],
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
		expect(network).toContain("Works and Posts from all of the creators you follow");
		expect(library).toContain(
			"All of the Works, Projects, and Posts you've purchased or otherwise saved",
		);
		expect(discovery).toContain("There's no paid promotion or hidden algorithms");
	});

	it("keeps the feed's how-it-works control on the Network header", () => {
		expect(network).toContain("How does the feed work?");
	});
});

describe("the three user tabs share one page shell", () => {
	/**
	 * The header sits inside each page's own wrapper, not in the layout, so the wrapper's
	 * padding is what places it. Library carried `container mx-auto px-4 py-8` and its
	 * header sat eight pixels off in both directions beside the other two's `px-6 py-6`.
	 */
	it("pads every tab's content area the same way", () => {
		for (const [page, source] of [
			["Network", network],
			["Library", library],
			["Discovery", discovery],
		] as const) {
			expect(source, `${page} does not use the shared content padding`).toContain("px-6 py-6");
		}
	});

	it("brings no padded container of its own", () => {
		for (const [page, source] of [
			["Network", network],
			["Library", library],
			["Discovery", discovery],
		] as const) {
			expect(source, `${page} wraps its content in a container`).not.toContain(
				"container mx-auto px-4",
			);
		}
	});
});

describe("the nav speaks the one vocabulary", () => {
	it("orders the tabs Library, Network, and Discovery", () => {
		const links = [
			...tabs.matchAll(/to: "(\/[a-z]+)",\s+id: "([a-z]+)",\s+label: "([A-Za-z]+)"/g),
		].map((match) => [match[1], match[3]]);
		expect(links).toEqual([
			["/library", "Library"],
			["/network", "Network"],
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

	it("has no old-named route left in the router", () => {
		expect(app).toContain('path="/network"');
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
		expect(discovery).not.toContain('label: "Browse"');
		expect(discovery).not.toContain('label: "Inbox"');
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
		expect(discovery).toContain('scope: candidates === "network" ? "network" : "global"');
		expect(discovery).toContain("streamRecipe({ window, candidates, mix })");
	});

	it("has no single-parameter preset control left", () => {
		expect(discovery).not.toContain("RECIPE_PRESETS");
		expect(discovery).not.toContain("updateParams({ preset:");
	});
});
