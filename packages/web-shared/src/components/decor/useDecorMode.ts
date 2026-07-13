// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useDecorMode — the live light/dark mode for the baked-color decor layer. The
// decor SVGs bake concrete colors (a background can't inherit currentColor), so
// they can't ride DaisyUI's CSS-var swap the way normal UI does; they have to
// re-render with the other palette when the theme flips. This hook watches the
// `data-theme` attribute on <html> (what <ThemeToggle> and the pre-paint script
// set) and returns "light"/"dark", so <MeadowDecor>/<MeadowVines>/<MeadowFloor>
// recolor on toggle without the app threading theme state into this package.

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	return () => observer.disconnect();
}

function getSnapshot(): "light" | "dark" {
	return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

// Dark is the site default (see theme.css); used if there's ever no DOM to read.
const getServerSnapshot = (): "light" | "dark" => "dark";

/** The current decor mode, tracking the live `data-theme` on <html>. */
export function useDecorMode(): "light" | "dark" {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
