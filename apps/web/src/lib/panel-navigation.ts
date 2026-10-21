// SPDX-License-Identifier: Apache-2.0
/**
 * Flat navigation over a Work's pages and panels for the panel-mode user.
 *
 * Pages and panels are read from `/works/:id/panels` and kept in reading order:
 * top-left-first within a page, then the next page. This hook turns that tree into a
 * single index so next/previous can advance within a page and across page boundaries
 * without the caller tracking both dimensions.
 *
 * ⭐ **Panel guidance is additive, page by page, and never a precondition.** Guided view is
 * off on every page until a creator turns it on for that page, and the endpoint gives a
 * reader geometry only where that happened and the creator confirmed it. A page carrying
 * none is a whole page. {@link guidedPages} fills those pages in as one whole-page panel so
 * turning through them still works, and {@link hasGuidedView} is what the reader asks before
 * it offers panel mode at all — a Work whose creator has touched nothing reads as plain pages.
 */

import { useCallback, useEffect, useState } from "react";

export interface PanelPage {
	pageNumber: number;
	width: number;
	height: number;
	/**
	 * Whether the creator turned guided view on for this page. Off is the default and a
	 * page that is off reads whole, whatever proposal rows exist beside it.
	 */
	guidedView: boolean;
	panels: Panel[];
}

export interface Panel {
	panelNumber: number;
	x: number;
	y: number;
	width: number;
	height: number;
	auto: boolean;
}

export interface PanelPosition {
	pageNumber: number;
	panelNumber: number;
}

/**
 * Every page as a walkable list: the confirmed panels where a page has them, and one
 * whole-page panel where it does not.
 *
 * The synthesised panel is marked `auto: false` because it is not a guess — it is the
 * page itself, and it is what a page with no guidance has always looked like.
 */
export function guidedPages(pages: PanelPage[]): PanelPage[] {
	const walkable = readerPages(pages);
	return walkable.map((page) =>
		page.panels.length > 0
			? page
			: {
					...page,
					panels: [{ panelNumber: 1, x: 0, y: 0, width: 1, height: 1, auto: false }],
				},
	);
}

/**
 * The pages as a reader sees them: geometry only where guided view is on and a creator
 * confirmed it, and no panels everywhere else.
 *
 * The server already applies this for anyone but the Work's owner; applying it here too is
 * what keeps the creator's own preview honest, because the owner is sent the proposals the
 * Studio needs.
 */
export function readerPages(pages: PanelPage[]): PanelPage[] {
	return pages.map((page) => ({
		...page,
		panels: page.guidedView ? page.panels.filter((panel) => !panel.auto) : [],
	}));
}

/** Whether the Work has any confirmed panel on an enabled page, and so anything to offer. */
export function hasGuidedView(pages: PanelPage[]): boolean {
	return readerPages(pages).some((page) => page.panels.length > 0);
}

function totalPanels(pages: PanelPage[]): number {
	return pages.reduce((sum, p) => sum + p.panels.length, 0);
}

function panelAtIndex(
	pages: PanelPage[],
	index: number,
): { page: PanelPage; panel: Panel; panelIndex: number } | null {
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

export interface PanelNavigation {
	/** Flat index of the current panel, 0-based. */
	index: number;
	/** Whether there is a panel to advance to. */
	hasNext: boolean;
	/** Whether there is a panel to go back to. */
	hasPrevious: boolean;
	/** The current page the panel lives on. */
	page: PanelPage | null;
	/** The current panel. */
	panel: Panel | null;
	/** 1-based panel number within the current page. */
	panelIndex: number;
	/** Advance to the next panel, wrapping to the next page if needed. */
	next: () => void;
	/** Back to the previous panel, wrapping to the previous page if needed. */
	previous: () => void;
	/** Jump to a specific panel. */
	goTo: (position: PanelPosition) => void;
	/** Total panels across the whole Work. */
	total: number;
}

export function usePanelNavigation(
	pages: PanelPage[],
	onChange?: (position: PanelPosition) => void,
	initial?: PanelPosition,
): PanelNavigation {
	const [index, setIndex] = useState(() => {
		if (!initial) return 0;
		return indexForPanel(pages, initial);
	});

	const clampedIndex = Math.min(Math.max(0, index), Math.max(0, totalPanels(pages) - 1));
	const current = panelAtIndex(pages, clampedIndex);
	const total = totalPanels(pages);

	const next = useCallback(() => {
		setIndex((i) => {
			const nextIndex = Math.min(i + 1, Math.max(0, total - 1));
			return nextIndex;
		});
	}, [total]);

	const previous = useCallback(() => {
		setIndex((i) => Math.max(0, i - 1));
	}, []);

	const goTo = useCallback(
		(position: PanelPosition) => {
			setIndex(indexForPanel(pages, position));
		},
		[pages],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: onChange is expected to be stable; including current would fire every render.
	useEffect(() => {
		if (current && onChange) {
			onChange({ pageNumber: current.page.pageNumber, panelNumber: current.panel.panelNumber });
		}
	}, [clampedIndex]);

	return {
		index: clampedIndex,
		hasNext: clampedIndex < total - 1,
		hasPrevious: clampedIndex > 0,
		page: current?.page ?? null,
		panel: current?.panel ?? null,
		panelIndex: current?.panelIndex ?? 0,
		next,
		previous,
		goTo,
		total,
	};
}
