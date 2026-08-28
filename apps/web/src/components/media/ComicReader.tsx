// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The comic reader — page turns over an ebook Work.
 *
 * Third of the three players, and built from the same `transport/` pieces as the other
 * two on purpose: same button shapes, same focus treatment, same keyboard philosophy, same
 * `SeekBar` for the page rail. Three players that feel like three different products is
 * the failure mode this whole area was doing at once to avoid.
 *
 * **Page-flip only.** Panel-to-panel is deferred rather than dropped (Parker, 2026-08-13):
 * it needs either an authoring surface or a gutter-detection heuristic that fails in front
 * of a reader mid-scene, and the choice gets easier with real pages in hand. Nothing here
 * forecloses it — pages carry stable ids and numbers server-side, so panel regions can
 * hang off a page later.
 *
 * ## Two constraints inherited, not chosen
 *
 * 🚨 **Every page URL is minted per request** at `/works/:id/pages/:n`, which re-resolves
 * access and meters the commons. So the reader never caches a page URL and never fetches
 * ahead of the *endpoint* — prefetching the next page means asking that endpoint for it,
 * which is a real check every time. This is why an `<img src>` per page is the whole
 * implementation: the browser's own cache holds bytes it was allowed to have, and asking
 * again goes through the door again.
 *
 * **Attention is presence-mode** for an ebook — visible tab plus a sign of life within
 * 60s, which turning pages supplies naturally. The claim lives on the page that renders
 * this, keyed on the Work; see `40.05`.
 */
import {
	ArrowsPointingInIcon,
	ArrowsPointingOutIcon,
	BookOpenIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import SeekBar from "./transport/SeekBar";
import TransportButton from "./transport/TransportButton";

/** How the pages are laid out. Spread is two-up, the way a printed book opens. */
type Layout = "single" | "spread";

/** Where a reader got to, per Work, so reopening a chapter resumes rather than restarts. */
const PROGRESS_KEY = "anthers_reading_progress";

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

	const pageUrl = useCallback(
		(n: number) => {
			const url = `${apiBase}/api/content/works/${workId}/pages/${n}`;
			return shareToken ? `${url}?share=${encodeURIComponent(shareToken)}` : url;
		},
		[apiBase, workId, shareToken],
	);

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

	/*
	 * Prefetch the next page (or spread) — through the ENDPOINT, never around it.
	 *
	 * An `<img>` created off-screen makes an ordinary request that re-resolves access and
	 * draws the meter exactly as the visible pages do. That is the whole point: reading
	 * ahead is not a way to accumulate pages a reader is not entitled to, it just warms
	 * the browser cache one page early so a turn feels instant.
	 */
	useEffect(() => {
		if (pageCount === 0) return;
		for (const n of spread ? [page + 2, page + 3] : [page + 1]) {
			if (n > pageCount) continue;
			const img = new Image();
			img.src = pageUrl(n);
		}
	}, [page, pageCount, pageUrl, spread]);

	// Keyboard, scoped to the reader the same way the video player scopes its keymap: a
	// document listener would steal arrow keys from a page that is mostly reading.
	const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT") return; // the page slider owns its own arrows
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

	if (pageCount === 0) {
		return (
			<div className="rounded-lg border border-base-300 bg-base-200 px-6 py-12 text-center">
				<BookOpenIcon className="mx-auto size-8 text-base-content/20" />
				<p className="mt-2 text-sm text-base-content/60">This book has no pages yet.</p>
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the container IS the reader —
		// focusable, carrying the keymap, and the element fullscreen is requested on. The
		// controls inside it are ordinary named buttons.
		<section
			ref={containerRef}
			tabIndex={0}
			onKeyDown={onKeyDown}
			aria-label={`Reader: ${title}`}
			className="overflow-hidden rounded-lg bg-neutral focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
		>
			<div className="flex min-h-[60vh] items-center justify-center gap-1 bg-neutral p-2 sm:gap-2 sm:p-4">
				{shown.map((n) => (
					<img
						key={n}
						src={pageUrl(n)}
						alt={`${title}, page ${n}`}
						// `max-h-[80vh]` rather than a fixed height: a comic page is portrait and
						// a spread is landscape, and both have to fit without cropping art.
						className="max-h-[80vh] w-auto max-w-full rounded object-contain shadow-lg"
						// The current page is the point of the screen; never lazy-load it.
						loading="eager"
					/>
				))}
			</div>

			<div className="flex items-center gap-2 border-t border-base-300 bg-base-200 px-2 py-2 sm:px-3">
				<TransportButton
					label="Previous page"
					icon={ChevronLeftIcon}
					onClick={previous}
					disabled={page <= 1}
				/>

				<span className="shrink-0 text-xs tabular-nums text-base-content/60">
					{shown.length > 1 ? `${shown[0]}–${shown[shown.length - 1]}` : page}
					<span className="text-base-content/35"> / {pageCount}</span>
				</span>

				{/*
				 * The page rail — the same `SeekBar` the video and music transports use, which
				 * is what makes scrubbing through a book feel like the rest of the app rather
				 * than like a different product. Its hover bubble reads in pages here because
				 * the label is what a caller passes in.
				 */}
				<SeekBar
					position={page}
					duration={pageCount}
					onSeek={(n) => goTo(Math.round(n))}
					label="Page"
					className="flex-1"
				/>

				<TransportButton
					label="Next page"
					icon={ChevronRightIcon}
					onClick={next}
					disabled={page + step > pageCount}
				/>
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
