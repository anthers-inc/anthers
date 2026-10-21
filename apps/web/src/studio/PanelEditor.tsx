// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's guided-view surface for a comic Work.
 *
 * ⭐ **Guided view is off until it is turned on, page by page.** Every page starts off and
 * reads as a whole page to everybody; a page that is off shows no rectangles here and asks
 * for nothing. Turning guided view on is the creator's opt-in, and only then does the page
 * show the detected proposals and the controls that define them — drag a rectangle, resize
 * it, delete it with the Delete key, add one, or confirm the page to clear the `auto` flag.
 * All writes go through the PATCH endpoint atomically per page.
 */

import { client } from "@anthers/web-shared/rpc";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelPage } from "@/lib/panel-navigation";

interface PanelRect {
	panelNumber: number;
	x: number;
	y: number;
	width: number;
	height: number;
	auto: boolean;
}
type RectUpdate = { x: number; y: number; width: number; height: number };

interface PageState {
	pageNumber: number;
	width: number;
	height: number;
	guidedView: boolean;
	panels: PanelRect[];
	url: string;
}

interface PanelEditorProps {
	workId: number;
}

const HANDLE_SIZE = 8;
const MIN_PANEL = 0.05;

function normalizeRect(raw: RectUpdate): RectUpdate {
	const x = Math.max(0, Math.min(1 - MIN_PANEL, raw.x));
	const y = Math.max(0, Math.min(1 - MIN_PANEL, raw.y));
	const width = Math.max(MIN_PANEL, Math.min(1 - x, raw.width));
	const height = Math.max(MIN_PANEL, Math.min(1 - y, raw.height));
	return { x, y, width, height };
}

export default function PanelEditor({ workId }: PanelEditorProps) {
	const [pages, setPages] = useState<PageState[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedPage, setSelectedPage] = useState<number | null>(null);
	const [selectedPanel, setSelectedPanel] = useState<number | null>(null);
	const [savingPage, setSavingPage] = useState<number | null>(null);
	const containerRefs = useRef<Map<number, HTMLElement>>(new Map());

	const loadPanels = useCallback(async () => {
		setLoading(true);
		try {
			const res = await client.api.content.works[":id"].panels.$get({
				param: { id: String(workId) },
			});
			if (!res.ok) throw new Error(`Failed to load panels: ${res.status}`);
			const data = (await res.json()) as { pages: PanelPage[] };
			const pagesWithUrls = data.pages.map((page) => ({
				...page,
				url: `/api/content/works/${workId}/pages/${page.pageNumber}`,
			}));
			setPages(pagesWithUrls);
			if (pagesWithUrls.length > 0 && selectedPage == null) {
				setSelectedPage(pagesWithUrls[0].pageNumber);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [workId, selectedPage]);

	useEffect(() => {
		void loadPanels();
	}, [loadPanels]);

	const savePage = async (pageNumber: number, panels: PanelRect[]) => {
		setSavingPage(pageNumber);
		try {
			const res = await client.api.content.works[":id"].panels.$patch({
				param: { id: String(workId) },
				json: {
					pageNumber,
					panels: panels.map((p) => ({
						x: p.x,
						y: p.y,
						width: p.width,
						height: p.height,
					})),
				},
			});
			if (!res.ok) throw new Error(`Save failed: ${res.status}`);
			await loadPanels();
		} finally {
			setSavingPage(null);
		}
	};

	const updatePage = (pageNumber: number, updater: (prev: PageState) => PageState) => {
		setPages((prev) => {
			if (!prev) return prev;
			return prev.map((p) => (p.pageNumber === pageNumber ? updater(p) : p));
		});
	};

	const setPanels = (pageNumber: number, panels: PanelRect[]) => {
		updatePage(pageNumber, (p) => ({ ...p, panels }));
	};

	const handleMouseDown = (
		e: React.MouseEvent,
		page: PageState,
		panelIdx: number,
		mode: "move" | "resize-se" | "resize-sw" | "resize-ne" | "resize-nw",
	) => {
		e.preventDefault();
		setSelectedPage(page.pageNumber);
		setSelectedPanel(panelIdx);
		const startX = e.clientX;
		const startY = e.clientY;
		const rect = containerRefs.current.get(page.pageNumber)?.getBoundingClientRect();
		if (!rect) return;
		const panel = page.panels[panelIdx];
		const start: PanelRect = { ...panel };
		let next: RectUpdate = { x: start.x, y: start.y, width: start.width, height: start.height };

		const onMove = (ev: MouseEvent) => {
			const dx = (ev.clientX - startX) / rect.width;
			const dy = (ev.clientY - startY) / rect.height;
			next = { x: start.x, y: start.y, width: start.width, height: start.height };
			if (mode === "move") {
				next.x += dx;
				next.y += dy;
			} else if (mode === "resize-se") {
				next.width += dx;
				next.height += dy;
			} else if (mode === "resize-sw") {
				next.x += dx;
				next.width -= dx;
				next.height += dy;
			} else if (mode === "resize-ne") {
				next.y += dy;
				next.width += dx;
				next.height -= dy;
			} else if (mode === "resize-nw") {
				next.x += dx;
				next.y += dy;
				next.width -= dx;
				next.height -= dy;
			}
			next = normalizeRect(next);
			const updated: PanelRect = {
				panelNumber: start.panelNumber,
				auto: false,
				x: next.x,
				y: next.y,
				width: next.width,
				height: next.height,
			};
			setPanels(
				page.pageNumber,
				page.panels.map((p, i) => (i === panelIdx ? updated : p)),
			);
		};

		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key !== "Delete" && e.key !== "Backspace") return;
		if (selectedPage == null || selectedPanel == null || !pages) return;
		const page = pages.find((p) => p.pageNumber === selectedPage);
		if (!page) return;
		const next = page.panels.filter((_, i) => i !== selectedPanel);
		setPanels(selectedPage, next);
		setSelectedPanel(null);
	};

	const addPanel = (page: PageState) => {
		const next: PanelRect = {
			panelNumber: page.panels.length + 1,
			x: 0.1,
			y: 0.1,
			width: 0.2,
			height: 0.2,
			auto: false,
		};
		setPanels(page.pageNumber, [...page.panels, next]);
		setSelectedPage(page.pageNumber);
		setSelectedPanel(page.panels.length);
	};

	/** Turn guided view on or off for one page. Turning it off keeps the proposals. */
	const setGuidedView = async (page: PageState, enabled: boolean) => {
		setSavingPage(page.pageNumber);
		try {
			const res = await client.api.content.works[":id"].panels.$patch({
				param: { id: String(workId) },
				json: { pageNumber: page.pageNumber, enabled },
			});
			if (!res.ok) throw new Error(`Save failed: ${res.status}`);
			await loadPanels();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSavingPage(null);
		}
	};

	const confirmPage = async (page: PageState) => {
		await savePage(
			page.pageNumber,
			page.panels.map((p) => ({ ...p, auto: false })),
		);
	};

	if (loading) return <div className="text-sm text-base-content/60">Loading pages…</div>;
	if (error) return <div className="text-sm text-error">{error}</div>;
	if (!pages || pages.length === 0) {
		return <div className="text-sm text-base-content/60">No pages to edit yet.</div>;
	}

	const activePage = pages.find((p) => p.pageNumber === selectedPage) ?? pages[0];
	const guidedCount = pages.filter((p) => p.guidedView).length;
	const pending = activePage.panels.some((p) => p.auto);

	return (
		<section
			className="flex flex-col gap-4"
			onKeyDown={handleKeyDown}
			tabIndex={-1}
			aria-label="Guided view editor"
		>
			<div className="flex items-center justify-between">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
					Guided View
				</h3>
				<span className="text-xs text-base-content/60">
					{guidedCount} of {pages.length} page{pages.length === 1 ? "" : "s"} on
				</span>
			</div>

			<p className="text-xs text-base-content/60">
				Guided view is off until you turn it on for a page. Pages without it read whole, need no
				confirmation, and never hold up publishing.
			</p>

			<div className="flex gap-2 overflow-x-auto pb-2">
				{pages.map((page) => {
					// Off shows nothing. On with no panels is the one state an enabled page
					// should not sit in, so it is flagged rather than reading as done.
					const badge = !page.guidedView
						? null
						: page.panels.length === 0
							? "no panels"
							: page.panels.some((p) => p.auto)
								? "auto"
								: "on";
					return (
						<button
							key={page.pageNumber}
							type="button"
							onClick={() => {
								setSelectedPage(page.pageNumber);
								setSelectedPanel(null);
							}}
							className={`relative shrink-0 overflow-hidden rounded border-2 ${
								selectedPage === page.pageNumber
									? "border-primary"
									: "border-transparent hover:border-base-300"
							}`}
							style={{ width: 80, height: 110 }}
						>
							<img
								src={page.url}
								alt={`Page ${page.pageNumber}`}
								className={`h-full w-full object-contain ${page.guidedView ? "" : "opacity-60"}`}
							/>
							{badge && (
								<span
									className={`absolute right-0 top-0 text-[10px] px-1 rounded-bl ${
										badge === "on"
											? "bg-success text-success-content"
											: "bg-warning text-warning-content"
									}`}
								>
									{badge}
								</span>
							)}
							<span className="absolute bottom-0 left-0 bg-base-300/80 px-1 text-[10px]">
								{page.pageNumber}
							</span>
						</button>
					);
				})}
			</div>

			{activePage.guidedView ? (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => addPanel(activePage)}
							disabled={activePage.panels.length >= 20}
						>
							Add panel
						</button>
						<button
							type="button"
							className="btn btn-outline btn-sm"
							onClick={() => confirmPage(activePage)}
							disabled={!pending || savingPage === activePage.pageNumber}
						>
							{savingPage === activePage.pageNumber ? "Saving…" : "Confirm page"}
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => void setGuidedView(activePage, false)}
							disabled={savingPage === activePage.pageNumber}
						>
							Turn off guided view
						</button>
						<span className="text-xs text-base-content/60">
							Click a panel to select it; drag to move; drag a corner to resize; Delete removes it.
						</span>
					</div>

					{activePage.panels.length === 0 && (
						<p className="text-xs text-warning">
							This page has guided view on but no panels yet. Add at least one, or turn guided view
							off to read it whole.
						</p>
					)}

					<button
						type="button"
						ref={(el) => {
							if (el) containerRefs.current.set(activePage.pageNumber, el);
						}}
						className="relative mx-auto w-fit max-w-full select-none"
						onClick={() => setSelectedPanel(null)}
						aria-label="Deselect panel"
						onKeyDown={(e) => {
							if (e.key === "Escape") setSelectedPanel(null);
						}}
					>
						<img
							src={activePage.url}
							alt={`Page ${activePage.pageNumber}`}
							className="max-h-[60vh] w-auto rounded"
							loading="eager"
						/>
						<svg
							className="absolute inset-0 h-full w-full"
							viewBox={`0 0 ${activePage.width} ${activePage.height}`}
							preserveAspectRatio="none"
							role="img"
							aria-label={`Panel overlays for page ${activePage.pageNumber}`}
						>
							{activePage.panels.map((panel, panelIndex) => (
								<g key={panel.panelNumber}>
									{/* biome-ignore lint/a11y/noStaticElementInteractions: an SVG rect is the panel; there is no interactive role for it inside an SVG, and the surface's semantics live on the buttons that surround it. */}
									<rect
										x={panel.x * activePage.width}
										y={panel.y * activePage.height}
										width={panel.width * activePage.width}
										height={panel.height * activePage.height}
										fill="transparent"
										stroke={
											selectedPanel === panelIndex ? "#3b82f6" : panel.auto ? "#f59e0b" : "#22c55e"
										}
										strokeWidth={selectedPanel === panelIndex ? 3 : 2}
										strokeDasharray={panel.auto ? "6 4" : undefined}
										onClick={(e) => {
											e.stopPropagation();
											setSelectedPanel(panelIndex);
										}}
										onMouseDown={(e) => handleMouseDown(e, activePage, panelIndex, "move")}
										className="cursor-move"
										aria-label={`Panel ${panel.panelNumber}`}
									/>
									{selectedPanel === panelIndex && (
										<>
											{/* biome-ignore lint/a11y/noStaticElementInteractions: an SVG circle is the resize handle; there is no interactive role for it inside an SVG. */}
											<circle
												cx={(panel.x + panel.width) * activePage.width}
												cy={(panel.y + panel.height) * activePage.height}
												r={HANDLE_SIZE}
												fill="#3b82f6"
												onMouseDown={(e) => handleMouseDown(e, activePage, panelIndex, "resize-se")}
												className="cursor-nwse-resize"
												aria-label="Resize panel"
											/>
											<text
												x={panel.x * activePage.width}
												y={panel.y * activePage.height - 6}
												fill="#3b82f6"
												fontSize={activePage.height * 0.04}
											>
												{panel.panelNumber}
											</text>
										</>
									)}
								</g>
							))}
						</svg>
					</button>

					<div className="flex justify-end gap-2">
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => savePage(activePage.pageNumber, activePage.panels)}
							disabled={savingPage === activePage.pageNumber}
						>
							{savingPage === activePage.pageNumber ? "Saving…" : "Save this page"}
						</button>
					</div>
				</>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => void setGuidedView(activePage, true)}
							disabled={savingPage === activePage.pageNumber}
						>
							{savingPage === activePage.pageNumber ? "Saving…" : "Turn on guided view"}
						</button>
						<span className="text-xs text-base-content/60">
							This page reads as a whole page and needs no confirmation.
						</span>
					</div>
					<div className="relative mx-auto w-fit max-w-full">
						<img
							src={activePage.url}
							alt={`Page ${activePage.pageNumber}`}
							className="max-h-[60vh] w-auto rounded"
							loading="eager"
						/>
					</div>
				</>
			)}
		</section>
	);
}
