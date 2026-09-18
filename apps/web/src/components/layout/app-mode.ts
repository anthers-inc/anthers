// SPDX-License-Identifier: Apache-2.0
/**
 * Which half of the signed-in app somebody is in: **user** mode (Feed, Library, Discover) or
 * **studio** mode (the creator's Dashboard, Catalog, Posts, Analytics and Settings). Each has
 * its own header and its own sidebar, and neither shows the other's options (Parker,
 * 2026-09-17).
 *
 * ⭐ **The mode is sticky.** A Studio route puts a creator in studio mode and a user-only page
 * puts them in user mode, while a page belonging to neither, such as a Work page or a profile,
 * keeps whichever mode they arrived in. Following a link out of the Studio to a Work's public
 * page therefore does not swap the sidebar under them, and neither does coming back to it.
 *
 * ⚠️ **It is kept in `sessionStorage`, because React state would not survive what it has to.**
 * A reload of a Work page opened from the Studio should still be in the Studio, and the signed-in
 * layout is mounted in two places, the protected group (`/feed`, `/library` …) and `PublicShell`
 * (Work pages, profiles, the Studio), so it remounts whenever a navigation crosses between them.
 * It is per tab rather than `localStorage` because it is where somebody is, not a preference.
 */

import { useLocation } from "@anthers/web-shared/router";
import { STUDIO_ROOT } from "@anthers/web-shared/studio";
import { useEffect } from "react";

export type AppMode = "user" | "studio";

/**
 * The pages that belong to user mode, so that arriving on one leaves the Studio. The account
 * menu's pages are here, and so is the basket, because each is about the person as a reader.
 */
const USER_PATHS = [
	"/feed",
	"/library",
	"/discover",
	"/basket",
	"/subscription",
	"/purchases",
	"/settings",
] as const;

const MODE_KEY = "anthers_mode";

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** The mode a path puts somebody in, or `previous` when the path belongs to neither. */
export function modeForPath(pathname: string, previous: AppMode): AppMode {
	if (within(pathname, STUDIO_ROOT)) return "studio";
	if (USER_PATHS.some((root) => within(pathname, root))) return "user";
	return previous;
}

/**
 * The stored mode, defaulting to user mode. Anything but exactly `"studio"` counts as absent,
 * the same membership test `desktopHome()` uses, so an empty string cannot pass for a value.
 */
function storedMode(): AppMode {
	try {
		return globalThis.sessionStorage?.getItem(MODE_KEY) === "studio" ? "studio" : "user";
	} catch {
		// Storage can throw outright (Safari private mode, a locked-down webview).
		return "user";
	}
}

function storeMode(mode: AppMode): void {
	try {
		globalThis.sessionStorage?.setItem(MODE_KEY, mode);
	} catch {}
}

/**
 * The mode for the page on screen. Only a creator has a Studio to be in, so everybody else is
 * in user mode whatever was stored.
 */
export function useAppMode(isCreator: boolean): AppMode {
	const { pathname } = useLocation();
	const mode = isCreator ? modeForPath(pathname, storedMode()) : "user";
	useEffect(() => {
		if (isCreator) storeMode(mode);
	}, [isCreator, mode]);
	return mode;
}
