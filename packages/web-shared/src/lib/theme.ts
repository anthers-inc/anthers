// SPDX-License-Identifier: Apache-2.0
//
// Theme families and variants — the single source of truth shared by every app that
// renders the shared client layer (the consumer site, the Studio and the admin app).
//
// A theme is a palette family (Meadow, Reef, Ember or Heather) plus a variant (Light or
// Dark). One stored value names both, and it is also the `data-theme` attribute the
// stylesheet keys the palette blocks on: Meadow keeps its historical `light` and `dark`
// values, and every other family uses `<family>-<variant>`.
//
// Three layers cooperate:
//   1. Each app's index.html applies the stored device choice inline before first paint
//      (no flash). That snippet can't import from the bundle, so it hard-codes THEME_KEY
//      and the value list — keep it in sync with packages/shared/src/theme.ts.
//   2. This module reads/writes that device choice (localStorage) and reflects it onto
//      the document; <ThemeSelect>, <ThemeCard> and useTheme() ride it at runtime.
//   3. When signed in, the account's saved preference overrides the device choice —
//      AuthProvider applies it on load and the picker or the settings card persists
//      changes back (see below).

import type { ThemeValue } from "@anthers/shared/theme";
import { useSyncExternalStore } from "react";
import { client } from "./rpc";

export type Theme = ThemeValue;

/** localStorage key holding the device's theme choice. Mirrored in each index.html. */
export const THEME_KEY = "anthers_theme";

/** The default when nothing is stored. Mirrored in each index.html and theme.css (:root). */
export const DEFAULT_THEME: Theme = "light";

// ── The theme catalog, which the pickers render ─────────────────────────────

/** Which variant of a palette family an option is. A variant is not a family of its own:
 *  every family has one Light entry and one Dark entry. */
export type ThemeGroup = "Light" | "Dark";

export interface ThemeDefinition {
	/** The stored value — and the `data-theme` attribute the stylesheet keys the palette on. */
	value: Theme;
	/** The family's name as the picker shows it. Every variant of a family shares it, which
	 *  is how the settings card groups the catalog into family and variant radios. */
	label: string;
	group: ThemeGroup;
}

/** A palette family and the catalog's entries for its variants, in catalog order. */
export interface ThemeFamily {
	label: string;
	variants: readonly ThemeDefinition[];
}

/**
 * Every available theme, in picker order: each family's light variant before its dark
 * one, and the families in the order they should appear. A new theme joins by adding a
 * value to `THEME_VALUES`, a block per variant to theme.css, and an entry here — the
 * pickers derive their lists from this table and nothing else.
 */
export const THEMES: readonly ThemeDefinition[] = [
	{ value: "light", label: "Meadow", group: "Light" },
	{ value: "dark", label: "Meadow", group: "Dark" },
	{ value: "reef-light", label: "Reef", group: "Light" },
	{ value: "reef-dark", label: "Reef", group: "Dark" },
	{ value: "ember-light", label: "Ember", group: "Light" },
	{ value: "ember-dark", label: "Ember", group: "Dark" },
	{ value: "heather-light", label: "Heather", group: "Light" },
	{ value: "heather-dark", label: "Heather", group: "Dark" },
];

/**
 * The catalog grouped into families, in first-appearance order. Every variant of a family
 * shares the label; the variants keep the catalog's order, so the light entry is first.
 */
export function themeFamilies(): ThemeFamily[] {
	const labels = [...new Set(THEMES.map((option) => option.label))];
	return labels.map((label) => ({
		label,
		variants: THEMES.filter((option) => option.label === label),
	}));
}

/** The catalog entry for a value, or null when this build does not know it. */
export function themeDefinition(value: string | null | undefined): ThemeDefinition | null {
	return THEMES.find((option) => option.value === value) ?? null;
}

/**
 * A known stored value as a theme, or null. Used at both doors a value enters through —
 * localStorage and an account preference — so a value this build no longer ships (or
 * never shipped) falls back to the default rather than setting an attribute with no
 * palette block behind it.
 */
export function themeForValue(value: string | null | undefined): Theme | null {
	return themeDefinition(value)?.value ?? null;
}

/** The variant a theme belongs to. */
export function themeVariant(theme: Theme): ThemeGroup {
	return themeDefinition(theme)?.group ?? "Light";
}

/** The family a theme belongs to, as the picker spells it. */
export function themeFamily(theme: Theme): string {
	return themeDefinition(theme)?.label ?? "Meadow";
}

/** Whether a theme is a dark variant. */
export function isDarkTheme(theme: Theme): boolean {
	return themeVariant(theme) === "Dark";
}

/** The same family in another variant; the default when the family has no such variant. */
export function withVariant(theme: Theme, variant: ThemeGroup): Theme {
	const family = themeFamily(theme);
	return (
		THEMES.find((option) => option.label === family && option.group === variant)?.value ??
		DEFAULT_THEME
	);
}

/** The stored device theme, defaulting to {@link DEFAULT_THEME} when unset/unavailable. */
export function getStoredTheme(): Theme {
	try {
		return themeForValue(localStorage.getItem(THEME_KEY)) ?? DEFAULT_THEME;
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
	return themeForValue(document.documentElement.getAttribute("data-theme")) ?? DEFAULT_THEME;
}

const getServerSnapshot = (): Theme => DEFAULT_THEME;

/**
 * The current theme, tracking the live `data-theme` on <html>. Reflects whoever set it —
 * the pre-paint script, the account-preference sync, or the picker — so consumers stay
 * correct no matter the source of the change.
 */
export function useTheme(): Theme {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
