// SPDX-License-Identifier: Apache-2.0
//
// The values a stored theme preference may take, shared by the API that validates the
// preference and the web catalog that renders it. A palette family and its light/dark
// variant are two choices, but one stored value names both: `reef-dark` is the dark
// variant of Reef, and the catalog in packages/web-shared/src/lib/theme.ts carries the
// label, the variant and the picker's order.
//
// Meadow keeps its original `light` and `dark` values rather than becoming `meadow-*`.
// Preferences and account rows written before families existed are Meadow, and those
// values are still Meadow, so no stored choice silently falls back.
//
// ⚠️ The pre-paint snippets in apps/web/index.html and apps/admin/index.html cannot
// import this module, so they repeat the list; change all three together.

export const THEME_VALUES = [
	"light",
	"dark",
	"reef-light",
	"reef-dark",
	"ember-light",
	"ember-dark",
	"heather-light",
	"heather-dark",
] as const;

export type ThemeValue = (typeof THEME_VALUES)[number];
