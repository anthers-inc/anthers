// SPDX-License-Identifier: Apache-2.0
/**
 * The sidebar row a selectable list renders with — the same shape and colors the
 * nav's own rows (`LoggedInLayout`) carry, so every selectable list in the sidebar
 * reads as ONE control family (Parker, 2026-10-11) with ONE active treatment: the
 * green of `primary`, a tinted ground plus the colored label.
 *
 * 🚨 The active treatment is `primary`, never `secondary`: light `--color-secondary`
 * is a soft yellow that as *text* on the cream base is nearly invisible. Yellow stays
 * what it is in the Meadow palette, a fill behind dark content (`badge-secondary`'s
 * tag chips and the like) — a selected row names itself in colored text, so the
 * color carrying it has to be readable as text. The Studio's listing filters use
 * `@anthers/web-shared/studio`'s `filterBtnClass`, which cannot import an apps/web
 * module — that copy carries the same active treatment by hand.
 */

export const sidebarRowClass = (isActive: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full ${
		isActive
			? "bg-primary/10 text-primary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;
