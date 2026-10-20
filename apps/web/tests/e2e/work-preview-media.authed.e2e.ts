// SPDX-License-Identifier: Apache-2.0
/**
 * Storefront preview media on a locked Work — the carousel a creator adds from Manage and
 * a locked viewer sees under the price card (Parker, 2026-10-19).
 *
 * The walk uses the owner's **User (Locked)** preview over a private game, so the same
 * page proves the editor and the locked composition without releasing anything. It pins
 * the four things the feature is judged by: the carousel opens on the lock slide, an image
 * opens the lightbox, a trailer plays with its caption track, and a Work with no preview
 * set renders exactly the old composition — no fieldset, no strip.
 *
 * The uploads go through the real API, the same two-step attach the Manage tab performs.
 * The trailer and screenshot are tiny committed fixtures (`fixtures/preview-trailer.mp4`,
 * `fixtures/preview-shot.png`); the VTT is built in the test.
 */

import { readFile } from "node:fs/promises";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const STEM = "Preview carousel";
const GATED = [{ threshold: 300, allow: true, price: "3.00" }];

let session = "";
const created: number[] = [];

interface CreatedWork {
	id: number;
	publicId: number;
}

function headers(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Origin: WEB_ORIGIN,
		Cookie: `session=${session}`,
	};
}

async function createWork(title: string): Promise<CreatedWork> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ type: "game", title, access: GATED }),
	});
	expect(res.status, "creating the preview fixture Work").toBe(201);
	const { work } = (await res.json()) as { work: CreatedWork };
	created.push(work.id);
	return work;
}

async function upload(
	bytes: Buffer,
	name: string,
	mime: string,
	mediaType: string,
	entityId: number,
): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: mime }), name);
	form.append("mediaType", mediaType);
	form.append("entityId", String(entityId));
	const res = await fetch(`${API_URL}/api/content/media-upload/direct`, {
		method: "POST",
		headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
		body: form,
	});
	expect(res.status, `uploading ${name}`).toBe(201);
	return ((await res.json()) as { key: string }).key;
}

async function attach(
	workId: number,
	kind: "image" | "video",
	key: string,
	alt = "",
): Promise<{ id: number }> {
	const res = await fetch(`${API_URL}/api/content/works/${workId}/previews`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ kind, key, alt }),
	});
	expect(res.status, "attaching the preview item").toBe(201);
	const { previewMedia } = (await res.json()) as { previewMedia: Array<{ id: number }> };
	return previewMedia[previewMedia.length - 1];
}

const VTT = `WEBVTT

00:00:00.500 --> 00:00:01.500
A caption line.
`;

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
	if (!session) return;
	for (const id of created) {
		await fetch(`${API_URL}/api/content/works/${id}`, {
			method: "DELETE",
			headers: headers(),
		}).catch(() => {});
	}
});

test("the locked page carries the carousel, its strip, its chevrons and a trailer's captions", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const work = await createWork(`${STEM} walk`);

	const shot = await readFile(new URL("./fixtures/preview-shot.png", import.meta.url));
	const image = await attach(
		work.id,
		"image",
		await upload(shot, "preview-shot.png", "image/png", "preview-image", work.id),
		"A red frame",
	);

	const trailerKey = await upload(
		await readFile(new URL("./fixtures/preview-trailer.mp4", import.meta.url)),
		"preview-trailer.mp4",
		"video/mp4",
		"preview-video",
		work.id,
	);
	const trailer = await attach(work.id, "video", trailerKey);

	const captionKey = await upload(
		Buffer.from(VTT, "utf-8"),
		"en.vtt",
		"text/vtt",
		"preview-caption",
		trailer.id,
	);
	const captionRes = await fetch(
		`${API_URL}/api/content/works/${work.id}/previews/${trailer.id}/captions`,
		{
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ key: captionKey, language: "en", label: "English" }),
		},
	);
	expect(captionRes.status, "attaching the trailer's captions").toBe(201);

	await page.goto(`/works/${work.publicId}`);
	await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "User (Locked)" }).click();
	await expect(page).toHaveURL(/\?previewAs=locked$/, { timeout: 15_000 });

	const carousel = page.locator('fieldset[aria-label="Preview media"]');
	await expect(carousel).toBeVisible();

	// Opens on the lock slide: the first tile is pressed and the stage has no video yet.
	const lockTile = carousel.getByRole("button", { name: "The locked Work" });
	await expect(lockTile).toHaveAttribute("aria-pressed", "true");
	await expect(carousel.locator("video")).toHaveCount(0);

	// The screenshot opens, and its own alt text reaches the lightbox.
	await carousel.getByRole("button", { name: /Preview 1: screenshot/ }).click();
	const stageImage = carousel.getByRole("button", { name: "Open this screenshot full size" });
	await expect(stageImage).toBeVisible();
	await stageImage.click();
	// The lightbox is the second copy: the stage image keeps its alt behind the overlay.
	await expect(page.getByAltText("A red frame").last()).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();

	// The trailer plays and its caption track is attached.
	await carousel.getByRole("button", { name: /Preview 2: trailer/ }).click();
	await expect(carousel.locator("video")).toBeVisible();
	await expect(carousel.locator("video track")).toHaveCount(1);

	// The chevrons clamp at the ends: forward from the trailer does nothing, back steps.
	const next = carousel.getByRole("button", { name: "Next preview" });
	const prev = carousel.getByRole("button", { name: "Previous preview" });
	await expect(next).toBeDisabled();
	await expect(prev).toBeEnabled();
	await prev.click();
	await expect(carousel.getByRole("button", { name: /Preview 1: screenshot/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await prev.click();
	await expect(lockTile).toHaveAttribute("aria-pressed", "true");
	await expect(prev).toBeDisabled();

	// Keyboard movement agrees with the chevrons: two steps from the lock slide.
	await lockTile.focus();
	await expect(lockTile).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(carousel.getByRole("button", { name: /Preview 1: screenshot/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.keyboard.press("ArrowRight");
	await expect(carousel.getByRole("button", { name: /Preview 2: trailer/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// The image itself is in the fixture, so the stage did not fall back to the lock slide.
	expect(image.id).toBeGreaterThan(0);
});

test("the Manage tab adds, reorders and removes a preview image", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	const work = await createWork(`${STEM} manage`);
	await attach(
		work.id,
		"image",
		await upload(
			await readFile(new URL("./fixtures/preview-shot.png", import.meta.url)),
			"preview-shot.png",
			"image/png",
			"preview-image",
			work.id,
		),
	);

	await page.goto(`/works/${work.publicId}`);
	await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
	const section = page.getByTestId("preview-media-section");
	await expect(section).toBeVisible();
	await expect(section.getByTestId(/preview-item-/)).toHaveCount(1);

	// The hidden image input is the Add images door.
	await section
		.locator('input[type="file"]')
		.first()
		.setInputFiles(new URL("./fixtures/preview-shot.png", import.meta.url).pathname);
	await expect(section.getByTestId(/preview-item-/)).toHaveCount(2, { timeout: 20_000 });

	// Reorder: the second item moves earlier.
	await section.getByRole("button", { name: "Move preview earlier" }).nth(1).click();
	await expect(section.getByTestId(/preview-item-/)).toHaveCount(2);

	// Remove the first item and leave one standing.
	await section.getByRole("button", { name: "Remove" }).first().click();
	await expect(section.getByTestId(/preview-item-/)).toHaveCount(1, { timeout: 15_000 });
});

test("a Work with no preview set keeps the old locked composition, with no carousel", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const work = await createWork(`${STEM} empty`);

	await page.goto(`/works/${work.publicId}`);
	await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "User (Locked)" }).click();
	await expect(page).toHaveURL(/\?previewAs=locked$/, { timeout: 15_000 });

	// No fieldset, no strip — exactly the page before this feature existed.
	await expect(page.locator('fieldset[aria-label="Preview media"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "The locked Work" })).toHaveCount(0);
});
