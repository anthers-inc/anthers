// SPDX-License-Identifier: Apache-2.0
/**
 * A Project can wear one of its Works' thumbnails, chosen from the Project's own page.
 *
 * The API suite owns the rules — the reference follow-through, the fallback, the visibility
 * gates. This walk proves the editor's half: "Choose from Work" opens the picker, a Work
 * with a thumbnail is a choice, and the act puts that thumbnail on the page and says where it came
 * from, without an upload in between.
 *
 * Runs on `media_fixture`, which carries payout setup and a shared catalog; everything this
 * walk makes is deleted by it, and every title is prefixed so the gauntlet's own rows are
 * never mistaken for its own.
 */

import { gauntletHandle } from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const run = Date.now();
const SLUG = `pc-work-${run}`;
const WORK_TITLE = `Project thumbnail walk ${run}`;
const PROJECT_TITLE = `Project thumbnail walk project ${run}`;

/** A 1×1 PNG, so the direct-upload door sees a real image. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

let session = "";
let handle = "";
let workId = 0;

const authed = async () => ({
	"Content-Type": "application/json",
	Origin: WEB_ORIGIN,
	Cookie: `session=${session}`,
});

test.afterAll(async () => {
	if (!session) return;
	await fetch(`${API_URL}/api/content/projects/${SLUG}`, {
		method: "DELETE",
		headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
	});
	if (workId) {
		await fetch(`${API_URL}/api/content/works/${workId}`, {
			method: "DELETE",
			headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
		});
	}
});

test("a creator chooses a Works thumbnail for the Project from the Project page", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);

	// The Work and its thumbnail: a draft text Work with an uploaded image, since a text Work
	// carries a chosen thumbnail and the list does not require release.
	const made = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: await authed(),
		body: JSON.stringify({ type: "text", title: WORK_TITLE, bodyHtml: "<p>thumbnail walk</p>" }),
	});
	expect(made.status).toBe(201);
	workId = ((await made.json()) as { work: { id: number } }).work.id;

	const upload = new FormData();
	upload.append("file", new Blob([PNG], { type: "image/png" }), "thumbnail.png");
	upload.append("mediaType", "thumbnail");
	const uploaded = await fetch(`${API_URL}/api/content/media-upload/direct`, {
		method: "POST",
		headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
		body: upload,
	});
	expect(uploaded.status, await uploaded.clone().text()).toBe(201);
	const { url: thumbUrl } = (await uploaded.json()) as { url: string };

	const thumbed = await fetch(`${API_URL}/api/content/works/${workId}`, {
		method: "PATCH",
		headers: await authed(),
		body: JSON.stringify({ thumbnail: thumbUrl }),
	});
	expect(thumbed.ok, await thumbed.clone().text()).toBe(true);

	const project = await fetch(`${API_URL}/api/content/projects`, {
		method: "POST",
		headers: await authed(),
		body: JSON.stringify({ title: PROJECT_TITLE, slug: SLUG, isPublished: false }),
	});
	expect(project.status).toBe(201);
	const list = await fetch(`${API_URL}/api/content/projects/${SLUG}/works`, {
		method: "POST",
		headers: await authed(),
		body: JSON.stringify({ workId }),
	});
	expect(list.status).toBe(201);

	// The creator's handle, for the public URL the editor lives on.
	handle = await gauntletHandle(API_URL, MEDIA_FIXTURE_USERNAME);

	await page.goto(`/@${handle}/${SLUG}`);
	await page.getByRole("button", { name: "Edit Thumbnail" }).click();
	await page.getByRole("button", { name: "Choose from Work" }).click();
	const picker = page.getByRole("dialog", { name: "Thumbnail from a Work" });
	await expect(picker).toBeVisible();
	const tile = picker.getByRole("button", { name: WORK_TITLE });
	await expect(tile).toBeVisible();

	// The tile is the Work, and choosing it is the save.
	await tile.click();
	await expect(page.getByRole("dialog", { name: "Thumbnail from a Work" })).toHaveCount(0);
	await expect(page.getByText(`Using the thumbnail from ${WORK_TITLE}.`)).toBeVisible();
	await expect(page.locator(`img[alt="${PROJECT_TITLE}"]`)).toHaveAttribute("src", thumbUrl);

	// The row says the same: a reference to this Work, and the resolved thumbnail.
	const row = await fetch(`${API_URL}/api/content/projects/${SLUG}`, {
		headers: { Cookie: `session=${session}` },
	});
	expect(row.status).toBe(200);
	const { project: saved } = (await row.json()) as {
		project: { thumbnailWorkId: number | null; thumbnail: string | null };
	};
	expect(saved.thumbnailWorkId).toBe(workId);
	expect(saved.thumbnail).toBe(thumbUrl);
});
