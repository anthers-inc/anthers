// SPDX-License-Identifier: Apache-2.0
/**
 * The **Bookshelf lens** — the Library, organized the way a reading shelf is kept.
 *
 * 🚨 **This is not a filter, and the difference is the whole idea** — the same invariant
 * the music and video lenses carry: a lens is a different *organizing metaphor* over the
 * same `LensItem[]` the shelf already holds, never its own fetch and never a narrowing of
 * the grid. Here that metaphor is a bookshelf: tall spines standing in packed rows instead
 * of tiles, every book-like written Work on one shelf, end to end, alphabetically by
 * title (Parker, 2026-10-11 — "organized to whatever organization method the user
 * prefers, starting with an alphabetical-by-title sort"; the framing names how the shelf
 * is kept, not a widening of what sits on it, so the shelf draws `text`, `ebook` and
 * `comic` only — {@link BOOKSHELF_WORK_TYPES}, the 2026-09-20 scoping intact).
 *
 * The **continue-reading rail** stands above the shelf rows: a spine for each Work with
 * an *unfinished* position, ordered by when it was last touched. Its rule is Parker's
 * call of 2026-10-15 (answered on the rail task): strictly past zero and strictly short
 * of the end — a finished Work is not something you continue, and a never-opened one has
 * nothing to continue to; the rail is what you continue, the shelf is everything you
 * kept. Positions there are the **user's**, one row per Work in `reading_positions`,
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
import { BookOpenIcon, LockClosedIcon } from "@heroicons/react/24/solid";
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

/** One spine, face-out with cover art or as a dust jacket without it — the rail's and the shelf's shared atom. */
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
			className={`relative block h-44 overflow-hidden bg-base-200 shadow-[2px_3px_6px_rgb(0_0_0_/_0.25)] border-b-4 border-base-300 ${
				work.thumbnail ? "w-14" : "w-9 rounded-r-sm"
			}`}
		>
			{work.thumbnail ? (
				<img src={work.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
			) : (
				// No cover: a dust-jacket spine, the title set along it the way
				// a real book's spine reads.
				<span className="flex h-full w-full items-center justify-center bg-gradient-to-r from-base-200 to-base-100 px-0.5">
					<span className="truncate whitespace-nowrap font-serif text-xs tracking-wide [writing-mode:vertical-rl]">
						{work.title || "Untitled"}
					</span>
				</span>
			)}
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
				</span>
			)}
			{purchased && (
				<span className="absolute bottom-0 left-0 right-0 bg-black/60 py-0.5 text-center text-[8px] uppercase tracking-wide text-white">
					Purchased
				</span>
			)}
			{/* The affordance a spine offers: not a tile zoom, an opening. */}
			<span className="absolute inset-0 hidden items-center justify-center bg-black/30 group-hover:flex group-hover:bg-base-content/20">
				<BookOpenIcon className="size-6 text-base-100 drop-shadow" />
			</span>
		</span>
	);
}

export default function BookshelfLens({
	items,
	source = "library",
}: {
	items: LensItem[];
	/**
	 * Where the shelf is drawing from — the Library's kept books or the Network's feed.
	 * Only the empty state's words differ: the shelf itself is the same metaphor over
	 * whichever corpus the tab hands it.
	 */
	source?: "library" | "network";
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

	if (books.length === 0) {
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

	return (
		<section aria-label="Bookshelf">
			{rail.length > 0 && (
				<>
					<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
						Continue reading
					</h2>
					<ol
						data-testid="continue-reading"
						className="mb-10 flex flex-nowrap items-end gap-x-1 overflow-x-auto pb-2"
					>
						{rail.map(({ item, fraction }) => {
							const work = item.work!;
							const to =
								work.publicId != null && work.slug
									? workUrl({ slug: work.slug, publicId: work.publicId })
									: null;
							const locked = isAccessResult(work.access) && work.access.canAccess === false;
							const spine = (
								<Spine
									work={work}
									fraction={fraction}
									purchased={!!item.purchased}
									locked={locked}
								/>
							);
							return (
								<li
									key={item.id}
									className="group shrink-0"
									title={[work.title || "Untitled", "Continue", positionLine(work, fraction)]
										.filter(Boolean)
										.join(" — ")}
								>
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
						})}
					</ol>
				</>
			)}
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Bookshelf
			</h2>
			<ol data-testid="bookshelf-shelf" className="flex flex-wrap items-end gap-x-1 gap-y-10">
				{books.map((item) => {
					const work = item.work!;
					const to =
						work.publicId != null && work.slug
							? workUrl({ slug: work.slug, publicId: work.publicId })
							: null;
					const locked = isAccessResult(work.access) && work.access.canAccess === false;
					// The user's position when the store has it — the same on every device —
					// and this device's keys otherwise, each spine showing the further-along
					// of the two, never a backwards step.
					const fraction = spineFraction(work, positions.get(work.id) ?? null);
					const spine = (
						<Spine work={work} fraction={fraction} purchased={!!item.purchased} locked={locked} />
					);
					return (
						<li
							key={item.id}
							className="group"
							title={[
								work.title || "Untitled",
								item.purchased ? "Purchased" : null,
								locked ? "Gated" : null,
								positionLine(work, fraction),
							]
								.filter(Boolean)
								.join(" — ")}
						>
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
				})}
			</ol>
		</section>
	);
}
