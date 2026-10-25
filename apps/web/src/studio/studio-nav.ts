// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's nav, which is the sidebar in studio mode (`components/layout/app-mode.ts`).
 *
 * 🚨 **These are PLACES, one object per tab, and the division has two generations.** The nav
 * read *Dashboard · Catalog · New Post · Analytics · Settings* until 2026-09-11 — a verb
 * sitting among locations — and then *Dashboard · Catalog · Posts · …* with the Catalog owning
 * Projects and Works, until 2026-10-10 split the Catalog tab (Parker: one object, one tab):
 * **Projects** owns projects, **Works** owns works, **Posts** owns posts, and the
 * **Dashboard** says what needs attention. Keep the New buttons on each index rather than
 * bringing one back up here. "Catalog" survives as the noun for a creator's whole body of
 * work (the wiki's *How Anthers Talks About Itself*), never as a tab.
 *
 * ⭐ **The tab above these is not in this list, and cannot be** (2026-10-23). The creator's own
 * profile leads the nav, carrying their thumbnail and name, and it lives in
 * `LoggedInLayout.tsx` because its label is the signed-in account's rather than a constant.
 * The Dashboard went with it, onto that profile — so a creator's home and the worklist that
 * tells them what needs them are the same surface, and `/studio` is a redirect to it.
 *
 * Every path comes from `studioUrl`, the one place the `/studio` prefix is written.
 */

import { studioUrl } from "@anthers/web-shared/studio";
import {
	ChartBarIcon,
	Cog6ToothIcon,
	CreditCardIcon,
	PencilSquareIcon,
	RectangleStackIcon,
	Square3Stack3DIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";

export interface StudioNavItem {
	to: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	/**
	 * The paths this item is the place for. An object's own pages count as its tab's, so a
	 * Work's Edit page shows the Works tab as where the creator is rather than showing nothing.
	 */
	owns: readonly string[];
}

export const STUDIO_NAV: readonly StudioNavItem[] = [
	// A Project groups the Works, so it reads first — the same order the old
	// Catalog page's sections kept.
	{
		to: studioUrl("/projects"),
		label: "Projects",
		icon: Square3Stack3DIcon,
		owns: [studioUrl("/projects")],
	},
	// Works, NOT a "Library" tab. Library is the bound term for the USER's own owned content,
	// and `/studio/library` redirects to the Works page — kept for bookmarks predating the
	// 2026-08-13 rename. "Catalog" is the noun for the whole body of work; a Work's own pages
	// count as this tab's.
	{
		to: studioUrl("/works"),
		label: "Works",
		icon: RectangleStackIcon,
		owns: [studioUrl("/works")],
	},
	{
		to: studioUrl("/posts"),
		label: "Posts",
		icon: PencilSquareIcon,
		owns: [studioUrl("/posts")],
	},
	{
		to: studioUrl("/analytics"),
		label: "Analytics",
		icon: ChartBarIcon,
		owns: [studioUrl("/analytics")],
	},
	// Payments is a place of its own, not a Settings section: payout setup, the connected
	// account's Stripe view, the balance and the transfer record — the money surface, where
	// Connect's own return legs land. Settings keeps account-operational things.
	{
		to: studioUrl("/payments"),
		label: "Payments",
		icon: CreditCardIcon,
		owns: [studioUrl("/payments")],
	},
	// Import is hidden: the itch.io import endpoints return "not yet implemented". Restore an
	// entry here (and the route and lazy import in App.tsx) when that lane ships.
	{
		to: studioUrl("/settings"),
		label: "Settings",
		icon: Cog6ToothIcon,
		owns: [studioUrl("/settings")],
	},
];

/** Is `item` where `pathname` is? A tab owns its own root and everything beneath it. */
export function isStudioNavActive(item: StudioNavItem, pathname: string): boolean {
	return item.owns.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}
