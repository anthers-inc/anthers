// SPDX-License-Identifier: Apache-2.0
/**
 * The comic/ebook reader — page turns by default, with an opt-in panel mode for comics.
 *
 * Panel mode fetches `/works/:id/panels` once, then crops each panel from the page image
 * so the panel fills the viewport. A full-page zoom view is available with `z` without
 * leaving panel mode. Touch swipes advance panels on mobile.
 *
 * Page URLs are still minted per request for page-flip mode, and panel mode uses the same
 * page endpoint for the underlying image.
 */
import {
	ArrowsPointingInIcon,
	ArrowsPointingOutIcon,
	BookOpenIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	Squares2X2Icon,
	ViewfinderCircleIcon,
} from "@heroicons/react/24/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PanelPage, type PanelPosition, usePanelNavigation } from "@/lib/panel-navigation";
import SeekBar from "./transport/SeekBar";
import TransportButton from "./transport/TransportButton";

/** How the pages are laid out. Spread is two-up, the way a printed book opens. */
type Layout = "single" | "spread";
type ReaderMode = "page" | "panel";

/** Where a reader got to, per Work, so reopening a chapter resumes rather than restarts. */
const PROGRESS_KEY = "anthers_reading_progress";
const PANEL_PROGRESS_KEY = "anthers_panel_progress";

interface PanelProgress {
	page: number;
	panel: number;
}

function readProgress(workId: number): number {
	try {
		const raw = localStorage.getItem(PROGRESS_KEY);
		if (!raw) return 1;
		const map = JSON.parse(raw) as Record<string, number>;
		const page = map[String(workId)];
		return Number.isInteger(page) && page > 0 ? page : 1;
	} catch {
		return 1;
	}
}

function writeProgress(workId: number, page: number) {
	try {
		const raw = localStorage.getItem(PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
		map[String(workId)] = page;
		localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — the reader simply always opens at page one. */
	}
}

function readPanelProgress(workId: number): PanelProgress {
	try {
		const raw = localStorage.getItem(PANEL_PROGRESS_KEY);
		if (!raw) return { page: 1, panel: 1 };
		const map = JSON.parse(raw) as Record<string, PanelProgress>;
		const p = map[String(workId)];
		if (p && Number.isInteger(p.page) && Number.isInteger(p.panel)) return p;
	} catch {}
	return { page: 1, panel: 1 };
}

function writePanelProgress(workId: number, position: PanelProgress) {
	try {
		const raw = localStorage.getItem(PANEL_PROGRESS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, PanelProgress>) : {};
		map[String(workId)] = position;
		localStorage.setItem(PANEL_PROGRESS_KEY, JSON.stringify(map));
	} catch {
		/* Storage disabled — panel progress does not persist. */
	}
}

export default function ComicReader({
	workId,
	pageCount,
	apiBase,
	title,
	shareToken = null,
}: {
	workId: number;
	pageCount: number;
	/** API origin, so the page URLs are built the one blessed way (see `rpc.ts`). */
	apiBase: string;
	title: string;
	/**
	 * The **share link** this reader was reached by, if any.
	 *
	 * 🚨 It has to ride on the URL rather than in a header: these are `<img src>` values, and
	 * an `<img>` issues its own request with nothing the page can attach to it. Without the
	 * token a share-link recipient would get a reader full of broken images and no
	 * explanation — the dead-player failure the whole meter design exists to avoid.
	 */
	shareToken?: string | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [page, setPage] = useState(() => Math.min(readProgress(workId), Math.max(pageCount, 1)));
	const [layout, setLayout] = useState<Layout>("single");
	const [fullscreen, setFullscreen] = useState(false);
	const [mode, setMode] = useState<ReaderMode>("page");
	const [panelPages, setPanelPages] = useState<PanelPage[] | null>(null);
	const [panelZoom, setPanelZoom] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const pageUrl = useCallback(
		(n: number) => {
			const url = `${apiBase}/api/content/works/${workId}/pages/${n}`;
			return shareToken ? `${url}?share=${encodeURIComponent(shareToken)}` : url;
		},
		[apiBase, workId, shareToken],
	);

	const panelsUrl = useCallback(() => {
		const url = `${apiBase}/api/content/works/${workId}/panels`;
		return shareToken ? `${url}?share=${encodeURIComponent(shareToken)}` : url;
	}, [apiBase, workId, shareToken]);

	// Lazy-load panel geometry the first time panel mode is entered.
	useEffect(() => {
		if (mode !== "panel" || panelPages != null || error) return;
		let live = true;
		fetch(panelsUrl())
			.then(async (res) => {
				if (!res.ok) {
					throw new Error(`Panels failed: ${res.status}`);
				}
				const data = (await res.json()) as { pages: PanelPage[] };
				if (live) setPanelPages(data.pages);
			})
			.catch((e) => {
				if (live) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			live = false;
		};
	}, [mode, panelPages, panelsUrl, error]);

	// Two-up shows n and n+1, so the last spread of an even-length book is a single page.
	const spread = layout === "spread";
	const step = spread ? 2 : 1;
	const shown = spread ? [page, page + 1].filter((n) => n <= pageCount) : [page];

	const goTo = useCallback(
		(n: number) => {
			const clamped = Math.min(Math.max(1, n), Math.max(pageCount, 1));
			setPage(clamped);
			writeProgress(workId, clamped);
		},
		[pageCount, workId],
	);

	const next = useCallback(() => goTo(page + step), [goTo, page, step]);
	const previous = useCallback(() => goTo(page - step), [goTo, page, step]);

	const toggleFullscreen = useCallback(() => {
		if (document.fullscreenElement) {
			void document.exitFullscreen();
			return;
		}
		void containerRef.current?.requestFullscreen().catch(() => {});
	}, []);

	useEffect(() => {
		const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	const initialPanel = readPanelProgress(workId);
	const panelNav = usePanelNavigation(
		panelPages ?? [],
		useCallback(
			(pos: PanelPosition) => {
				writePanelProgress(workId, { page: pos.pageNumber, panel: pos.panelNumber });
				setPage(pos.pageNumber);
			},
			[workId],
		),
		{ pageNumber: initialPanel.page, panelNumber: initialPanel.panel },
	);

	// Once panel geometry arrives, restore the saved panel position.
	useEffect(() => {
		if (panelPages && panelPages.length > 0) {
			panelNav.goTo({ pageNumber: initialPanel.page, panelNumber: initialPanel.panel });
		}
	}, [panelPages, initialPanel, panelNav]);

	const panelNext = useCallback(() => {
		panelNav.next();
	}, [panelNav]);

	const panelPrevious = useCallback(() => {
		panelNav.previous();
	}, [panelNav]);

	// Keyboard handling: arrows and space advance panels in panel mode, pages otherwise.
	const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT") return;
		if (mode === "panel") {
			switch (e.key) {
				case "ArrowRight":
				case " ":
				case "PageDown":
					e.preventDefault();
					return panelNext();
				case "ArrowLeft":
				case "PageUp":
					e.preventDefault();
					return panelPrevious();
				case "z":
				case "Z":
					e.preventDefault();
					return setPanelZoom((z) => !z);
				case "Home":
					e.preventDefault();
					return panelNav.goTo({ pageNumber: 1, panelNumber: 1 });
				case "End":
					e.preventDefault();
					return panelNav.goTo({ pageNumber: pageCount, panelNumber: 1 });
				case "f":
				case "F":
					e.preventDefault();
					return toggleFullscreen();
				default:
					break;
			}
			return;
		}
		switch (e.key) {
			case "ArrowRight":
			case " ":
			case "PageDown":
				e.preventDefault();
				return next();
			case "ArrowLeft":
			case "PageUp":
				e.preventDefault();
				return previous();
			case "Home":
				e.preventDefault();
				return goTo(1);
			case "End":
				e.preventDefault();
				return goTo(pageCount);
			case "f":
			case "F":
				e.preventDefault();
				return toggleFullscreen();
			default:
				break;
		}
	};

	// Touch swipe handling for panel mode.
	const touchStart = useRef<{ x: number; y: number } | null>(null);
	const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
		touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
	};
	const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
		if (!touchStart.current) return;
		const dx = e.changedTouches[0].clientX - touchStart.current.x;
		const dy = e.changedTouches[0].clientY - touchStart.current.y;
		touchStart.current = null;
		if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
		if (dx < 0) panelNext();
		else panelPrevious();
	};

	const togglePanelMode = useCallback(() => {
		setMode((m) => (m === "panel" ? "page" : "panel"));
	}, []);

	if (pageCount === 0) {
		return (
			<div className="rounded-lg border border-base-300 bg-base-200 px-6 py-12 text-center">
				<BookOpenIcon className="mx-auto size-8 text-base-content/20" />
				<p className="mt-2 text-sm text-base-content/60">This book has no pages yet.</p>
			</div>
		);
	}

	const currentPanelPage = panelNav.page;
	const currentPanel = panelNav.panel;

	return (
		<section
			ref={containerRef}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the container IS the reader — focusable, carrying the keymap, and the element fullscreen is requested on. The controls inside it are ordinary named buttons.
			tabIndex={0}
			onKeyDown={onKeyDown}
			aria-label={`Reader: ${title}`}
			className="overflow-hidden rounded-lg bg-neutral focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
		>
			<div
				className="relative flex min-h-[60vh] items-center justify-center gap-1 bg-neutral p-2 sm:gap-2 sm:p-4"
				onTouchStart={onTouchStart}
				onTouchEnd={onTouchEnd}
			>
				{mode === "page" ? (
					shown.map((n) => (
						<img
							key={n}
							src={pageUrl(n)}
							alt={`${title}, page ${n}`}
							className="max-h-[80vh] w-auto max-w-full rounded object-contain shadow-lg"
							loading="eager"
						/>
					))
				) : currentPanelPage && currentPanel ? (
					<div className="relative flex h-[80vh] w-full items-center justify-center">
						{/* Full page ghosted behind the panel so the reader keeps context. */}
						<img
							src={pageUrl(currentPanelPage.pageNumber)}
							alt={`${title}, page ${currentPanelPage.pageNumber}`}
							className="absolute inset-0 h-full w-full rounded object-contain opacity-20"
							loading="eager"
						/>
						{panelZoom ? (
							<img
								src={pageUrl(currentPanelPage.pageNumber)}
								alt={`${title}, page ${currentPanelPage.pageNumber}`}
								className="relative z-10 max-h-[80vh] w-auto max-w-full rounded object-contain shadow-lg"
								loading="eager"
							/>
						) : (
							<PanelView
								page={currentPanelPage}
								panel={currentPanel}
								src={pageUrl(currentPanelPage.pageNumber)}
								title={title}
							/>
						)}
					</div>
				) : error ? (
					<div className="text-center">
						<p className="text-sm text-base-content/60">Could not load panel layout.</p>
					</div>
				) : (
					<div className="text-center">
						<p className="text-sm text-base-content/60">Loading panels…</p>
					</div>
				)}
			</div>

			<div className="flex items-center gap-2 border-t border-base-300 bg-base-200 px-2 py-2 sm:px-3">
				<TransportButton
					label={mode === "panel" ? "Previous panel" : "Previous page"}
					icon={ChevronLeftIcon}
					onClick={mode === "panel" ? panelPrevious : previous}
					disabled={mode === "panel" ? !panelNav.hasPrevious : page <= 1}
				/>

				<span className="shrink-0 text-xs tabular-nums text-base-content/60">
					{mode === "panel" && currentPanel && currentPanelPage
						? `Panel ${panelNav.panelIndex + 1} of ${currentPanelPage.panels.length} · Page ${currentPanelPage.pageNumber}`
						: shown.length > 1
							? `${shown[0]}–${shown[shown.length - 1]}`
							: page}
					<span className="text-base-content/35">
						{" "}
						/ {mode === "panel" ? panelNav.total : pageCount}
					</span>
				</span>

				{mode === "page" && (
					<SeekBar
						position={page}
						duration={pageCount}
						onSeek={(n) => goTo(Math.round(n))}
						label="Page"
						className="flex-1"
					/>
				)}

				<TransportButton
					label={mode === "panel" ? "Next panel" : "Next page"}
					icon={ChevronRightIcon}
					onClick={mode === "panel" ? panelNext : next}
					disabled={mode === "panel" ? !panelNav.hasNext : page + step > pageCount}
				/>
				<TransportButton
					label={mode === "panel" ? "Page mode" : "Panel mode"}
					icon={ViewfinderCircleIcon}
					onClick={togglePanelMode}
					active={mode === "panel"}
					className="hidden sm:inline-flex"
				/>
				{mode === "panel" && (
					<TransportButton
						label={panelZoom ? "Zoom out" : "Zoom to page"}
						icon={panelZoom ? ArrowsPointingInIcon : ArrowsPointingOutIcon}
						onClick={() => setPanelZoom((z) => !z)}
						active={panelZoom}
					/>
				)}
				<TransportButton
					label={spread ? "Single page" : "Two-page spread"}
					icon={spread ? BookOpenIcon : Squares2X2Icon}
					onClick={() => setLayout(spread ? "single" : "spread")}
					active={spread}
					className="hidden sm:inline-flex"
				/>
				<TransportButton
					label={fullscreen ? "Exit full screen" : "Full screen"}
					icon={fullscreen ? ArrowsPointingInIcon : ArrowsPointingOutIcon}
					onClick={toggleFullscreen}
				/>
			</div>
		</section>
	);
}

function PanelView({
	page,
	panel,
	src,
	title,
}: {
	page: PanelPage;
	panel: { x: number; y: number; width: number; height: number; panelNumber: number };
	src: string;
	title: string;
}) {
	// The panel is rendered by cropping the full page image. The container is sized to the
	// panel's aspect ratio, and the image is scaled so the panel region fills it.
	const scale = Math.max(1 / (panel.width * page.width), 1 / (panel.height * page.height));

	return (
		<div
			className="relative z-10 h-[80vh] overflow-hidden rounded shadow-lg"
			style={{
				aspectRatio: `${panel.width * page.width} / ${panel.height * page.height}`,
			}}
		>
			<img
				src={src}
				alt={`${title}, panel ${panel.panelNumber}`}
				className="absolute max-w-none"
				loading="eager"
				style={{
					width: `${page.width * scale * (panel.width * page.width)}px`,
					height: `${page.height * scale * (panel.height * page.height)}px`,
					objectFit: "none",
					objectPosition: `${panel.x * 100}% ${panel.y * 100}%`,
					left: 0,
					top: 0,
				}}
			/>
		</div>
	);
}
