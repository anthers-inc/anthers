// SPDX-License-Identifier: Apache-2.0
/**
 * The **Bookshelf lens** — the Library, organized the way a reading shelf is kept.
 *
 * 🚨 **This is not a filter, and the difference is the whole idea** — the same invariant
 * the music and video lenses carry: a lens is a different *organizing metaphor* over the
 * same `LensItem[]` the shelf already holds, never its own fetch and never a narrowing of
 * the grid. Here that metaphor is a bookshelf: titled spines standing in rows on shelf
 * boards, every book-like written Work on one shelf, end to end, alphabetically by title
 * (Parker, 2026-10-11 — "organized to whatever organization method the user prefers,
 * starting with an alphabetical-by-title sort"; the framing names how the shelf is kept,
 * not a widening of what sits on it, so the shelf draws `text`, `ebook` and `comic` only —
 * {@link BOOKSHELF_WORK_TYPES}, the 2026-09-20 scoping intact).
 *
 * **A spine is read by its title, not by a face-out cover.** A shelf shows bindings, and
 * a cover squeezed into a spine's width loses the one thing the shelf is for; so every
 * book stands as a titled spine, the continue-reading rail included. Its thickness,
 * height and shade come from a stable hash of the Work, so a shelf keeps its shape
 * between visits. Rows are explicit shelves rather than a CSS wrap, because each one
 * carries a board and a label; the label names the books actually standing there — their
 * letter range under the alphabetical sort, and whatever range the active draw produced
 * anywhere else, never an assumed alphabetical order.
 *
 * The **continue-reading rail** stands above the shelf rows: a spine for each Work with
 * an *unfinished* position, ordered by when it was last touched. Its rule is Parker's
 * call of 2026-10-15 (answered on the rail task): strictly past zero and strictly short
 * of the end — a finished Work is not something you continue, and a never-opened one has
 * nothing to continue to; the rail is what you continue, the shelf is everything you
 * kept. Positions there are the **user's**, one row per Work in `user_reading_positions`,
 * pushed behind every local write — so the rail is the same on every device, which is
 * the whole thing the spine markers alone could never be. Signed-out readers keep
 * whatever this device knows, which `lib/reading-positions.ts` answers for.
 *
 * A `text` Work's position is depth-scrolled (settled the same day): the article records
 * a scroll fraction in the same 0–1 currency, so the rail's promise holds across all
 * three kinds of reading — pages, reflow, scroll — from one number.
 *
 * Opening a spine routes to the Work's own reader, wherever the Work page resolves it —
 * a comic into panel mode, an ebook into page turns, `text` into the article surface —
 * the shelf they sit on is one, and the lens adds no second player.
 *
 * Organization presets are deliberately one for now (alpha by title): any dial this lens
 * grows is a fixed preset over the filter the lens defines (the 2026-09-20
 * lens-customization ruling), never an open filter builder.
 */

import { BOOKSHELF_WORK_TYPES } from "@anthers/shared/content";
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { isAccessResult, type Work } from "@anthers/web-shared/types";
import { BookOpenIcon, CheckCircleIcon, LockClosedIcon } from "@heroicons/react/24/solid";
import { useId, useLayoutEffect, useState } from "react";
import {
	readPageFraction,
	readReflowFraction,
	readScrollFraction,
	type ServerPosition,
	useReadingPositions,
} from "../../lib/reading-positions";
import type { LensItem } from "./MusicLens";

/** The lens's default organization, until more presets earn their places: by title. */
export function compareByTitle(a: string | null, b: string | null): number {
	const ta = (a ?? "Untitled").trim();
	const tb = (b ?? "Untitled").trim();
	return (
		ta.localeCompare(tb, undefined, { sensitivity: "base" }) || (a ?? "").localeCompare(b ?? "")
	);
}

/**
 * How far into a Work this device has gotten, whatever its reader — the local half of a
 * spine's fraction, used when no server row does the talking. A paged book reads page
 * over count; a reflow book reads the fraction beside its CFI; a text Work reads depth
 * scrolled. Every answer is the same 0–1 currency.
 */
export function localFraction(work: Work): number | null {
	if ((work.sectionCount ?? 0) > 0) return readReflowFraction(work.id);
	return readPageFraction(work.id, work.pageCount) ?? readScrollFraction(work.id);
}

/**
 * The continue-reading rail's membership and order — the lens's rail in one testable
 * function. An item rides the rail exactly while its position is strictly past zero and
 * strictly short of the end, reading the server store beside this device's keys; order
 * is last-touched first on the row's own timestamps, with device-only positions keeping
 * their shelf order behind the server's, which is the only stable fact either store
 * holds.
 */
export function continueReading(
	books: LensItem[],
	positions: Map<number, ServerPosition>,
): Array<{ item: LensItem; position: ServerPosition | null; fraction: number }> {
	const entries: Array<{
		item: LensItem;
		position: ServerPosition | null;
		fraction: number;
		key: string;
	}> = [];
	for (const item of books) {
		const work = item.work!;
		const position = positions.get(work.id) ?? null;
		const fraction = spineFraction(work, position);
		if (fraction == null || !(fraction > 0 && fraction < 1)) continue;
		entries.push({ item, position, fraction, key: position?.updatedAt ?? "" });
	}
	return entries
		.sort((a, b) => b.key.localeCompare(a.key) || a.item.id - b.item.id)
		.map(({ item, position, fraction }) => ({ item, position, fraction }));
}

/**
 * A spine's ribbon fraction: the **further-along of this device's position and the
 * user's row**. The shelf marker has never gone backwards on this device (the
 * panel-over-page reconciliation), so it does not go backwards across the two stores
 * either: a device that read further than the row shows its own, and a device that has
 * never read the Work shows the row. Zero means never opened, and renders no ribbon.
 */
export function spineFraction(work: Work, position: ServerPosition | null = null): number | null {
	const local = localFraction(work);
	const row = position?.progress ?? null;
	if (local == null && row == null) return null;
	// Zero, the shared "never really opened" answer of both stores, renders no ribbon
	// rather than a zero-height one.
	const fraction = Math.max(local ?? 0, row ?? 0);
	return fraction > 0 ? fraction : null;
}

/**
 * The spine's tooltip line for a reading position. A paged Work names the page; anything
 * without pages — a piece of writing scrolled to a depth, or a Work whose page count the
 * listing did not carry — says only that it is under way, rather than inventing a page.
 */
export function positionLine(work: Work, fraction: number | null): string | null {
	if (fraction == null) return null;
	if (!work.pageCount || work.pageCount <= 0) return "In progress";
	const page = Math.max(1, Math.min(work.pageCount, Math.floor(fraction * work.pageCount)));
	return `On page ${page} of ${work.pageCount}`;
}

/** The gap between two spines on a shelf, in pixels — the unit the packing budget counts in. */
export const SPINE_GAP = 4;

/** The inset the shelf rows leave on each side, in pixels, matching the row's `px-2`. */
const SHELF_INSET = 8;

const SPINE_TONES = ["primary", "secondary", "accent", "info", "success", "neutral"] as const;

/**
 * A stable hash of the Work's identity and title. A book's binding is a fact about the
 * book, so a shelf that reassigned thicknesses and shades on every render would read as
 * a loading state rather than a shelf.
 */
function spineSeed(work: Work): number {
	const text = `${work.id}:${work.title ?? ""}`;
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** A book's thickness in pixels, 30–38, so a row reads as bindings rather than equal strips. */
export function spineWidth(work: Work): number {
	return 30 + (spineSeed(work) % 5) * 2;
}

/** A book's height in pixels, 158–182, so the row's top edge is uneven the way a shelf's is. */
export function spineHeight(work: Work): number {
	return 158 + ((spineSeed(work) >>> 4) % 4) * 8;
}

/** The shade a spine wears, mixed from the active theme's own palette. */
export function spineBackground(work: Work): string {
	const tone = SPINE_TONES[(spineSeed(work) >>> 8) % SPINE_TONES.length];
	return `color-mix(in oklch, var(--color-${tone}) 42%, var(--color-base-300))`;
}

/**
 * Pack the sorted books into shelf rows no wider than `budgetPx`. Shelves are explicit
 * rows rather than a CSS wrap because each one carries a label, and a label on a wrapped
 * row would name books that are no longer on it. A book wider than the budget still gets
 * a shelf of its own rather than being dropped.
 */
export function shelvesOf(books: LensItem[], budgetPx: number): LensItem[][] {
	const shelves: LensItem[][] = [];
	let shelf: LensItem[] = [];
	let used = 0;
	for (const item of books) {
		const width = spineWidth(item.work!);
		const next = shelf.length === 0 ? width : used + SPINE_GAP + width;
		if (shelf.length > 0 && next > budgetPx) {
			shelves.push(shelf);
			shelf = [item];
			used = width;
		} else {
			shelf.push(item);
			used = next;
		}
	}
	if (shelf.length > 0) shelves.push(shelf);
	return shelves;
}

/** The character a book shelves under; anything that is not a letter or digit is "#". */
function shelfInitial(title: string | null): string {
	const first = (title ?? "Untitled").trim().charAt(0).toUpperCase();
	return /[A-Z0-9]/.test(first) ? first : "#";
}

/**
 * A shelf's label, read from the books actually standing on it: the span between its
 * first and last title's initial. In the Library that is the letter range the shelf
 * covers. A draw ordered another way — a Discovery recipe — still labels the shelf it
 * actually drew rather than assuming an alphabetical order that is not on screen.
 */
export function shelfLabel(books: LensItem[]): string {
	if (books.length === 0) return "";
	const first = shelfInitial(books[0].work?.title ?? null);
	const last = shelfInitial(books[books.length - 1].work?.title ?? null);
	if (first === last) return first;
	return first < last ? `${first}–${last}` : `${last}–${first}`;
}

/**
 * How much horizontal room a shelf row has, in pixels, following the container's own
 * width. The ref is a callback so the observer attaches when the shelf container actually
 * mounts — the lens draws its empty state before any books exist. The measurement runs in
 * a layout effect so the first paint already has shelves rather than one long row that
 * reflows a frame later.
 */
function useShelfBudget(): [(node: HTMLDivElement | null) => void, number] {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [budget, setBudget] = useState(0);
	useLayoutEffect(() => {
		if (!element) return;
		const measure = () => {
			const width = Math.max(0, element.clientWidth - SHELF_INSET * 2);
			setBudget((current) => (current === width ? current : width));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, budget];
}

/**
 * One book, standing: its title down the spine, its thickness, height and shade fixed by
 * its own identity, with the reading ribbon, the lock and the purchased mark as overlays.
 * The rail and the shelf share it, so both read the same way.
 */
function Spine({
	work,
	fraction,
	purchased,
	locked,
}: {
	work: Work;
	fraction: number | null;
	purchased: boolean;
	locked: boolean;
}) {
	return (
		<span
			className="relative block overflow-hidden rounded-[2px] shadow-[1px_2px_4px_rgb(0_0_0_/_0.3)]"
			style={{
				width: spineWidth(work),
				height: spineHeight(work),
				backgroundColor: spineBackground(work),
			}}
		>
			{/* The rounded edge of a binding: a highlight down one side, shade down the other. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/10 via-transparent to-black/15"
			/>
			{/* The head and tail bands a bound book carries. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-1 top-2 border-t border-base-content/20"
			/>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-1 bottom-2 border-t border-base-content/20"
			/>
			<span className="absolute inset-x-0 bottom-4 top-4 flex items-center justify-center overflow-hidden px-0.5">
				<span className="truncate whitespace-nowrap font-serif text-[11px] leading-none tracking-wide [writing-mode:vertical-rl]">
					{work.title || "Untitled"}
				</span>
			</span>
			{fraction != null && (
				// The progress marker the shelf metaphor promises: a ribbon hanging from
				// the top of the spine, however deep into the book the reader got. The
				// page position itself rides the spine's own `title` — a ribbon is a
				// mark, not a control.
				<span
					data-testid="spine-marker"
					className="absolute right-0 top-0 w-1 bg-primary"
					style={{ height: `${Math.round(fraction * 100)}%` }}
				/>
			)}
			{locked && (
				<span className="absolute left-1 top-1 rounded-full bg-black/60 p-1 text-white">
					<LockClosedIcon className="size-2.5" />
					<span className="sr-only">Gated</span>
				</span>
			)}
			{purchased && (
				<span className="absolute bottom-1 left-1 rounded-full bg-black/60 p-0.5 text-white">
					<CheckCircleIcon className="size-2.5" />
					<span className="sr-only">Purchased</span>
				</span>
			)}
			{/* The affordance a spine offers: not a tile zoom, an opening. */}
			<span className="absolute inset-0 hidden items-center justify-center bg-black/30 group-hover:flex group-hover:bg-base-content/20">
				<BookOpenIcon className="size-6 text-base-100 drop-shadow" />
			</span>
		</span>
	);
}

/**
 * One entry on the rail or a shelf: the spine, linked to its reader when the Work has an
 * address, with the tooltip the lens's own words carry.
 */
function BookStand({
	item,
	fraction,
	locked,
	title,
}: {
	item: LensItem;
	fraction: number | null;
	locked: boolean;
	title: string;
}) {
	const work = item.work!;
	const to =
		work.publicId != null && work.slug
			? workUrl({ slug: work.slug, publicId: work.publicId })
			: null;
	const spine = (
		<Spine work={work} fraction={fraction} purchased={!!item.purchased} locked={locked} />
	);
	return (
		<li className="group shrink-0" title={title}>
			{to ? (
				<Link
					to={to}
					className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
				>
					{spine}
				</Link>
			) : (
				<span className="block cursor-default">{spine}</span>
			)}
		</li>
	);
}

/** The board a shelf row stands on, and the label plate on its front edge. */
function ShelfBoard({ label, labelId }: { label: string; labelId: string }) {
	return (
		<div className="relative h-3.5 rounded-[3px] border-b border-black/20 bg-gradient-to-b from-base-200 to-base-300 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.12),0_3px_4px_rgb(0_0_0_/_0.22)]">
			<span
				id={labelId}
				data-testid="shelf-label"
				className="absolute left-3 top-1/2 -translate-y-1/2 rounded-[2px] border border-base-content/15 bg-base-100 px-2 text-[10px] font-semibold uppercase leading-5 tracking-[0.12em] text-base-content/65 shadow-sm"
			>
				{label}
			</span>
		</div>
	);
}

export default function BookshelfLens({
	items,
	source = "library",
}: {
	items: LensItem[];
	/**
	 * Where the shelf is drawing from — the Library's kept books, or Discovery's stream,
	 * whose network-shaped words differ from its whole-site ones. Only the empty state's
	 * words differ: the shelf itself is the same metaphor over whichever corpus the page
	 * hands it.
	 */
	source?: "library" | "network" | "discovery";
}) {
	const books = items
		.filter(
			(i) =>
				i.kind === "work" &&
				i.work != null &&
				(BOOKSHELF_WORK_TYPES as readonly string[]).includes(i.work.type),
		)
		.sort((a, b) => compareByTitle(a.work!.title, b.work!.title));
	const positions = useReadingPositions();
	const [shelfRef, budget] = useShelfBudget();
	const labelBase = useId();

	if (books.length === 0) {
		if (source === "discovery") {
			return (
				<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
					<BookOpenIcon className="mx-auto size-10 text-base-content/20" />
					<h2 className="mt-3 text-lg font-bold">Nothing to read in the stream yet</h2>
					<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
						Books, comics, and writing arrive here as creators release them. Widen the window or
						clear a filter to see more.
					</p>
					<Link to="/discovery" className="btn btn-primary btn-sm mt-4">
						See everything new
					</Link>
				</div>
			);
		}
		const forNetwork = source === "network";
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<BookOpenIcon className="mx-auto size-10 text-base-content/20" />
				<h2 className="mt-3 text-lg font-bold">
					{forNetwork ? "Nothing to read in your feed yet" : "Nothing on the shelf yet"}
				</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					{forNetwork
						? "Books, comics, and writing from the creators in your network arrive here as they release them. Follow, support, or save a creator and their work joins the feed."
						: "Save a book, a comic or a piece of writing and it takes its place here — free work included. You don't have to buy something to keep it."}
				</p>
				<Link to="/discovery" className="btn btn-primary btn-sm mt-4">
					{forNetwork ? "Find creators to follow" : "Find something to read"}
				</Link>
			</div>
		);
	}

	// Reading the hook's store keeps the rail live across the refreshes a reader's
	// pushes trigger elsewhere.
	const rail = continueReading(books, positions);
	const shelves = budget > 0 ? shelvesOf(books, budget) : [books];

	return (
		<section aria-label="Bookshelf">
			{rail.length > 0 && (
				<>
					<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
						Continue reading
					</h2>
					<ol
						data-testid="continue-reading"
						aria-label="Continue reading"
						className="mb-10 flex flex-nowrap items-end gap-x-1 overflow-x-auto px-2 pb-2"
					>
						{rail.map(({ item, fraction }) => {
							const work = item.work!;
							const locked = isAccessResult(work.access) && work.access.canAccess === false;
							return (
								<BookStand
									key={item.id}
									item={item}
									fraction={fraction}
									locked={locked}
									title={[work.title || "Untitled", "Continue", positionLine(work, fraction)]
										.filter(Boolean)
										.join(" — ")}
								/>
							);
						})}
					</ol>
				</>
			)}
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Bookshelf
			</h2>
			<div ref={shelfRef} data-testid="bookshelf-shelf" className="space-y-8">
				{shelves.map((shelf, index) => {
					const labelId = `${labelBase}-shelf-${index}`;
					return (
						<div key={shelf[0]?.id ?? "shelf"}>
							<ol aria-labelledby={labelId} className="flex items-end gap-x-1 px-2">
								{shelf.map((item) => {
									const work = item.work!;
									const locked = isAccessResult(work.access) && work.access.canAccess === false;
									// The user's position when the store has it — the same on every
									// device — and this device's keys otherwise, each spine showing
									// the further-along of the two, never a backwards step.
									const fraction = spineFraction(work, positions.get(work.id) ?? null);
									return (
										<BookStand
											key={item.id}
											item={item}
											fraction={fraction}
											locked={locked}
											title={[
												work.title || "Untitled",
												item.purchased ? "Purchased" : null,
												locked ? "Gated" : null,
												positionLine(work, fraction),
											]
												.filter(Boolean)
												.join(" — ")}
										/>
									);
								})}
							</ol>
							<ShelfBoard label={shelfLabel(shelf)} labelId={labelId} />
						</div>
					);
				})}
			</div>
		</section>
	);
}
