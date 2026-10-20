// SPDX-License-Identifier: Apache-2.0
//
// The preview server tells the page where its API is.
//
// 🚨 Why this spec exists. `rpc.ts` resolves a localhost page's API from the
// `<meta name="anthers-dev-api-port">` tag. Without it the page falls back to `:8000`, which is
// `make dev`'s API rather than the free port a browser session started, and the failure is silent:
// API-backed surfaces quietly reach the wrong server instead of reporting a network error. The
// per-Work link-preview rewrite (#616) dropped the announcement from `apps/web/serve.ts`, and every
// local web spec that exercises an API-backed surface failed while CI passed because its API sits
// on `:8000` anyway. Pin the tag here so a rewrite is caught by the browser lane rather than by
// whoever next wonders why a page is signed out.
//
// Both document paths this server renders must carry it: the shell at `/index.html`, and the SPA
// fallback that every other route takes.

import { API_URL, expect, test } from "./fixtures";

const API_PORT = new URL(API_URL).port;

test.describe("the preview server announces the API port it pairs with", () => {
	for (const path of ["/", "/index.html"]) {
		test(`${path} carries the session's API port`, async ({ page }) => {
			await page.goto(path);

			await expect(page.locator('meta[name="anthers-dev-api-port"]')).toHaveAttribute(
				"content",
				API_PORT,
			);
		});
	}
});
