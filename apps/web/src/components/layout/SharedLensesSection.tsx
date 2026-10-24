// SPDX-License-Identifier: Apache-2.0
/**
 * The TAB-SHARED LENSES (Parker, 2026-10-11): the section every tab's sidebar carries
 * behind the persistent divider. A lens is a different ORGANIZING METAPHOR over a
 * corpus — never a filter wearing a new name, never a mere type grid (the retired
 * Video lens is the cautionary example: the plain grid is just the Type filter).
 *
 * 🚨 **Every row renders on every tab; the tab decides which rows are live** — that is
 * what makes the vocabulary something a user learns once rather than a per-page
 * reshuffle. A row the tab has not built is GRAYED with "(Coming Soon)", never absent.
 * Since 2026-10-23 every lens is built on every user tab (Parker), so the Library, the
 * Network and Discovery each pass {@link ALL_LENS_IDS}: a lens is a view over whatever
 * corpus its tab hands it, and none of the three needed the tab to be different. The
 * per-tab set stays the mechanism rather than being deleted — a lens added to the list
 * is grayed on every tab until its meaning there is built, and absent remains a state
 * this component does not have.
 */

import {
	MusicalNoteIcon,
	Square3Stack3DIcon,
	Squares2X2Icon,
	TvIcon,
} from "@heroicons/react/24/outline";
import { sidebarRowClass } from "./sidebar-row-class";

/** Every lens row, in the shared order. ids are page words — each tab's state maps
 *  them to its own param through its adapter, and a row it has not built never enters
 *  its URL. */
export const LENSES = [
	{ id: "", label: "No Lens", icon: Squares2X2Icon },
	{ id: "music", label: "Music Player", icon: MusicalNoteIcon },
	{ id: "channel-guide", label: "Channel Guide", icon: TvIcon },
	{ id: "bookshelf", label: "Bookshelf", icon: Square3Stack3DIcon },
] as const;

/**
 * Every row's id, No Lens included — the set a tab passes when it has built all of
 * them. One constant rather than a literal per page, so a page cannot silently fall
 * behind the list; a tab with a lens still to build passes its own set instead.
 */
export const ALL_LENS_IDS: ReadonlySet<string> = new Set(LENSES.map((lens) => lens.id));

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

export default function SharedLensesSection({
	lens,
	onLens,
	live = new Set([""]),
	/** Content rendered beneath a selected row's, keyed by the row's id — the
	 *  Music Player's include-spoken dial is the first rider (a control ON the
	 *  lens, beside the view it re-scopes). */
	extras = {},
}: {
	lens: string;
	onLens: (id: string) => void;
	/** The ids this tab has built. Every user tab passes {@link ALL_LENS_IDS} today;
	 *  the default is for a surface that has built no lens yet, and keeps No Lens. */
	live?: ReadonlySet<string>;
	extras?: Partial<Record<(typeof LENSES)[number]["id"], React.ReactNode>>;
}) {
	return (
		<section>
			<h3 className={sectionTitleClass}>Lenses</h3>
			<div className="flex flex-col gap-0.5">
				{LENSES.map((lensItem) => {
					const built = live.has(lensItem.id);
					return (
						<div key={lensItem.id}>
							<button
								type="button"
								disabled={!built}
								aria-disabled={!built || undefined}
								className={`${sidebarRowClass(lens === lensItem.id)} ${
									built ? "" : "opacity-40 pointer-events-none"
								}`}
								onClick={() => onLens(lensItem.id)}
							>
								<lensItem.icon className="w-5 h-5 shrink-0" />
								{lensItem.label}
								{!built && (
									<span className="ml-auto text-[10px] text-base-content/40 italic">
										(Coming Soon)
									</span>
								)}
							</button>
							{built && lens === lensItem.id && extras[lensItem.id]}
						</div>
					);
				})}
			</div>
		</section>
	);
}
