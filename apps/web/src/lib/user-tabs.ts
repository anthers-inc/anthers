// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in site's three tabs, in the one order they render (Parker, 2026-10-20).
 *
 * 🚨 **The order is fixed, and the account does not arrange it.** The sidebar offered
 * drag-to-reorder until 2026-10-20, when the order stopped being how a session chose where
 * to land; the starting tab became its own setting (`homeDefaultTab` on `user_preferences`).
 * Reordering survived only as a way to set that, so it went with the rule.
 *
 * The ids are the vocabulary the API validates (`NAV_IDS` in `routes/accounts.ts`) and the
 * type rides the auth payload, so the client and the server cannot name different tabs.
 */
import type { UserTabId } from "@anthers/web-shared/auth";
import { MagnifyingGlassIcon, RectangleStackIcon, RssIcon } from "@heroicons/react/24/outline";
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
		to: "/network",
		id: "network",
		label: "Network",
		icon: RssIcon,
		blurb: "What the creators you follow have released, in the order it happened.",
	},
	{
		to: "/discovery",
		id: "discovery",
		label: "Discovery",
		icon: MagnifyingGlassIcon,
		blurb: "People to follow, and the newest work across the whole site.",
	},
];

/** Where a session opens when the account has never chosen a tab. */
export const DEFAULT_USER_TAB: UserTabId = "network";

/**
 * Where a tab id points. Null — an account that never chose — reads as the default, and
 * so does an id this build's nav no longer has, so a stale payload can only ever land a
 * reader on a real tab.
 */
export function userTabPath(id: string | null | undefined): string {
	const chosen = USER_TABS.find((tab) => tab.id === id);
	if (chosen) return chosen.to;
	return USER_TABS.find((tab) => tab.id === DEFAULT_USER_TAB)?.to ?? USER_TABS[0].to;
}
