// SPDX-License-Identifier: Apache-2.0
/**
 * The post editor's image button and paragraph handling, walked in a browser.
 *
 * 🚨 **The button once posted the picked file's FormData straight at
 * `/api/content/inline-images` — a route that takes JSON with an already-uploaded URL —
 * so the picker opened, the request failed in the route's own parse, and a creator whose
 * image arrived saw nothing inserted and nothing on the page, the failure sitting in the
 * console** (Parker, 2026-10-09). What this walk catches is exactly that shape: a picked
 * file must end as an image in the editor and as markdown in the stored body, whatever
 * each step of the two-step upload does. It also catches the blank line a creator draws
 * by pressing return twice, which the write boundary has to keep, and it fails if a
 * refused upload stays in the console — the oversized case's message must be on the page.
 */
import { deflateSync } from "node:zlib";
import { db } from "@anthers/db/client";
import { inlineImages, posts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsCreator, test, trackErrorsStrict, WEB_ORIGIN } from "./fixtures";

const RUN = Date.now().toString(36);

let token = "";
const createdSlugs: string[] = [];
const inlineImageIds: number[] = [];

/**
 * A structured PNG, built here rather than checked in.
 *
 * Structured rather than flat because the upload is scanned in the request path, and a
 * solid rectangle scores below the scan's quality floor — fine for the platform, useless
 * as a fixture for a path whose whole point is that the scan runs. The shape is
 * `badge-art`'s, which records the traps (zlib-wrapped IDAT; no BMP).
 */
function artwork(): Buffer {
	const [w, h] = [64, 64];
	const raw = Buffer.alloc(h * (1 + w * 3));
	for (let y = 0; y < h; y++) {
		const row = y * (1 + w * 3);
		raw[row] = 0;
		for (let x = 0; x < w; x++) {
			const i = row + 1 + x * 3;
			raw[i] = (x * 7 + y * 13) % 256;
			raw[i + 1] = (x * x + y * 3) % 256;
			raw[i + 2] = (x ^ y) % 256;
		}
	}
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 0;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolor
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

test.afterAll(async () => {
	for (const id of inlineImageIds) {
		await db.delete(inlineImages).where(eq(inlineImages.id, id));
	}
	for (const slug of createdSlugs) {
		await db.delete(posts).where(eq(posts.slug, slug));
	}
});

test("a picked file becomes an image in the editor and a gap a return drew survives storage", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	token = await signInAsCreator(context);
	const title = `Editor walk ${RUN}`;

	await page.goto("/studio/posts/new");
	await page.getByPlaceholder("Post title").fill(title);
	await page.locator(".tiptap").click();
	await page.keyboard.type("Line one");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.type("Line two");

	// The button's own flow: upload, register, insert. Both steps answer 2xx before the
	// image is on the page — a response for the registration step is captured for cleanup.
	const chooserPromise = page.waitForEvent("filechooser");
	const registered = page.waitForEvent("response", (res) =>
		res.url().includes("/api/content/inline-images"),
	);
	await page.getByRole("button", { name: "Insert image" }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles([{ name: "art.png", mimeType: "image/png", buffer: artwork() }]);
	const registration = await registered;
	const inserted = (await registration.json()) as { inlineImage: { id: number } };
	inlineImageIds.push(inserted.inlineImage.id);

	const image = page.locator(".tiptap img");
	await expect(image).toBeVisible();
	await expect(image).toHaveAttribute("src", /\//);

	// Save as a draft, then read what was stored through the API the editor writes to.
	page.getByRole("button", { name: "Save as Draft" }).click();
	await page.waitForURL(/\/studio\/posts\/.*\/edit/);
	const slug = page.url().split("/").at(-2);
	createdSlugs.push(slug);

	const read = await fetch(`${API_URL}/api/content/posts/${slug}`, {
		headers: { Cookie: `session=${token}`, Origin: WEB_ORIGIN },
	});
	const stored = (await read.json()) as { post: { body: string } };
	// The blank paragraph is the stored spelling of the double return, and the image is
	// the markdown the editor's HTML became.
	expect(stored.post.body).toContain("Line one\n\n\u00A0\n\nLine two");
	expect(stored.post.body).toMatch(/!\[\]\(\S+\)/);

	// On the reading side the paragraphs sit flush — the margins the post styling adds
	// between them are gone, and the stored blank line renders with real height.
	await page.goto(`/posts/${slug}-${(stored.post as { publicId: number }).publicId}`);
	const rendered = page.locator("article .prose");
	await expect(rendered.locator("p").first()).toBeVisible();
	const margins = await rendered
		.locator("p")
		.evaluateAll((paragraphs) =>
			paragraphs.map((p) => `${getComputedStyle(p).marginTop}/${getComputedStyle(p).marginBottom}`),
		);
	for (const margin of margins) expect(margin).toBe("0px/0px");
	const blank = rendered.locator("p").filter({ hasText: /^\s*$/ }).first();
	await expect(blank).toBeVisible();
	const gap = (await blank.boundingBox())?.height ?? 0;
	expect(gap).toBeGreaterThan(0);

	expect(errors).toEqual([]);
});

test("an oversized image says so in the editor rather than failing silently", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	await signInAsCreator(context);
	await page.goto("/studio/posts/new");

	// Over the ceiling the endpoint holds, and rejected in the editor before any request
	// leaves the page — so no response to wait for, only the message.
	const chooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Insert image" }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles([
		{ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
	]);
	await expect(page.getByText("That image is larger than 10 MB.")).toBeVisible();
	await expect(page.locator(".tiptap img")).toHaveCount(0);

	expect(errors).toEqual([]);
});
