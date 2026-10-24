// SPDX-License-Identifier: Apache-2.0
/**
 * The reflow ebook reader — the reflowable reading experience on a vendored foliate-js
 * engine (`src/vendor/foliate-js/`, see its VENDOR.md), reading only through the section
 * and asset ladder.
 *
 * The engine glue lives in `lib/ebook-book.ts`: it fetches `GET /works/:id/sections`,
 * maps container-relative paths onto the checked ladder routes through the loader
 * upstream's own rewriting machinery is driven by, builds the book interface object the
 * vendored view opens, and hardens every section document on the way out. This component
 * is the Work's chrome around that view — navigation, the table of contents, the seek
 * bar, fullscreen and theater mode — shaped deliberately like `ComicReader`, whose
 * transport pieces
 * (`TransportButton`, `SeekBar`) it reuses and whose keyboard and touch handling it
 * extends to a reflow book.
 *
 * 🚨 The view is created imperatively: `foliate-view` is a custom element whose
 * constructor attaches a closed shadow root, so React renders a plain container and the
 * open effect appends the element, wires the events, then opens the book. Position is
 * persisted on `relocate` as a CFI the view's own fake-CFI fallback resolves on reopen.
 */

import { matchesChord } from "@anthers/shared/keybindings";
import {
	ArrowsPointingInIcon,
	ArrowsPointingOutIcon,
	BookOpenIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ListBulletIcon,
	XMarkIcon,
} from "@heroicons/react/24/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import "@/vendor/foliate-js/view.js";
import { buildEbookBook, fetchSectionManifest, LadderRefusal, SECTION_CSP } from "@/lib/ebook-book";
import { useKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { isApplePlatform } from "@/lib/platform";
import { readStoredReflow, refreshReadingPositions, writeReflow } from "@/lib/reading-positions";
import { useWorkTheater } from "@/lib/work-theater";
import SeekBar from "./transport/SeekBar";
import TheaterIcon from "./transport/TheaterIcon";
import TransportButton from "./transport/TransportButton";

/**
 * What the vendored view instance is called with, as far as the chrome ever reaches:
 * the method set upstream's `View` publishes and nothing more. Declared here rather
 * than cast through the ambient declaration, because the chrome does not need its
 * search, annotation or TTS surfaces — those are upstream features the Work reader
 * has not built chrome for.
 */
interface FoliateViewInstance extends HTMLElement {
	open(book: object): Promise<void>;
	init(opts?: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
	goTo(target: string | number | { fraction: number }): Promise<unknown>;
	goToFraction(fraction: number): Promise<void>;
	next(distance?: number): Promise<void>;
	prev(distance?: number): Promise<void>;
	goLeft(): Promise<void>;
	goRight(): Promise<void>;
	close(): void;
	renderer: HTMLElement | null;
	lastLocation: {
		fraction?: number;
		section?: { current: number; total: number };
		cfi?: string;
		tocItem?: { label: string } | null;
	} | null;
}

interface BuiltBook {
	toc: { label: string; href: string }[];
}

/**
 * How the reader paginates. `paginated` turns pages like a printed book and is the
 * default; `scrolled` is the continuous flow. Both are the vendored paginator's own
 * modes — one attribute on its element, no fork.
 */
type Flow = "paginated" | "scrolled";

type Phase = "loading" | "ready" | "refused" | "error";

export default function EbookReader({
	workId,
	apiBase,
	title,
	shareToken = null,
}: {
	workId: number;
	/** API origin, so the ladder URLs are built the one blessed way (see `rpc.ts`). */
	apiBase: string;
	title: string;
	/**
	 * The share link this user was reached by, if any — riding the query exactly as the
	 * page reader and panel mode ride it, so the manifest and unit routes resolve a
	 * share-link reader the same way they resolve a signed-in one.
	 */
	shareToken?: string | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const theater = useWorkTheater();
	const shortcuts = useKeyboardShortcuts();
	const apple = isApplePlatform();
	const viewHostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<FoliateViewInstance | null>(null);
	const [phase, setPhase] = useState<Phase>("loading");
	const [problem, setProblem] = useState<string | null>(null);
	/** Whether each loaded section's document carries the hardening policy (see the load handler). */
	const [cspPresent, setCspPresent] = useState<boolean | null>(null);
	const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
	const [tocOpen, setTocOpen] = useState(false);
	const [flow, setFlow] = useState<Flow>("paginated");
	const [fullscreen, setFullscreen] = useState(false);
	const [fraction, setFraction] = useState(0);
	const [section, setSection] = useState<{ current: number; total: number } | null>(null);

	// 🚨 **A turn the paginator is locked out of is dropped, and a dropped keypress is
	// lost input.** The vendored paginator refuses while a turn is in flight (its own
	// 100ms settle, per upstream), so a keypress, button click or swipe that lands inside
	// one would evaporate. This chain serializes them: every request — a page turn, a
	// TOC jump, a seek — turns exactly once, after the previous one lands, instead of
	// dying on the lock. The open flow below is the chain's first link, not a bypass of
	// it: the view's `init()` turns the opening page itself, under that same paginator
	// lock, so a turn queued while the book is still opening waits for the first turn to
	// land rather than racing it and dying on the lock with the very first click.
	const turnChain = useRef<Promise<unknown> | null>(null);
	const queue = useCallback((run: (view: FoliateViewInstance) => Promise<unknown>) => {
		const view = viewRef.current;
		if (!view) return;
		turnChain.current = (turnChain.current ?? Promise.resolve()).then(
			() => run(view),
			() => run(view),
		);
		return turnChain.current;
	}, []);
	const turn = useCallback(
		(direction: "left" | "right") =>
			queue((v) => (direction === "left" ? v.goLeft() : v.goRight())),
		[queue],
	);

	const goTo = useCallback(
		(target: string | number | { fraction: number }) =>
			queue((v) => v.goTo(target).catch(() => {})),
		[queue],
	);

	// One open attempt per mount. The element is created, wired, then opened against the
	// manifest-built book; the persisted position restores through `init` before the
	// first paint of pages, so a reader returns to where they left off. The whole open —
	// manifest, book build, `open`, and the first-turning `init` — is itself the turn
	// chain's first link, so nothing the reader surface queues can be dropped by the
	// paginator's lock while the opening turn is still in flight.
	useEffect(() => {
		let live = true;
		const el = document.createElement("foliate-view") as FoliateViewInstance;
		viewRef.current = el;

		el.addEventListener("relocate", (e) => {
			const detail = (e as CustomEvent).detail as {
				fraction: number;
				cfi?: string;
			};
			setFraction(detail.fraction);
			const location = el.lastLocation;
			if (location?.section) setSection(location.section);
			if (detail.cfi) writeReflow(workId, { cfi: detail.cfi, fraction: detail.fraction });
		});

		// Each section's document, as it actually loaded: the policy it carries is the one
		// fact of the hardening worth checking at runtime too — a section that loads
		// without it flips the surface's `data-csp`, which the standing security spec
		// reads. (This is parent-side reading of the loaded doc, which the sandbox's
		// `allow-same-origin` exists to allow; nothing here reaches inside a section.)
		el.addEventListener("load", (e) => {
			const doc = (e as CustomEvent).detail?.doc as Document | undefined;
			if (!doc?.head) return;
			const csp = doc.head.querySelector<HTMLElement>('meta[http-equiv="Content-Security-Policy"]');
			setCspPresent(csp?.getAttribute("content") === SECTION_CSP);
		});

		// The element belongs in the document before it opens: the paginator sizes
		// itself against its host box during the first navigation.
		viewHostRef.current?.appendChild(el);

		turnChain.current = (async () => {
			try {
				const manifest = await fetchSectionManifest(workId, apiBase, shareToken);
				if (!live) return;
				if (manifest.sections.length === 0) {
					setPhase("error");
					setProblem("This book has no readable sections.");
					return;
				}
				const book = buildEbookBook(title, manifest, apiBase, shareToken);
				await el.open(book);
				if (!live) return;
				setToc((book as BuiltBook).toc);
				// Cross-device resume: the pull lands before the position is read, so on a
				// device that has never read this book, the row adopted in that load hands
				// `readStoredReflow` here the last device's CFI. Total under failure — an
				// unreachable store resolves empty and the device reads its own state.
				await refreshReadingPositions();
				const stored = readStoredReflow(workId);
				await el.init(stored?.cfi ? { lastLocation: stored.cfi } : {});
				if (!live) {
					el.close();
					return;
				}
				setPhase("ready");
				// Open may have landed on a position the `relocate` above already wrote —
				// but only if a page landed; a first-ever open at page one reports
				// nothing, so seed the display from the view's own answer when it has one.
				if (el.lastLocation?.fraction != null) setFraction(el.lastLocation.fraction);
			} catch (err) {
				if (!live) return;
				if (err instanceof LadderRefusal) {
					setProblem(err.message);
					setPhase("refused");
				} else {
					setProblem(err instanceof Error ? err.message : String(err));
					setPhase("error");
				}
				el.remove();
			}
		})();

		const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => {
			live = false;
			document.removeEventListener("fullscreenchange", onChange);
			el.close();
			el.remove();
			viewRef.current = null;
		};
	}, [workId, apiBase, title, shareToken]);

	const toggleFullscreen = useCallback(() => {
		if (document.fullscreenElement) {
			void document.exitFullscreen();
			return;
		}
		void containerRef.current?.requestFullscreen().catch(() => {});
	}, []);

	const toggleFlow = useCallback(() => {
		const nextFlow: Flow = flow === "paginated" ? "scrolled" : "paginated";
		setFlow(nextFlow);
		viewRef.current?.renderer?.setAttribute("flow", nextFlow);
	}, [flow]);

	const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT") return;
		const view = viewRef.current;
		if (!view) return;
		// The account's player chords, matched exactly and before the modifier guard.
		if (matchesChord(e, shortcuts.fullscreen, apple)) {
			e.preventDefault();
			toggleFullscreen();
			return;
		}
		if (theater && matchesChord(e, shortcuts.theater, apple)) {
			e.preventDefault();
			theater.toggle();
			return;
		}
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		switch (e.key) {
			case "ArrowLeft":
			case "ArrowUp":
			case "PageUp":
				e.preventDefault();
				turn("left");
				return;
			case "ArrowRight":
			case "ArrowDown":
			case " ":
			case "PageDown":
				e.preventDefault();
				turn("right");
				return;
			case "Home":
				e.preventDefault();
				goTo(0);
				return;
			// Theater took `t`, so the contents list moved to the shifted pair — the
			// transport's own button is the primary way in, and the key is secondary.
			case "T":
				if (!e.shiftKey) return;
				e.preventDefault();
				setTocOpen((open) => !open);
				return;
			default:
				if (e.key === "Escape" && tocOpen) setTocOpen(false);
		}
	};

	// Touch swipe, page-style: horizontal advance, in either direction, same threshold
	// the comic reader uses so both books of a mixed library turn the same way.
	const touchStart = useRef<{ x: number; y: number } | null>(null);
	const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
		touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
	};
	const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
		const start = touchStart.current;
		touchStart.current = null;
		if (!start) return;
		const dx = e.changedTouches[0].clientX - start.x;
		const dy = e.changedTouches[0].clientY - start.y;
		if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
		if (viewRef.current) {
			if (dx < 0) turn("right");
			else turn("left");
		}
	};

	// The seek bar's value rides the book-wide fraction the relocations report.
	const seekValue = Math.round(Math.min(Math.max(fraction, 0), 1) * 1000);

	// 🚨 **One shell across every phase — never an early return over `loading`.** The open
	// effect appends the view into the holder on mount, and a loading early-return would
	// leave the holder null: the view unattached, the paginator never sized against a box,
	// the open waiting forever exactly because it was "still loading". Non-ready phases
	// render as overlays on top of the same shell instead.
	return (
		<section
			ref={containerRef}
			data-csp={cspPresent == null ? undefined : cspPresent ? "on" : "missing"}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the container IS the reader — focusable, carrying the keymap, and the element fullscreen is requested on. The controls inside it are ordinary named buttons.
			tabIndex={0}
			onKeyDown={onKeyDown}
			aria-label={`Ebook reader: ${title}`}
			className="relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-neutral focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
		>
			<div
				className="relative min-h-0 flex-1 bg-neutral"
				onTouchStart={onTouchStart}
				onTouchEnd={onTouchEnd}
			>
				{/* The vendored view is appended imperatively into this holder; it sizes
				    itself against this box, so the box is what carries the reading height. */}
				<div ref={viewHostRef} className="h-full" />
				{phase !== "ready" && (
					<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral/90 px-6 text-center">
						{phase === "loading" && (
							<>
								<BookOpenIcon className="size-8 animate-pulse text-base-content/30" />
								<p className="text-sm text-base-content/60">Opening the book…</p>
							</>
						)}
						{phase === "refused" && <p className="text-sm text-base-content/80">{problem}</p>}
						{phase === "error" && (
							<p className="text-sm text-base-content/60">
								{problem ??
									"Could not open this book. The pieces it is served in may still be processing — try again shortly."}
							</p>
						)}
					</div>
				)}
				{tocOpen && (
					<nav
						aria-label="Table of contents"
						className="absolute inset-y-0 left-0 z-20 max-h-full w-72 overflow-y-auto rounded-r-lg border border-base-300 bg-base-100/95 p-2 shadow-xl"
					>
						<div className="flex items-center justify-between px-2 py-1">
							<span className="text-sm font-semibold">Contents</span>
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								onClick={() => setTocOpen(false)}
								aria-label="Close the table of contents"
							>
								<XMarkIcon className="size-4" />
							</button>
						</div>
						<ul className="menu w-full">
							{toc.map((item) => (
								<li key={item.href}>
									<button
										type="button"
										className="text-left text-sm"
										onClick={() => {
											setTocOpen(false);
											goTo(item.href);
										}}
									>
										{item.label}
									</button>
								</li>
							))}
						</ul>
					</nav>
				)}
			</div>

			<div className="flex items-center gap-2 border-t border-base-300 bg-base-200 px-2 py-2 sm:px-3">
				<TransportButton
					label="Previous page"
					icon={ChevronLeftIcon}
					onClick={() => turn("left")}
				/>
				<span className="shrink-0 text-xs tabular-nums text-base-content/60">
					{section
						? `Section ${section.current + 1} of ${section.total}`
						: `${Math.round(fraction * 100)}%`}
					<span className="text-base-content/35"> · {Math.round(fraction * 100)}%</span>
				</span>
				<SeekBar
					position={seekValue}
					duration={1000}
					onSeek={(n) => queue((v) => v.goToFraction(n / 1000))}
					label="Reading progress"
					className="flex-1"
				/>
				<TransportButton label="Next page" icon={ChevronRightIcon} onClick={() => turn("right")} />
				<TransportButton
					label="Table of contents"
					icon={ListBulletIcon}
					onClick={() => setTocOpen((open) => !open)}
					active={tocOpen}
				/>
				<TransportButton
					label={flow === "paginated" ? "Scrolled flow" : "Paginated flow"}
					icon={BookOpenIcon}
					onClick={toggleFlow}
					active={flow === "scrolled"}
					className="hidden sm:inline-flex"
				/>
				{theater && (
					<TransportButton
						label={theater.theater ? "Exit theater mode" : "Theater mode"}
						icon={TheaterIcon}
						onClick={theater.toggle}
						active={theater.theater}
					/>
				)}
				<TransportButton
					label={fullscreen ? "Exit full screen" : "Full screen"}
					icon={fullscreen ? ArrowsPointingInIcon : ArrowsPointingOutIcon}
					onClick={toggleFullscreen}
				/>
			</div>
		</section>
	);
}
