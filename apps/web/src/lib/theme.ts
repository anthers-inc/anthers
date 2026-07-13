// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Light/dark theme switching. The Meadow palette ships both a dark set (the site
// default, at :root) and a light set (at [data-theme=light]) in the shared
// theme.css, so switching is just toggling the `data-theme` attribute on <html>.
// The choice persists in localStorage; index.html applies it inline before first
// paint (no flash), and <ThemeToggle> keeps it in sync at runtime.

export type Theme = "light" | "dark";

const KEY = "anthers_theme";

/** The stored theme, defaulting to dark (the site's default) when unset/unavailable. */
export function getStoredTheme(): Theme {
	try {
		return localStorage.getItem(KEY) === "light" ? "light" : "dark";
	} catch {
		return "dark";
	}
}

/** Reflect a theme onto the document so the DaisyUI tokens switch. */
export function applyTheme(theme: Theme): void {
	document.documentElement.setAttribute("data-theme", theme);
}

/** Persist a theme choice. */
export function storeTheme(theme: Theme): void {
	try {
		localStorage.setItem(KEY, theme);
	} catch {}
}
