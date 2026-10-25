// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in site's tabs, in the one order they render (Parker, 2026-10-20).
 *
 * 🚨 **The order is fixed, and the account does not arrange it.** The sidebar offered
 * drag-to-reorder until 2026-10-20, when the order stopped being how a session chose where
 * to land; the starting tab became its own setting (`homeDefaultTab` on `user_preferences`).
 * Reordering survived only as a way to set that, so it went with the rule.
 *
 * ⚠️ **There were three until 2026-10-24.** Network retired into Discovery as the
 * **My Network** recipe preset (Parker's call): the two tabs ran one route, one card and
 * one set of filters, and the only thing Network could do that Discovery's recipe
 * controls could not was the membership narrowing — which became a candidate value.
 * Keeping a second door to the same room cost a nav entry, a page and a set of per-tab
 * copies for a distinction the recipe bar now states out loud.
 *
 * The ids are the vocabulary the API validates (`NAV_IDS` in `routes/accounts.ts`) and the
 * type rides the auth payload, so the client and the server cannot name different tabs.
 */
import type { UserTabId } from "@anthers/web-shared/auth";
import { MagnifyingGlassIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import type { ComponentType } from "react";

export type { UserTabId };

export interface UserTab {
	to: string;
	id: UserTabId;
	label: string;
	icon: ComponentType<{ className?: string }>;
	/** What the tab holds, for the settings card that chooses the starting one. */
	blurb: string;
}

export const USER_TABS: readonly UserTab[] = [
	{
		to: "/library",
		id: "library",
		label: "Library",
		icon: RectangleStackIcon,
		blurb: "Every Work, Project and Post you've saved or bought.",
	},
	{
		to: "/discovery",
		id: "discovery",
		label: "Discovery",
		icon: MagnifyingGlassIcon,
		blurb: "One stream you can shape, from your own network to everything on Anthers.",
	},
];

/** Where a session opens when the account has never chosen a tab. */
export const DEFAULT_USER_TAB: UserTabId = "discovery";

/**
 * Where a tab id points. Null — an account that never chose — reads as the default, and
 * so does an id this build's nav no longer has, so a stale payload can only ever land a
 * reader on a real tab. A stored `"network"` from before the merge is exactly that case,
 * and it lands here rather than on a route that no longer renders.
 */
export function userTabPath(id: string | null | undefined): string {
	const chosen = USER_TABS.find((tab) => tab.id === id);
	if (chosen) return chosen.to;
	return USER_TABS.find((tab) => tab.id === DEFAULT_USER_TAB)?.to ?? USER_TABS[0].to;
}
