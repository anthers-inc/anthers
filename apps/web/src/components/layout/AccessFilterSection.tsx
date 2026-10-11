// SPDX-License-Identifier: Apache-2.0
/**
 * The ACCESS section of the shared sidebar filters (Parker, 2026-10-11): the viewer's
 * own reach over the deliverable, above the kind. Optional per tab — a tab whose
 * content carries access state supplies it (the Feed's stream today, the Library with
 * its locked saves) and it renders first among the shared filters; a tab whose content
 * has no such reading (Discover) omits it, and its browsing machinery stays its own.
 *
 * Carried over from the feed-bound component this shared section came from — the
 * explainer's copy is the one that a NEW user needs: "unlocked" is a reach verdict,
 * not a price.
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
	onAccess,
}: {
	access: string;
	onAccess: (access: string) => void;
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
						onClick={() => onAccess(mode.id)}
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
