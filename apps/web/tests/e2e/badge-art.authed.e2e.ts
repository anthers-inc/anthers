// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A creator puts art on a Badge rung, in a real browser.
 *
 * ⭐ **The ladder editor is where the format decision becomes visible or does not.** Every
 * badge shares one round botanical frame and the creator's art is its interior, so the
 * thing worth seeing is a rung whose mark reads as *the same kind of object* as Anthers'
 * Root/Sprout/Petal/Blossom. No API test can tell you whether it does.
 *
 * ⚠️ **A rung with no art still has to have a mark.** The default is drawn client-side from
 * `@anthers/brand`, so a creator who has uploaded nothing sees a botanical interior rather
 * than an empty circle — and the ladder does not change shape when a file lands.
 */
import { deflateSync } from "node:zlib";
import { db } from "@anthers/db/client";
import { creatorGates } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsCreator, test, trackErrorsStrict, WEB_ORIGIN } from "./fixtures";

const RUN = Date.now().toString(36);
const LABEL = `E2E rung ${RUN}`;
let gateId = 0;
let token = "";

/**
 * A structured PNG, built here rather than checked in.
 *
 * 🚨 **Structured rather than flat, because PDQ refuses a featureless image.** A solid
 * rectangle scores below `MIN_PDQ_QUALITY` and is answered `unscannable` without the vendor
 * being asked — fine for the platform, useless as a fixture for a path whose whole point is
 * that the scan runs.
 *
 * ⚠️ **PNG rather than BMP.** sharp does not decode BMP, so the server refuses one as "not
 * an image we can read" — correctly, and confusingly if the fixture is the reason.
 */
function artwork(): Buffer {
	const [w, h] = [64, 64];
	// Raw scanlines, each prefixed with a zero filter byte, then deflated: that is the
	// whole of a PNG's IDAT.
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
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
		// 🚨 zlib-wrapped, not raw deflate. `Bun.deflateSync` emits RAW deflate, which
		// produces a PNG whose header and CRCs are perfect and whose pixels will not
		// decode — and `sharp().metadata()` reads it happily, because metadata never
		// touches IDAT. The only thing that catches it is decoding, which is what the
		// server does: "pngload_buffer: IDAT stream error".
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

test.afterAll(async () => {
	if (gateId) await db.delete(creatorGates).where(eq(creatorGates.id, gateId));
});

test("a creator gives a rung its own art, and a rung without one still shows a badge", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	token = await signInAsCreator(context);

	// A rung of our own, so the walk never depends on what the gauntlet fixture happens
	// to have and never edits a rung another spec is asserting on.
	const created = await fetch(`${API_URL}/api/subscriptions/gates`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({ threshold: "5.00", label: LABEL }),
	});
	expect(created.status, "could not create the fixture rung").toBe(201);
	gateId = ((await created.json()) as { gate: { id: number } }).gate.id;

	await page.goto(`${WEB_ORIGIN}/studio/settings`);

	// ⚠️ Scoped by the CONTROL rather than by a div containing the label. `locator("div")`
	// filtered on text and taken `.last()` returns the innermost matching div, which here
	// is the one wrapping the label alone — it never contains the mark, and the failure
	// reads as "the feature is missing" when the feature is fine.
	const markButton = page.getByRole("button", { name: `${LABEL} badge` });
	await expect(markButton).toBeVisible();
	const control = page.locator("div").filter({ has: markButton }).last();

	// The default first: a rung with no art of its own is still a badge, not a hole.
	await expect(control.getByRole("img", { name: `${LABEL} badge` })).toBeVisible();

	const ladder = page.locator("div").filter({ hasText: "Badge Ladder" }).last();
	await ladder.screenshot({ path: `.screenshots/badge-ladder-default-${RUN}.png` });

	// The library first — three choices, no file picker. This is the path a creator who
	// does not draw actually takes, so it is the one worth walking.
	await markButton.click();

	// ⚠️ One choice at a time, waiting for each to land. Saving refetches the ladder, which
	// re-renders the row and detaches the button mid-click — clicking the next swatch
	// straight away fails with "element was detached", which reads like a broken picker and
	// is a test that did not wait.
	for (const choice of ["Hexagon", "Amber"]) {
		await control.getByRole("button", { name: choice }).click();
		// 🚨 The picker must still be open for the NEXT choice. Saving refetches the ladder,
		// and while that refetch blanked the list for "Loading…" every rung unmounted and
		// the picker closed — so mixing and matching meant reopening it three times.
		await expect(control.getByRole("button", { name: choice })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	}
	await ladder.screenshot({ path: `.screenshots/badge-ladder-library-${RUN}.png` });

	// Then the creator's own art, through the file input the picker opens.
	await control.locator('input[type="file"]').setInputFiles({
		name: "badge.png",
		mimeType: "image/png",
		buffer: artwork(),
	});

	// The mark becomes an <img> pointed at the access-checked route — which is the whole
	// visible difference, and the only way to see that the upload round-tripped.
	await expect(control.locator(`img[src$="/api/subscriptions/gates/${gateId}/art"]`)).toBeVisible({
		timeout: 15_000,
	});

	await ladder.screenshot({ path: `.screenshots/badge-ladder-art-${RUN}.png` });

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
