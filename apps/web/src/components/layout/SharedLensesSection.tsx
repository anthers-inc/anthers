// SPDX-License-Identifier: Apache-2.0
/**
 * The TAB-SHARED LENSES (Parker, 2026-10-11): the section every tab's sidebar carries
 * behind the persistent divider. A lens is a different ORGANIZING METAPHOR over a
 * corpus — never a filter wearing a new name, never a mere type grid (the retired
 * Video lens is the cautionary example: the plain grid is just the Type filter).
 *
 * 🚨 **Every row renders on every tab; the tab decides which rows are live** — that is
 * what makes the vocabulary something a user learns once rather than a per-page
 * reshuffle. A row the tab has not built is GREYED with "(Coming Soon)", never absent:
 * on the Feed only No Lens is live today, Music Player is live in the Library, and
 * Channel Guide and Bookshelf are coming-soon everywhere until their tasks build them
 * per tab. A row may be live on every tab in the future; absent is a state this
 * component no longer has.
 */

import {
	MusicalNoteIcon,
	Square3Stack3DIcon,
	Squares2X2Icon,
	TvIcon,
} from "@heroicons/react/24/outline";
import { sidebarRowClass } from "./SharedFilterSections";

/** Every lens row, in the shared order. ids are page words — each tab's state maps
 *  them to its own param through its adapter, and a row it has not built never enters
 *  its URL. */
export const LENSES = [
	{ id: "", label: "No Lens", icon: Squares2X2Icon },
	{ id: "music", label: "Music Player", icon: MusicalNoteIcon },
	{ id: "channel-guide", label: "Channel Guide", icon: TvIcon },
	{ id: "bookshelf", label: "Bookshelf", icon: Square3Stack3DIcon },
] as const;

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
	/** The ids this tab has built. No Lens is live on every tab — a tab with no
	 *  other lens built passes the default; the Library adds "music". */
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
