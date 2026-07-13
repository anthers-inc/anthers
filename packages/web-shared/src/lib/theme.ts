// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Light/dark theme — the single source of truth shared by every app that renders the
// shared client layer (the consumer site and the Studio). The Meadow palette ships a
// light set (the site default, at :root) and a dark set (at [data-theme=dark]) in the
// shared theme.css, so switching is just toggling the `data-theme` attribute on <html>.
//
// Three layers cooperate:
//   1. Each app's index.html applies the stored device choice inline before first paint
//      (no flash). That snippet can't import from the bundle, so it hard-codes THEME_KEY
//      and the default — keep it in sync with the constants here.
//   2. This module reads/writes that device choice (localStorage) and reflects it onto
//      the document; <ThemeToggle> and useTheme() ride it at runtime.
//   3. When signed in, the account's saved preference overrides the device choice —
//      AuthProvider applies it on load and the toggle persists changes back (see below).

import { useSyncExternalStore } from "react";
import { client } from "./rpc";

export type Theme = "light" | "dark";

/** localStorage key holding the device's light/dark choice. Mirrored in each index.html. */
export const THEME_KEY = "anthers_theme";

/** The default when nothing is stored. Mirrored in each index.html and theme.css (:root). */
export const DEFAULT_THEME: Theme = "light";

/** The stored device theme, defaulting to {@link DEFAULT_THEME} when unset/unavailable. */
export function getStoredTheme(): Theme {
	try {
		return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

/** Reflect a theme onto the document so the DaisyUI tokens (and baked decor) switch. */
export function applyTheme(theme: Theme): void {
	document.documentElement.setAttribute("data-theme", theme);
}

/** Persist a theme choice to the device (localStorage). */
export function storeTheme(theme: Theme): void {
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch {}
}

/**
 * Persist a theme choice to the signed-in account, so it follows the user across devices
 * and overrides the device default on their next load. Fire-and-forget: the DOM and
 * localStorage are already updated by the caller, and a stored preference is not
 * load-bearing, so a failed write is harmless (it just isn't synced).
 */
export function persistThemeToAccount(theme: Theme): void {
	client.api.accounts.me.$patch({ json: { themePreference: theme } }).catch(() => {});
}

// ── Live theme, driven by the document ───────────────────────────────────────

function subscribe(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	return () => observer.disconnect();
}

function getSnapshot(): Theme {
	const attr = document.documentElement.getAttribute("data-theme");
	return attr === "light" || attr === "dark" ? attr : DEFAULT_THEME;
}

const getServerSnapshot = (): Theme => DEFAULT_THEME;

/**
 * The current theme, tracking the live `data-theme` on <html>. Reflects whoever set it —
 * the pre-paint script, the account-preference sync, or the toggle — so consumers stay
 * correct no matter the source of the change.
 */
export function useTheme(): Theme {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
