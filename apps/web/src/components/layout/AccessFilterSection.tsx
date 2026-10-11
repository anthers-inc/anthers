// SPDX-License-Identifier: Apache-2.0
/**
 * The FEED-UNIQUE Access section — the viewer's own reach over the deliverable, above
 * the kind. A MIDDLE-SECTION control of the Feed's sidebar, and deliberately not one
 * of the tab-shared filters (Parker, 2026-10-11): only the feed's stream reads it —
 * the Library states access on its cards, and Discover's price machinery is its own
 * middle section. Split out of `FeedFilterSections`, whose Type and Tags halves
 * became `SharedFilterSections` when the house sidebar structure landed.
 */

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

const ACCESS_MODES = [
	{ id: "", label: "Any" },
	{ id: "unlocked", label: "Unlocked" },
	{ id: "locked", label: "Locked" },
] as const;

export default function AccessFilterSection({
	access,
	onUpdateParams,
}: {
	access: string;
	onUpdateParams: (updates: Record<string, string>) => void;
}) {
	return (
		<section>
			<h3 className={sectionTitleClass}>Access</h3>
			<div className="flex rounded-lg bg-base-300/50 p-0.5">
				{ACCESS_MODES.map((mode) => (
					<button
						key={mode.id}
						type="button"
						className={`flex-1 text-xs py-1.5 rounded-md transition-colors font-medium ${
							access === mode.id
								? "bg-base-100 text-base-content shadow-sm"
								: "text-base-content/50 hover:text-base-content/70"
						}`}
						onClick={() => onUpdateParams({ access: mode.id })}
					>
						{mode.label}
					</button>
				))}
			</div>
			<p className="text-[11px] text-base-content/40 mt-2 leading-snug">
				Unlocked means you can open it: public access, or the purchase or Badge that ungates it is
				already yours. Locked means you cannot open it yet.
			</p>
		</section>
	);
}
