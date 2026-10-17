// SPDX-License-Identifier: Apache-2.0
/**
 * The **View As row** — the creator's four ways to look at their own Work:
 * `Creator | User (Unlocked) | User (Locked) | Signed-Out` (Parker, 2026-10-16).
 *
 * It lives on the Manage tab — the right column's first tab and the one a creator's
 * page opens on — under the Kind row that leads the tab (Parker, 2026-10-17). It
 * replaced the top editing banner: editing is inline — the pencil is the only edit
 * affordance and nothing changes without a click on it — so a mode banner earned
 * nothing by standing.
 *
 * 🚨 **The mode lives in the URL, not in this component** (the preview's standing
 * rule): a preview survives a refresh, can be linked to, and is visible. While a
 * preview is active the page renders the *user's* Record, and the owner's copy of
 * that Record carries the same Manage tab with this row in it (Parker, 2026-10-17)
 * — the row does not move to the page's top, so the way to switch view and the way
 * back to Creator are always the same four buttons, in the same place.
 *
 * The imagined user comes in exactly two shapes now. Unlocked has cleared every gate —
 * given the creator a very large monthly amount and bought the Work outright
 * (`?previewAs=unlocked`) — and Locked has given nothing and bought nothing
 * (`?previewAs=locked`; `?previewAs=out` is signed-out, and "Creator" clears the
 * preview). The retired monthly-amount slider's ladder was read by nobody; what a
 * creator wants from a preview is the consequence — what a user meets — not the dial.
 */

import { useSearchParams } from "@anthers/web-shared/router";

import { WORK_DETAILS_HEADING_CLASS } from "./WorkLayout";

export type WorkViewMode = "creator" | "unlocked" | "locked" | "out";

/** The preview query a mode writes (an empty record for "creator"). */
export function previewQueryFor(mode: WorkViewMode): Record<string, string> {
	return mode === "creator" ? {} : { previewAs: mode };
}

/**
 * Read the row's mode out of a page's URL search params. The editor and the previewed
 * page both render this from the URL, so the active button stays where the mode is.
 * A numeric `previewAs` — the retired slider's shape, still resolved by the API — reads
 * as whichever user shape its amount would resolve to.
 */
export function viewModeOfParams(params: Record<string, string | null | undefined>): WorkViewMode {
	const as = params.previewAs;
	if (!as) return "creator";
	if (as === "out") return "out";
	if (as === "unlocked") return "unlocked";
	if (as === "locked") return "locked";
	const n = Number(as);
	return Number.isFinite(n) && n > 0 ? "unlocked" : "locked";
}

const MODES: Array<{ mode: WorkViewMode; label: string }> = [
	{ mode: "creator", label: "Creator" },
	{ mode: "unlocked", label: "User (Unlocked)" },
	{ mode: "locked", label: "User (Locked)" },
	{ mode: "out", label: "Signed-Out" },
];

/**
 * The row itself. The mode's own switch happens entirely through the URL, so the owner
 * of no other state: previewing from the editor tears it down for the user's Record,
 * and "Creator" from there rebuilds it — the same pair of pages leading to each other.
 */
export function WorkViewAsRow({ subject = "Work" }: { subject?: string }) {
	const [params, setParams] = useSearchParams();
	const active = viewModeOfParams({
		previewAs: params.get("previewAs") ?? undefined,
	});
	const set = (mode: WorkViewMode) => {
		const p = new URLSearchParams(params);
		p.delete("previewAs");
		p.delete("previewOwned");
		if (mode !== "creator") p.set("previewAs", mode);
		setParams(p, { replace: true });
	};
	return (
		// A `fieldset` over a `role="group"` (the same screen-reader name without the role
		// redundancy); the legend hides. The trough — an inset-bordered box rather than the
		// button-join the page's tab bars carry — keeps this a segmented single-choice
		// control that does not read as a second tab strip, and takes the row's full width.
		<fieldset className="m-0 border-0 p-0">
			<legend className="sr-only">View this {subject} as</legend>
			{/* Basis auto, not flex-1: the buttons are as wide as their labels first and grow
			    to fill the row, so a label never wraps; the row itself wraps when the width
			    cannot take all four (only the narrowest phones' viewport). */}
			<div className="rounded-box flex flex-wrap gap-1 border border-base-300 bg-base-200/40 p-1">
				{MODES.map(({ mode, label }) => (
					<button
						key={mode}
						type="button"
						aria-pressed={mode === active}
						className={`btn btn-xs sm:btn-sm flex-auto whitespace-nowrap ${mode === active ? "btn-active" : "btn-ghost"}`}
						onClick={() => set(mode)}
					>
						{label}
					</button>
				))}
			</div>
		</fieldset>
	);
}

/**
 * The row in its Manage-tab section — the heading and the trough are one placement,
 * drawn by the editor's tab and the previewed page's alike so the row stands in the
 * same place on the page whichever mode the creator is in (Parker, 2026-10-17).
 */
export function WorkViewAsSection({ subject = "Work" }: { subject?: string }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className={WORK_DETAILS_HEADING_CLASS}>View As</h3>
			<WorkViewAsRow subject={subject} />
		</section>
	);
}
