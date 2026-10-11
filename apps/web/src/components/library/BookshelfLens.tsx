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
 * The **spine markers** are the shelf's progress markers — the 2026-09-20 brief's
 * "spines with progress markers instead of tiles" — read per device from the same
 * localStorage the page readers write (`lib/reading-positions.ts`). A `comic` or `ebook`
 * you opened shows a ribbon hanging from its spine at however far you got; `text` Works
 * have no position notion yet and show no marker at all, honestly. The **continue-reading
 * rail** — the cross-shelf strip the same brief promised — is deliberately *not* built
 * here: positions are per-device and `text` has none, so the rail is its own tracked task
 * ("Build the Bookshelf's continue-reading rail, settling where reading progress is
 * stored", on the Anthers board) rather than a lens-local copy.
 *
 * Opening a spine routes to the Work's own reader, wherever the Work page resolves it —
 * a comic into panel mode, an ebook into page turns, `text` into the article surface —
 * the shelf they sit on is one, and the lens adds no second player.
 *
 * Organization presets are deliberately one for now (alpha by title): any dial this lens
 * grows is a fixed preset over the filter the lens defines (the 2026-09-20
 * lens-customization ruling), never an open filter builder.
 */

import { BOOKSHELF_WORK_TYPES, isPaged } from "@anthers/shared/content";
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { isAccessResult } from "@anthers/web-shared/types";
import { BookOpenIcon, LockClosedIcon } from "@heroicons/react/24/solid";
import { readPageFraction } from "../../lib/reading-positions";
import type { LensItem } from "./MusicLens";

/** The lens's default organization, until more presets earn their places: by title. */
export function compareByTitle(a: string | null, b: string | null): number {
	const ta = (a ?? "Untitled").trim();
	const tb = (b ?? "Untitled").trim();
	return (
		ta.localeCompare(tb, undefined, { sensitivity: "base" }) || (a ?? "").localeCompare(b ?? "")
	);
}

export default function BookshelfLens({ items }: { items: LensItem[] }) {
	const books = items
		.filter(
			(i) =>
				i.kind === "work" &&
				i.work != null &&
				(BOOKSHELF_WORK_TYPES as readonly string[]).includes(i.work.type),
		)
		.sort((a, b) => compareByTitle(a.work!.title, b.work!.title));

	if (books.length === 0) {
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<BookOpenIcon className="mx-auto size-10 text-base-content/20" />
				<h2 className="mt-3 text-lg font-bold">Nothing on the shelf yet</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					Save a book, a comic or a piece of writing and it takes its place here — free work
					included. You don't have to buy something to keep it.
				</p>
				<Link to="/discover" className="btn btn-primary btn-sm mt-4">
					Find something to read
				</Link>
			</div>
		);
	}

	return (
		<section aria-label="Bookshelf">
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Bookshelf
			</h2>
			<ol className="flex flex-wrap items-end gap-x-1 gap-y-10">
				{books.map((item) => {
					const work = item.work!;
					const to =
						work.publicId != null && work.slug
							? workUrl({ slug: work.slug, publicId: work.publicId })
							: null;
					const locked = isAccessResult(work.access) && work.access.canAccess === false;
					const fraction = isPaged(work.type) ? readPageFraction(work.id, work.pageCount) : null;
					const spine = (
						<span
							className={`relative block h-44 overflow-hidden bg-base-200 shadow-[2px_3px_6px_rgb(0_0_0_/_0.25)] border-b-4 border-base-300 ${
								work.thumbnail ? "w-14" : "w-9 rounded-r-sm"
							}`}
						>
							{work.thumbnail ? (
								<img
									src={work.thumbnail}
									alt=""
									className="h-full w-full object-cover"
									loading="lazy"
								/>
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
								// The progress marker the shelf metaphor promises: a ribbon
								// hanging from the top of the spine, however deep into the book
								// this device last got. The page position itself rides the
								// spine's own `title` — a ribbon is a mark, not a control.
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
							{item.purchased && (
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
					return (
						<li
							key={item.id}
							className="group"
							title={[
								work.title || "Untitled",
								item.purchased ? "Purchased" : null,
								locked ? "Gated" : null,
								fraction != null
									? `On page ${Math.max(1, Math.floor(fraction * (work.pageCount ?? 0)))} of ${work.pageCount}`
									: null,
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
