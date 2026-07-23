// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

/** The static preview the browser loads (playwright.config.ts webServer #1). */
export const WEB_ORIGIN = "http://localhost:4173";
/** The real API (webServer #2). Pages on localhost resolve their API base here — no proxy. */
export const API_URL = "http://localhost:8000";
/**
 * Where the setup project writes the signed-in viewer's storage state (session cookie +
 * SiteGate flag). The gauntlet project loads it via its `use.storageState`.
 */
export const AUTH_STATE_PATH = fileURLToPath(
	new URL("./.auth/gauntlet-viewer.json", import.meta.url),
);

// The whole app is wrapped in SiteGate (the pre-launch "Team access" wall),
// which is authorized purely by the `anthers_site_access` localStorage flag.
// Seed it before any app script runs so every test lands on the real app
// instead of the gate — the standard way to walk an e2e harness past a
// client-side access wall. If SiteGate's storage key changes, update it here
// AND in the storageState the setup project writes.
export const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(() => {
			try {
				localStorage.setItem("anthers_site_access", "true");
			} catch {}
		});
		await use(page);
	},
});

/**
 * Strict console/page-error tracking for the authenticated specs.
 *
 * Deliberately unlike the calculators' tracker, which filters `/api/` and `auth/me`
 * failures out as *expected* — correct for a static preview with no backend, but exactly
 * the failures an authenticated walk exists to catch. Here every page error and console
 * error counts unless it matches an explicitly passed, documented allowance.
 */
export function trackErrorsStrict(page: Page, allow: RegExp[] = []): string[] {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
	page.on("console", (m) => {
		if (m.type() !== "error") return;
		const text = m.text();
		if (allow.some((re) => re.test(text))) return;
		errors.push(`console: ${text}`);
	});
	return errors;
}

export { expect };
