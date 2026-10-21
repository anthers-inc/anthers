// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure helpers behind `usePanelNavigation`.
 *
 * The hook itself is React-shaped, but the flat-index arithmetic it does over pages and
 * panels is pure and is the part most likely to regress. These tests cover that mapping:
 * cross-page wrapping, position persistence, and the edge cases of empty or missing pages.
 */
import { describe, expect, it } from "bun:test";
import {
	guidedPages,
	hasGuidedView,
	type PanelPage,
	type PanelPosition,
	readerPages,
} from "./panel-navigation";

const PAGES: PanelPage[] = [
	{
		pageNumber: 1,
		width: 800,
		height: 1200,
		guidedView: true,
		panels: [
			{ panelNumber: 1, x: 0, y: 0, width: 1, height: 0.5, auto: true },
			{ panelNumber: 2, x: 0, y: 0.5, width: 1, height: 0.5, auto: true },
		],
	},
	{
		pageNumber: 2,
		width: 800,
		height: 1200,
		guidedView: true,
		panels: [{ panelNumber: 1, x: 0, y: 0, width: 1, height: 1, auto: true }],
	},
];

function totalPanels(pages: PanelPage[]): number {
	return pages.reduce((sum, p) => sum + p.panels.length, 0);
}

function panelAtIndex(
	pages: PanelPage[],
	index: number,
): { page: PanelPage; panel: PanelPage["panels"][number]; panelIndex: number } | null {
	let remaining = index;
	for (const page of pages) {
		if (remaining < page.panels.length) {
			return { page, panel: page.panels[remaining], panelIndex: remaining };
		}
		remaining -= page.panels.length;
	}
	return null;
}

function indexForPanel(pages: PanelPage[], position: PanelPosition): number {
	let index = 0;
	for (const page of pages) {
		if (page.pageNumber === position.pageNumber) {
			const found = page.panels.findIndex((p) => p.panelNumber === position.panelNumber);
			return found >= 0 ? index + found : index;
		}
		index += page.panels.length;
	}
	return 0;
}

describe("panel navigation helpers", () => {
	it("totalPanels counts across pages", () => {
		expect(totalPanels(PAGES)).toBe(3);
		expect(totalPanels([])).toBe(0);
	});

	it("panelAtIndex advances within a page and wraps to the next page", () => {
		expect(panelAtIndex(PAGES, 0)).toEqual({
			page: PAGES[0],
			panel: PAGES[0].panels[0],
			panelIndex: 0,
		});
		expect(panelAtIndex(PAGES, 1)).toEqual({
			page: PAGES[0],
			panel: PAGES[0].panels[1],
			panelIndex: 1,
		});
		expect(panelAtIndex(PAGES, 2)?.page.pageNumber).toBe(2);
		expect(panelAtIndex(PAGES, 2)?.panel.panelNumber).toBe(1);
	});

	it("panelAtIndex returns null for an empty Work", () => {
		expect(panelAtIndex([], 0)).toBeNull();
	});

	it("panelAtIndex clamps past the end", () => {
		expect(panelAtIndex(PAGES, 5)).toBeNull();
	});

	it("indexForPanel restores the flat index for a saved position", () => {
		expect(indexForPanel(PAGES, { pageNumber: 1, panelNumber: 1 })).toBe(0);
		expect(indexForPanel(PAGES, { pageNumber: 1, panelNumber: 2 })).toBe(1);
		expect(indexForPanel(PAGES, { pageNumber: 2, panelNumber: 1 })).toBe(2);
	});

	it("indexForPanel falls back to the first panel for a missing position", () => {
		expect(indexForPanel(PAGES, { pageNumber: 99, panelNumber: 1 })).toBe(0);
		expect(indexForPanel(PAGES, { pageNumber: 1, panelNumber: 99 })).toBe(0);
	});

	it("round-trips every reachable position", () => {
		for (let i = 0; i < totalPanels(PAGES); i++) {
			const found = panelAtIndex(PAGES, i);
			expect(found).not.toBeNull();
			if (!found) continue;
			const back = indexForPanel(PAGES, {
				pageNumber: found.page.pageNumber,
				panelNumber: found.panel.panelNumber,
			});
			expect(back).toBe(i);
		}
	});
});

/**
 * Guided view is an explicit opt-in per page. Off is the default, a page that is off reads
 * whole whatever proposals sit beside it, and a Work with no page on offers no panel mode
 * at all. That is what lets a comic publish before the creator has touched its Pages section.
 */
describe("guided view is an explicit per-page opt-in", () => {
	const PAGES_FOR_READER: PanelPage[] = [
		{
			pageNumber: 1,
			width: 800,
			height: 1200,
			guidedView: true,
			panels: [
				{ panelNumber: 1, x: 0, y: 0, width: 1, height: 0.5, auto: false },
				{ panelNumber: 2, x: 0, y: 0.5, width: 1, height: 0.5, auto: false },
			],
		},
		{
			// On, but the proposals were never confirmed, so a reader still gets a whole page.
			pageNumber: 2,
			width: 800,
			height: 1200,
			guidedView: true,
			panels: [{ panelNumber: 1, x: 0, y: 0, width: 1, height: 1, auto: true }],
		},
		{
			// Off, with proposals beside it: nothing a reader should ever see.
			pageNumber: 3,
			width: 800,
			height: 1200,
			guidedView: false,
			panels: [
				{ panelNumber: 1, x: 0, y: 0, width: 0.5, height: 1, auto: false },
				{ panelNumber: 2, x: 0.5, y: 0, width: 0.5, height: 1, auto: false },
			],
		},
	];

	it("drops proposals and every page whose guided view is off", () => {
		const asReader = readerPages(PAGES_FOR_READER);
		expect(asReader[0]?.panels.length).toBe(2);
		expect(asReader[1]?.panels).toEqual([]);
		expect(asReader[2]?.panels).toEqual([]);
	});

	it("fills a page with nothing to guide with in as one whole page, so it still turns", () => {
		const walkable = guidedPages(PAGES_FOR_READER);
		expect(walkable[0]?.panels.length).toBe(2);
		expect(walkable[1]?.panels).toEqual([
			{ panelNumber: 1, x: 0, y: 0, width: 1, height: 1, auto: false },
		]);
		expect(walkable[2]?.panels).toEqual([
			{ panelNumber: 1, x: 0, y: 0, width: 1, height: 1, auto: false },
		]);
	});

	it("offers no guided view when nothing is on and confirmed", () => {
		expect(hasGuidedView(PAGES_FOR_READER)).toBe(true);
		// Every page off, even with proposals: a page reader and nothing else.
		expect(hasGuidedView(PAGES_FOR_READER.map((page) => ({ ...page, guidedView: false })))).toBe(
			false,
		);
		// On but unconfirmed: still no guided view.
		expect(
			hasGuidedView(
				PAGES_FOR_READER.map((page) => ({
					...page,
					panels: page.panels.map((panel) => ({ ...panel, auto: true })),
				})),
			),
		).toBe(false);
	});
});
