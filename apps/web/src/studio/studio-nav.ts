// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's nav, which is the sidebar in studio mode (`components/layout/app-mode.ts`).
 *
 * 🚨 **These are PLACES, and one of them was an action until 2026-09-11.** The nav read
 * *Dashboard · Catalog · New Post · Analytics · Settings*: a verb sitting among locations,
 * belonging to the object that carries the least, while Projects — which has two routes and
 * its own wiki page — had no entry at all. Anthers has three clean objects and the tabs
 * divide along them (Parker): the **Catalog** owns Projects and Works, **Posts** owns posts,
 * and the **Dashboard** stopped being an overview of everything so it can say what needs
 * attention. Keep the New buttons on each index rather than bringing one back up here.
 *
 * Every path comes from `studioUrl`, the one place the `/studio` prefix is written.
 */

import { studioUrl } from "@anthers/web-shared/studio";
import {
	ChartBarIcon,
	Cog6ToothIcon,
	PencilSquareIcon,
	RectangleStackIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";

export interface StudioNavItem {
	to: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	/**
	 * The paths this item is the place for. An object's own pages count as its tab's, so a
	 * Work's Edit page shows the Catalog as where the creator is rather than showing nothing.
	 */
	owns: readonly string[];
}

export const STUDIO_NAV: readonly StudioNavItem[] = [
	{ to: studioUrl("/"), label: "Dashboard", icon: Squares2X2Icon, owns: [] },
	// Catalog, NOT "Library". A creator keeps a Catalog of Works; **Library is the bound term
	// for the USER's own owned content**, so the two were the same word for opposite things.
	// `/studio/library` redirects here — kept for bookmarks predating the 2026-08-13 rename.
	{
		to: studioUrl("/catalog"),
		label: "Catalog",
		icon: RectangleStackIcon,
		owns: [studioUrl("/catalog"), studioUrl("/works"), studioUrl("/projects")],
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
	// Import is hidden: the itch.io import endpoints return "not yet implemented". Restore an
	// entry here (and the route and lazy import in App.tsx) when that lane ships.
	{
		to: studioUrl("/settings"),
		label: "Settings",
		icon: Cog6ToothIcon,
		owns: [studioUrl("/settings")],
	},
];

/** Is `item` where `pathname` is? The Dashboard is the Studio's root and matches only exactly. */
export function isStudioNavActive(item: StudioNavItem, pathname: string): boolean {
	if (item.owns.length === 0) return pathname === item.to;
	return item.owns.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}
