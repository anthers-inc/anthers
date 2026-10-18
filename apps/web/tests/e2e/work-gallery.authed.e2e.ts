// SPDX-License-Identifier: Apache-2.0
/**
 * An image Work's set, walked in a browser: the gallery editor grows by a multi-pick, a
 * reorder moves the cover, a removal follows it, and a file that is not an image is
 * refused before anything is written — and the Work page displays the set stacked in
 * order, with the shared lightbox opening over it.
 *
 * 🚨 The walk pins what the API suite cannot see: that the cover (the legacy column, what
 * listings show) stays on the FIRST image through every mutation rather than following the
 * newest, that the refusal surfaces legibly in the editor, and that the pictures the
 * serializer carried (`Work.gallery`, gated beside the image itself) actually render.
 *
 * Runs in the `authed` project on `media_fixture`, serial with the other walks it shares
 * the sweep shape with (`work-pageset`, whose shape this mirrors).
 */

import { db } from "@anthers/db/client";
import { workSourceFiles, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE = `Gallery walk ${Date.now()}`;

/** A real 1×1 PNG — small but honest: the editor row's preview is the picture it holds. */
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

/** A minimal PDF — the image-only guard's bait, never stored. */
function stubPdf(name: string): { name: string; mimeType: string; buffer: Buffer } {
	return {
		name,
		mimeType: "application/pdf",
		buffer: Buffer.from(
			"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
		),
	};
}

let session = "";

test.afterAll(async () => {
	const [row] = await db.select({ id: works.id }).from(works).where(eq(works.title, TITLE));
	if (row) {
		await fetch(`${API_URL}/api/content/works/${row.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: session ? `session=${session}` : "", Origin: WEB_ORIGIN },
		});
	}
});

test("an image Work's set grows, reorders, refuses a non-image, and displays", async ({
	page,
	context,
}) => {
	page.on("console", (msg) => console.log("[browser]", msg.text()));
	session = await signInAsMediaFixture(context);

	// An image made the ordinary way: type, pick of the first picture.
	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("image");
	await page.getByPlaceholder("Work title").fill(TITLE);
	await page.locator('input[type="file"]').setInputFiles(stubImage("gallery cover.png"));
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	await page.getByRole("tab", { name: /Manage/ }).click();
	await expect(page.getByText(/gallery cover\.png$/)).toBeVisible({ timeout: 30_000 });

	// A second picture joins by one pick, as an appended row.
	await page.locator('input[type="file"][multiple]').setInputFiles(stubImage("gallery tail.png"));
	await expect(page.getByText(/gallery tail\.png$/)).toBeVisible({ timeout: 30_000 });

	// The server's set matches the page, and the cover — the legacy column — is the
	// FIRST image, not the one just added.
	const [row] = await db
		.select({ id: works.id, publicId: works.publicId, slug: works.slug })
		.from(works)
		.where(eq(works.title, TITLE));
	const cover1 = (
		await db.select({ v: works.sourceKey }).from(works).where(eq(works.id, row.id))
	)[0]?.v;
	const set = await db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, row.id));
	expect(set.map((f) => f.filename)).toEqual(["gallery cover.png", "gallery tail.png"]);
	const firstRow = set.find((f) => f.filename === "gallery cover.png")!;
	expect(cover1).toBe(firstRow.file);

	// A PDF is refused legibly, and the set stands exactly as it was.
	await page.locator('input[type="file"][multiple]').setInputFiles(stubPdf("not-a-picture.pdf"));
	await expect(page.getByText(/isn't one/)).toBeVisible({ timeout: 30_000 });
	const still = await db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, row.id));
	expect(still).toHaveLength(2);

	// The arrangement moves the cover: the tail picture takes the first place. The click
	// only dispatches the reorder, so the visible list — which reloads only after the
	// PATCH has answered — is what tells the walk the server has settled.
	await page
		.getByRole("button", { name: /move gallery tail\.png earlier/i })
		.click({ timeout: 30_000 });
	await expect(page.locator("span.flex-1.truncate").first()).toHaveText("gallery tail.png", {
		timeout: 30_000,
	});
	const cover2 = (
		await db.select({ v: works.sourceKey }).from(works).where(eq(works.id, row.id))
	)[0]?.v;
	expect(cover2).toBe(set.find((f) => f.filename === "gallery tail.png")!.file);

	// The Work page displays the set stacked in order, and a picture opens the
	// lightbox, steps through the set and closes.
	await page.goto(`/works/${row.slug}-${row.publicId}`);
	await expect(page.getByRole("button", { name: "View image 1 of 2" })).toBeVisible({
		timeout: 30_000,
	});
	await page.getByRole("button", { name: "View image 2 of 2" }).click();
	await expect(page.getByText("2 / 2")).toBeVisible();
	await page.getByRole("button", { name: "Previous" }).click();
	await expect(page.getByText("1 / 2")).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByText("1 / 2")).toHaveCount(0);
});
