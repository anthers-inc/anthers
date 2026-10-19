// SPDX-License-Identifier: Apache-2.0
/**
 * Adding files beyond the first to a paged Work, walked in a browser: a multi-pick joins
 * several in the picked order, a reorder is whole-list, and a removal renumbers — and the
 * set the server then holds equals what the page showed.
 *
 * 🚨 **The walk is the honest answer to "could a creator load their comic this way?"** A
 * comic's pages are JPG or PNG images (Parker, 2026-10-19), joined as many picks or one
 * multi-pick; what this proves is the multi-pick, which is the one path whose ordering
 * claim ("attached in the order the picker handed them") is only visible in a browser: the
 * input's FileList order, the sequential uploads, the appended positions and a re-render
 * per file are all real there.
 *
 * Runs in the `authed` project on `media_fixture`, serial with the other walks it shares
 * the sweep shape with.
 */

import { db } from "@anthers/db/client";
import { workSourceFiles, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE = `Page set walk ${Date.now()}`;

/** A real 1×1 PNG — small but honest: the row's mime is what the pipeline would branch on. */
function stubImage(name: string): { name: string; mimeType: string; buffer: Buffer } {
	return {
		name,
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		),
	};
}

test.afterAll(async () => {
	const [row] = await db.select({ id: works.id }).from(works).where(eq(works.title, TITLE));
	if (row) {
		await fetch(`${API_URL}/api/content/works/${row.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: session ? `session=${session}` : "", Origin: WEB_ORIGIN },
		});
	}
});

let session = "";

test("a comic's set grows by a multi-pick, reorders and removes", async ({ page, context }) => {
	page.on("console", (msg) => console.log("[browser]", msg.text()));
	session = await signInAsMediaFixture(context);

	// A comic made the ordinary way: type, pick of the first file.
	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("comic");
	await page.getByPlaceholder("Work title").fill(TITLE);
	await page.locator('input[type="file"]').setInputFiles(stubImage("lead page.png"));
	// The Work's own page is the landing for every kind now (the kinds pass,
	// 2026-10-14); the set editor lives in its Manage tab.
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	await page.getByRole("tab", { name: /Manage/ }).click();
	await expect(page.getByText(/lead page,?$/)).toBeVisible({ timeout: 30_000 });

	// The set gains two files in one browse — attached in the picked order.
	await page
		.locator('input[type="file"][multiple]')
		.setInputFiles([stubImage("chapter two page.png"), stubImage("chapter three page.png")]);
	await expect(page.getByText(/chapter two page,?$/)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/chapter three page,?$/)).toBeVisible({ timeout: 30_000 });

	// The arrangement is the page's own: move the third file to the top (two moves), and
	// the visible list follows — strict, not a number that the un-reordered list also passes.
	const upThree = page.getByRole("button", { name: /move chapter three page earlier/i });
	await upThree.click();
	await expect(page.getByText(/chapter three page,?$/)).toBeVisible();
	await upThree.click();
	const firstNumber = page.locator("span.font-mono").first();
	await expect(firstNumber.filter({ hasText: "1" })).toBeVisible();
	const firstRow = page.locator("span.flex-1.truncate").first();
	await expect(firstRow).toHaveText("chapter three page");

	await page.getByRole("button", { name: /remove chapter two page/i }).click();
	await expect(page.getByText(/chapter two page$/)).toHaveCount(0);

	// A page image joins the same way — the leaf path is the lead story, not the exotic one.
	await page.locator('input[type="file"][multiple]').setInputFiles([stubImage("leaf page.png")]);
	await expect(page.getByText(/leaf page,?$/)).toBeVisible({ timeout: 30_000 });

	// The server's set equals what the page showed — order and mime included.
	const [row] = await db.select({ id: works.id }).from(works).where(eq(works.title, TITLE));
	const set = await db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, row.id));
	console.log(
		"[pageset] final set:",
		set.map((f) => ({
			pos: f.position,
			id: f.id,
			file: f.file,
			name: f.filename,
			mime: f.mimeType,
		})),
	);
	// Ordering is the column's whole job; this is the assertion the list alone cannot make.
	expect(set.map((f) => f.filename)).toEqual([
		"chapter three page.png",
		"lead page.png",
		"leaf page.png",
	]);
	// The leaf's mime lands as the leaf itself declared it, not a defaulted PDF.
	expect(set[2]?.mimeType).toBe("image/png");
});
