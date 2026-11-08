// SPDX-License-Identifier: Apache-2.0
/**
 * The **View As control** — the creator's four ways to look at their own Work, Project,
 * Post or profile: `Creator | Unlocked | Locked | Signed-Out` (Parker, 2026-10-16;
 * moved to the header 2026-11-07).
 *
 * It lives in the **top bar's center**, where the search bar sits in user mode, and a
 * page registers it through the layout's top-bar slot. That is the same place on every
 * subject page, so a creator moving from a Work to a Project to a post to their profile
 * finds the control where it was rather than learning a new corner each time.
 *
 * 🚨 **The mode lives in the URL, not in this component** (the preview's standing rule):
 * a preview survives a refresh, can be linked to, and is visible. While a preview is
 * active the page renders the *user's* view, and the owner's copy of that view keeps the
 * same control — switching back to Creator is always the same four buttons in the same
 * place.
 *
 * The imagined user comes in exactly two shapes. Unlocked has cleared every gate —
 * given the creator a very large monthly amount and bought the subject outright
 * (`?previewAs=unlocked`) — and Locked has given nothing and bought nothing
 * (`?previewAs=locked`; `?previewAs=out` is signed-out, and "Creator" clears the
 * preview). The retired monthly-amount slider's ladder was read by nobody; what a
 * creator wants from a preview is the consequence — what a user meets — not the dial.
 */

import { useSearchParams } from "@anthers/web-shared/router";
import { useSidebar } from "@anthers/web-shared/sidebar";
import { useEffect } from "react";

export type ViewMode = "creator" | "unlocked" | "locked" | "out";

/**
 * Read the control's mode out of a page's URL search params. The control and the page
 * both render from the URL, so the active button stays where the mode is. A numeric
 * `previewAs` — the retired slider's shape, still resolved by the API — reads as
 * whichever user shape its amount would resolve to.
 */
export function viewModeOfParams(params: Record<string, string | null | undefined>): ViewMode {
	const as = params.previewAs;
	if (!as) return "creator";
	if (as === "out") return "out";
	if (as === "unlocked") return "unlocked";
	if (as === "locked") return "locked";
	const n = Number(as);
	return Number.isFinite(n) && n > 0 ? "unlocked" : "locked";
}

const MODES: Array<{ mode: ViewMode; label: string; short: string }> = [
	{ mode: "creator", label: "Creator", short: "Creator" },
	{ mode: "unlocked", label: "User (Unlocked)", short: "Unlocked" },
	{ mode: "locked", label: "User (Locked)", short: "Locked" },
	{ mode: "out", label: "Signed-Out", short: "Signed-Out" },
];

/**
 * The control itself. The switch happens entirely through the URL, so it owns no state:
 * previewing from the editor tears it down for the user's view, and "Creator" from there
 * rebuilds it — the same pair of renders leading to each other.
 *
 * The visible labels are short because the header is a strip; the full name rides each
 * button's accessible name and title, so "Unlocked" still reads as `User (Unlocked)` to
 * a screen reader and on hover.
 */
export function ViewAsControl({ subject = "Work" }: { subject?: string }) {
	const [params, setParams] = useSearchParams();
	const active = viewModeOfParams({ previewAs: params.get("previewAs") ?? undefined });
	const set = (mode: ViewMode) => {
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
		// control that does not read as a second tab strip.
		<fieldset className="m-0 w-[min(46vw,640px)] min-w-0 border-0 p-0">
			<legend className="sr-only">View this {subject} as</legend>
			<div className="flex w-full items-center justify-center gap-2">
				<span
					aria-hidden
					className="hidden text-[10px] font-semibold uppercase tracking-wider text-base-content/50 lg:block"
				>
					View As
				</span>
				<div className="rounded-box flex min-w-0 flex-auto justify-center gap-1 border border-base-300 bg-base-200/40 p-1">
					{MODES.map(({ mode, label, short }) => (
						<button
							key={mode}
							type="button"
							aria-pressed={mode === active}
							aria-label={label}
							title={label}
							className={`btn btn-xs flex-auto whitespace-nowrap ${mode === active ? "btn-active" : "btn-ghost"}`}
							onClick={() => set(mode)}
						>
							{short}
						</button>
					))}
				</div>
			</div>
		</fieldset>
	);
}

/**
 * Register the View As control in the layout's top-bar slot while a subject's owner is
 * on the page. The control is made inside the effect rather than passed in, so a page's
 * render does not churn the slot's identity; the effect keys on the subject and whether
 * the viewer owns it.
 */
export function useTopBarViewAs(subject: string, enabled: boolean) {
	const { setTopBarContent } = useSidebar();
	useEffect(() => {
		if (!enabled) {
			setTopBarContent(null);
			return;
		}
		setTopBarContent(<ViewAsControl subject={subject} />);
		return () => setTopBarContent(null);
	}, [subject, enabled, setTopBarContent]);
}
