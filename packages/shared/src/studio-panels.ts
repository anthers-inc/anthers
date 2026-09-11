// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The panels a creator can arrange on their Studio Dashboard, and which ones a creator who
 * has never touched it sees.
 *
 * 🚨 **Nothing that warns lives here** (Parker, 2026-09-11). The Dashboard's worklist —
 * payout setup that blocks every release, a released Work nobody can open, a failed encode —
 * is composed by the system, sits above these, and cannot be hidden or reordered. A warning
 * a creator can remove is one that will be removed, silently, by the person it was for.
 * These are standing content, where preference is the right input and hiding one costs
 * nothing. **Adding a panel here that says something is WRONG is the mistake this note
 * exists to prevent** — it belongs in `buildWorklist` instead.
 *
 * Shared because both sides need the same list: the client renders it and the API refuses a
 * layout naming anything else, so a typo cannot be stored and read back forever.
 */

/** Every panel that exists. The stored layout is a subset of these, in the creator's order. */
export const STUDIO_PANELS = ["earnings", "catalog", "projects", "posts"] as const;

export type StudioPanel = (typeof STUDIO_PANELS)[number];

/**
 * What a creator sees before they have arranged anything.
 *
 * Two, deliberately. The Dashboard's job is to be scannable, and a default that turns
 * everything on makes the page the overview-of-everything it stopped being — the arranging
 * is then damage control rather than a preference.
 */
export const DEFAULT_STUDIO_PANELS: StudioPanel[] = ["earnings", "catalog"];

export function isStudioPanel(value: unknown): value is StudioPanel {
	return typeof value === "string" && (STUDIO_PANELS as readonly string[]).includes(value);
}

/**
 * A stored layout, made safe to render.
 *
 * ⚠️ **A stored array is a list of names written at some point in the past**, so it can
 * carry a panel that has since been retired and can repeat one. Unknown names are dropped
 * and duplicates collapse, because the alternative is a dashboard that throws on a value the
 * database is perfectly happy to hold.
 *
 * ⭐ **`null` means "never arranged" and is not the same as an empty array.** Somebody who
 * has hidden every panel gets an empty Dashboard, which is a thing they asked for; somebody
 * who has never opened the control gets the defaults. Collapsing the two would either
 * override a real choice or hand a new creator a blank page.
 */
export function resolveStudioPanels(stored: unknown): StudioPanel[] {
	if (stored == null) return [...DEFAULT_STUDIO_PANELS];
	if (!Array.isArray(stored)) return [...DEFAULT_STUDIO_PANELS];
	const seen = new Set<StudioPanel>();
	for (const value of stored) if (isStudioPanel(value)) seen.add(value);
	return [...seen];
}

/**
 * The panels not currently on the Dashboard, in the canonical order — what the "Add a panel"
 * control offers.
 *
 * ⚠️ Canonical order rather than stored order on purpose: a creator adding a panel back is
 * choosing from a menu, and a menu whose order depends on what they previously removed reads
 * as arbitrary.
 */
export function hiddenStudioPanels(shown: StudioPanel[]): StudioPanel[] {
	return STUDIO_PANELS.filter((p) => !shown.includes(p));
}
