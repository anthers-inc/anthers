// SPDX-License-Identifier: Apache-2.0
/**
 * The ACCESS section of the shared sidebar filters (Parker, 2026-10-11): the viewer's
 * own reach over the deliverable, above the kind. Optional per tab — a tab whose
 * content carries access state supplies it (the Network's stream today, the Library with
 * its locked saves) and it renders first among the shared filters; a tab whose content
 * has no such reading (Discovery's Graph mode) omits it, and its own controls stay its own.
 *
 * Carried over from the feed-bound component this shared section came from — the
 * explainer's copy is the one that a NEW user needs: "unlocked" is a reach verdict,
 * not a price. That copy moved to the heading's (i) (Parker, 2026-10-13) — a hoverable
 * beside a section that repeats on every tab, rather than a paragraph pinned under it.
 */

import InfoTip from "@anthers/web-shared/ui/InfoTip";

const ACCESS_MODES = [
	{ id: "", label: "Any" },
	{ id: "unlocked", label: "Unlocked" },
	{ id: "locked", label: "Locked" },
] as const;

export default function AccessFilterSection({
	access,
	onAccess,
}: {
	access: string;
	onAccess: (access: string) => void;
}) {
	return (
		<section>
			{/* The (i) rides BESIDE the heading, never inside it: in the h3 its "More
			    Information" joins the heading's accessible name, and every exact-match
			    heading selector — the sidebar specs' `getByRole("heading", { exact: true })`
			    and the Library spec's `h3.textContent === name` — stops matching. */}
			<div className="flex items-center gap-1.5 mb-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40">
					Access
				</h3>
				<InfoTip
					unclipped
					text="Unlocked means you can open it: public access, or the purchase or Badge that ungates it is already yours. Locked means you cannot open it yet."
				/>
			</div>
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
						onClick={() => onAccess(mode.id)}
					>
						{mode.label}
					</button>
				))}
			</div>
		</section>
	);
}
