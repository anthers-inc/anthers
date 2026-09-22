// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke for the dev-only web-build harness (`/dev/web-build` + `/api/dev/build/...`).
 * Verifies the page lists a dropped build, plays it in the iframe, and that the iframe's
 * subresources resolve against the delivery route — the property the real route keeps.
 * Dev-only by construction: `/api/dev/build` is never registered outside a checkout and the
 * page exists nowhere but the dev servers.
 *
 * The fixture build is written to the directory the API itself reports it serves — asked of
 * `GET /api/dev/build` rather than computed here — so the spec and the API agree on the path
 * on any machine and in the bundled CI runner, where walking up from a module's location can
 * disagree with the API's own resolution. (CI's first run failed exactly there: the spec's
 * `devCheckoutRoot()` received an undefined path under the bundled Playwright process.)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixtures";

const API = `http://localhost:${process.env.API_PORT ?? 8000}`;

test.describe("dev web-build harness", () => {
	let buildRoot = "";

	test.beforeAll(async () => {
		// The harness must be up: if the route isn't registered (a non-checkout, or the API not
		// running yet) there is no directory to write to, and that is the failure to surface.
		const res = await fetch(`${API}/api/dev/build`).catch(() => null);
		if (!res || !res.ok) {
			throw new Error(
				`the dev build harness answered ${res?.status ?? "unreachable"} at ${API}/api/dev/build ` +
					"— it exists only when the API runs from a checkout, which the browser session arranges",
			);
		}
		const { root } = (await res.json()) as { root: string };
		buildRoot = join(root, "demo");
		await mkdir(buildRoot, { recursive: true });
		await writeFile(
			join(buildRoot, "index.html"),
			'<!doctype html><html><head><meta charset="utf-8"><title>demo</title></head>' +
				'<body><p id="msg">loading…</p><script src="game.js"></script></body></html>',
		);
		await writeFile(
			join(buildRoot, "game.js"),
			'document.getElementById("msg").textContent = "loader ran";',
		);
		await writeFile(join(buildRoot, "game.pck"), "PACK");
	});

	test.afterAll(async () => {
		await rm(buildRoot, { recursive: true, force: true });
	});

	test("lists a dropped build and plays it through the delivery route", async ({ page }) => {
		await page.goto(`${WEB_ORIGIN}/dev/web-build`, { waitUntil: "load" });
		const option = page.locator("#builds option", { hasText: "demo" });
		await expect(option).toBeAttached({ timeout: 10_000 });
		await page.selectOption("#builds", "demo");
		await expect(page.locator("#deliveryUrl")).toContainText(
			`${API}/api/dev/build/demo/index.html`,
		);
		await page.click("#play");
		await expect(page.locator("#frameWrap")).toBeVisible();
		// The <iframe> element is in the DOM always; Play sets its src and navigates in place,
		// so wait for the frame to *hold* the delivery URL rather than for an attach event that
		// already fired before we could listen for it.
		await expect(async () => {
			expect(
				page.frame({ url: /\/api\/dev\/build\/demo\/index\.html/ }),
				"iframe navigated to the delivery URL",
			).toBeTruthy();
		}).toPass({ timeout: 8000 });
		const frame = page.frame({ url: /\/api\/dev\/build\/demo\/index\.html/ });
		await expect(frame!.locator("#msg")).toHaveText("loader ran");
		// Every subresource the build asked for resolves against the delivery route:
		const pck = await page.request.get(`${API}/api/dev/build/demo/game.pck`);
		expect(pck.headers()["content-type"]).toBe("application/octet-stream");
	});
});
