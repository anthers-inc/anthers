// SPDX-License-Identifier: Apache-2.0
/**
 * Adding files beyond the first to a paged Work, walked in a browser: a multi-pick joins
 * several in the picked order, a reorder is whole-list, and a removal renumbers — and the
 * set the server then holds equals what the page showed.
 *
 * 🚨 **The walk is the honest answer to "could a creator load their book this way?"** The
 * per-page export shape (one PDF per page, a comic production pipeline's actual output) is
 * joined as many picks or one multi-pick; what this proves is the multi-pick, which is the
 * one path whose ordering claim ("attached in the order the picker handed them") is only
 * visible in a browser: the input's FileList order, the sequential uploads, the appended
 * positions and a re-render per file are all real there.
 *
 * Runs in the `authed` project on `media_fixture`, serial with the other walks it shares
 * the sweep shape with.
 */

import { db } from "@anthers/db/client";
import { workSourceFiles, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE = `Page set walk ${Date.now()}`;

/** A minimal, readable PDF — pages are never rendered here (no worker), only rows stored. */
function stubPdf(name: string): { name: string; mimeType: string; buffer: Buffer } {
	return {
		name,
		mimeType: "application/pdf",
		buffer: Buffer.from(
			"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
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
	await page.locator('input[type="file"]').setInputFiles(stubPdf("lead page.pdf"));
	await expect(page).toHaveURL(/\/studio\/works\/\d+\/edit$/, { timeout: 15_000 });
	await expect(page.getByText(/lead page,?$/)).toBeVisible({ timeout: 30_000 });

	// The set gains two files in one browse — attached in the picked order.
	await page
		.locator('input[type="file"][multiple]')
		.setInputFiles([stubPdf("chapter two page.pdf"), stubPdf("chapter three page.pdf")]);
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

	// The server's set equals what the page showed — order included.
	const [row] = await db.select({ id: works.id }).from(works).where(eq(works.title, TITLE));
	const set = await db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, row.id));
	console.log(
		"[pageset] final set:",
		set.map((f) => ({ pos: f.position, id: f.id, file: f.file, name: f.filename })),
	);
	// Ordering is the column's whole job; this is the assertion the list alone cannot make.
	expect(set.map((f) => f.filename)).toEqual(["chapter three page.pdf", "lead page.pdf"]);
});
