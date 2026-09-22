// SPDX-License-Identifier: Apache-2.0
/**
 * Flat navigation over a Work's pages and panels for the panel-mode reader.
 *
 * Pages and panels are read from `/works/:id/panels` and kept in reading order:
 * top-left-first within a page, then the next page. This hook turns that tree into a
 * single index so next/previous can advance within a page and across page boundaries
 * without the caller tracking both dimensions.
 */

import { useCallback, useEffect, useState } from "react";

export interface PanelPage {
	pageNumber: number;
	width: number;
	height: number;
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
