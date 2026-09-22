// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke for the dev-only web-build harness (`/dev/web-build` + `/api/dev/build/...`).
 * Verifies the page lists a dropped build, plays it in the iframe, and that the iframe's
 * subresources resolve against the delivery route — the property the real route keeps.
 * Dev-only by construction: `/api/dev/build` is never registered outside a checkout and the
 * page exists nowhere but serve.ts's in-memory handler.
 *
 * The `demo` build is `builds/web-test/demo/`, a stub committed so this spec has something
 * to play — not a real web build, which the harness is *for* dropping in.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devCheckoutRoot } from "@anthers/db/dev-only";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixtures";

const API = `http://localhost:${process.env.API_PORT ?? 8000}`;

/**
 * The harness serves whatever a developer dropped into `builds/<id>/`. For the spec to run
 * on any checkout (CI included) it writes its own throwaway build rather than expecting one —
 * the same files the harness would otherwise find, written from here and removed after.
 */
const BUILD_ROOT = join(devCheckoutRoot() ?? "", "builds", "web-test", "demo");

test.describe("dev web-build harness", () => {
	test.beforeAll(async () => {
		await mkdir(BUILD_ROOT, { recursive: true });
		await writeFile(
			join(BUILD_ROOT, "index.html"),
			'<!doctype html><html><head><meta charset="utf-8"><title>demo</title></head>' +
				'<body><p id="msg">loading…</p><script src="game.js"></script></body></html>',
		);
		await writeFile(
			join(BUILD_ROOT, "game.js"),
			'document.getElementById("msg").textContent = "loader ran";',
		);
		await writeFile(join(BUILD_ROOT, "game.pck"), "PACK");
	});

	test.afterAll(async () => {
		await rm(join(BUILD_ROOT), { recursive: true, force: true });
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
