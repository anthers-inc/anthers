// SPDX-License-Identifier: Apache-2.0
/**
 * The image Work's own description — authored beside the picture in the Studio and
 * announced on the Work page.
 *
 * 🚨 **What this walk pins is the reader side of the pipe.** An image Work's picture is
 * its whole deliverable, so the alt text the creator writes in the Studio is the only
 * sentence a screen reader gets for it; the API's gated-blanks cases live under the
 * delivery-access suite (it blanks a locked image's description beside the picture),
 * and this walk proves the two ends a green API test cannot see: the field on the Edit
 * page saves, and the Work page renders what was saved as the picture's accessible
 * name (`getByRole("img", …)` reads the alt, which is exactly what the screen reader
 * reads). The picture itself is attached at the row level — a nonsense storage key —
 * because whether the bytes load is another subject; the attribute rides the element
 * either way.
 */
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	API_URL,
	expect,
	signInAsMediaFixture,
	test,
	trackErrorsStrict,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE = `Alt-text walk ${Date.now()}`;
/** Empty at the title-fallback branch, so the description is what is announced. */
const DESCRIPTION = "A walk photo, described by its creator";
let session = "";

let walked: { id: number; publicId: number; slug: string } | null = null;

test.afterAll(async () => {
	if (!session || !walked) return;
	await fetch(`${API_URL}/api/content/works/${walked.id}?force=1`, {
		method: "DELETE",
		headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
	});
});

test("an image Work's description is authored in the Studio and announced by the picture", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	session = await signInAsMediaFixture(context);

	// Draft an image Work the way the draft walk does — a kind and a name, no file —
	// so this stays a walk about description, not about uploads.
	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("image");
	await page.getByPlaceholder("Work title").fill(TITLE);
	await page.getByRole("button", { name: /skip for now/i }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	// The alt text is the Accessibility tab's field (the kinds pass, 2026-10-14), edited
	// where a screen reader meets the picture — before the picture exists as much as after.
	await page.getByRole("tab", { name: "Accessibility" }).click();
	await page.getByRole("button", { name: "Edit Alt text" }).click();
	const field = page.getByRole("textbox", { name: "Alt text" });
	await expect(field).toBeVisible();
	await field.fill(DESCRIPTION);
	await page.getByRole("button", { name: "Save Alt text" }).click();
	// The save is the field's own; the read answers it.
	await expect(page.getByText(DESCRIPTION)).toBeVisible({ timeout: 15_000 });

	// What the save actually stored, from the API the page saves through — the owner
	// shape, which is the shape the Studio would reload on the next visit.
	const owned = (await (
		await fetch(`${API_URL}/api/content/works`, { headers: { Cookie: `session=${session}` } })
	).json()) as { works: { id: number; title: string }[] };
	const [row] = owned.works.filter((w) => w.title === TITLE);
	expect(row, "the walk's image Work stands after the save").toBeTruthy();
	const detail = (await (
		await fetch(`${API_URL}/api/content/works/${row.id}`, {
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		})
	).json()) as {
		work: { imageAlt?: string; publicId: number; slug: string; id: number; creatorId?: number };
	};
	expect(detail.work.imageAlt).toBe(DESCRIPTION);
	walked = { id: detail.work.id, publicId: detail.work.publicId, slug: detail.work.slug };

	// Give the picture its place on the row, so the render the user saw exists at all.
	// The key is written in the owner's own prefix shape, though nothing here reads it.
	await db
		.update(works)
		.set({
			sourceKey: `creators/${detail.work.creatorId}/gallery/alt-text-walk.png`,
			thumbnail: `creators/${detail.work.creatorId}/gallery/alt-text-walk.png`,
		})
		.where(eq(works.id, detail.work.id));

	// The reader's end: the picture announces what the creator wrote, not the title.
	await page.goto(`/works/${detail.work.slug}-${detail.work.publicId}`);
	const picture = page.getByRole("img", { name: DESCRIPTION });
	await expect(picture).toBeVisible();
	await expect(picture).toHaveAttribute("alt", DESCRIPTION);

	expect(errors).toEqual([]);
});
