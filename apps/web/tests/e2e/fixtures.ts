// SPDX-License-Identifier: AGPL-3.0-or-later

import { test as base, expect } from "@playwright/test";

// The whole app is wrapped in SiteGate (the pre-launch "Team access" wall),
// which is authorized purely by the `anthers_site_access` localStorage flag.
// Seed it before any app script runs so every test lands on the real app
// instead of the gate — the standard way to walk an e2e harness past a
// client-side access wall. If SiteGate's storage key changes, update it here.
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

export { expect };
