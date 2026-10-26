// SPDX-License-Identifier: Apache-2.0
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
import { GAUNTLET_CREATOR_USERNAME, gauntletHandle } from "@anthers/db/gauntlet";
import { badges } from "@anthers/db/schema";
import { profileUrl } from "@anthers/web-shared/profile";
import { eq } from "drizzle-orm";
import {
	API_URL,
	expect,
	signInAsCreator,
	signInAsWalker,
	test,
	trackErrorsStrict,
	WEB_ORIGIN,
} from "./fixtures";

const RUN = Date.now().toString(36);
const LABEL = `E2E rung ${RUN}`;
let badgeId = 0;
let pickBadgeId = 0;
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
	if (badgeId) await db.delete(badges).where(eq(badges.id, badgeId));
	if (pickBadgeId) await db.delete(badges).where(eq(badges.id, pickBadgeId));
});

test("a creator gives a rung its own art, and a rung without one still shows a badge", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	token = await signInAsCreator(context);

	// The vendor is not in a test session, so the search gets one known result whose
	// thumbnail is a data URL. That is enough to see the thing the picker got wrong: an
	// unselected icon must be a contrasting mark on the page, not white on white.
	const thumb = `data:image/svg+xml;utf8,${encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>',
	)}`;
	await page.route("**/api/noun/search**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				icons: [
					{
						id: "e2e-bee",
						term: "bee",
						thumbnailUrl: thumb,
						artistName: "Test Artist",
						artistPermalink: null,
						licenseDescription: "public-domain",
						attribution: "bee by Test Artist",
					},
				],
				nextPage: null,
			}),
		}),
	);

	// A rung of our own, so the walk never depends on what the gauntlet fixture happens
	// to have and never edits a rung another spec is asserting on.
	const created = await fetch(`${API_URL}/api/subscriptions/badges`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({ threshold: "5.00", label: LABEL }),
	});
	expect(created.status, "could not create the fixture rung").toBe(201);
	badgeId = ((await created.json()) as { badge: { id: number } }).badge.id;

	// The creator meets the same grid a supporter does, with a pencil on each card. The
	// maker is what that pencil opens — one Badge at a time, in a dialog.
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=badges`);
	const editButton = page.getByRole("button", { name: `Edit ${LABEL}` });
	await expect(editButton).toBeVisible();
	await page.getByTestId("badge-grid").screenshot({ path: `.screenshots/badge-grid-${RUN}.png` });

	await editButton.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "Edit Badge" })).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-basics-${RUN}.png` });

	// The three tabs are the editor's whole shape, and the Perks one carries both the table
	// and the Works list. Screenshot it before the art walk changes the draft.
	await dialog.getByRole("tab", { name: "Perks" }).click();
	await dialog.screenshot({ path: `.screenshots/badge-maker-perks-${RUN}.png` });

	// One Add button creates a row with every field on it, and the one (i) beside the Type
	// column explains all four kinds together rather than each on selection.
	await dialog.getByRole("button", { name: "Add a perk" }).click();
	await expect(dialog.getByLabel("Perk type").first()).toBeVisible();
	await expect(dialog.getByLabel("Perk name").first()).toBeVisible();
	await expect(dialog.getByLabel("Perk description").first()).toBeVisible();
	await dialog.getByRole("button", { name: "More Information" }).hover();
	await expect(dialog.getByRole("tooltip")).toContainText("A Physical Good");
	await expect(dialog.getByRole("tooltip")).toContainText("A Service");
	await expect(dialog.getByRole("tooltip")).toContainText("Community Access");
	await expect(dialog.getByRole("tooltip")).toContainText("Recognition");
	await expect(dialog.getByText("No Works are gated at this Badge yet.")).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-perk-row-${RUN}.png` });

	// ⚠️ Scoped by the art panel's own test id rather than by a div containing the label.
	// `locator("div")` filtered on text and taken `.last()` returns the innermost matching
	// div, which here is the one wrapping the label alone — it never contains the mark, and
	// the failure reads as "the feature is missing" when the feature is fine.
	await dialog.getByRole("tab", { name: "Emblem" }).click();
	const control = page.getByTestId("badge-art-control");

	// The default first: a rung with no art of its own is still a badge, not a hole.
	await expect(
		page.getByTestId("badge-maker-preview").getByRole("img", { name: `${LABEL} badge` }),
	).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-default-${RUN}.png` });

	// The library first — three choices, no file picker. This is the path a creator who
	// does not draw actually takes, so it is the one worth walking.
	for (const choice of ["Hexagon", "Amber"]) {
		await control.getByRole("button", { name: choice }).click();
		// ⚠️ Staged now, not saved: the choice stays pressed in the dialog's own draft until
		// Save. That is the behavior the Cancel case protects, so the walk reads it here.
		await expect(control.getByRole("button", { name: choice })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	}
	await dialog.screenshot({ path: `.screenshots/badge-maker-library-${RUN}.png` });

	// The Find mode is present and empty from the start: color swatches, a search box, and
	// a results box with a hint — not a panel that grows once a query lands.
	await control.getByRole("button", { name: "Find an Emblem" }).click();
	await expect(control.getByTestId("noun-results")).toBeVisible();
	const search = control.getByPlaceholder(/Search nearly ten million icons/);
	await expect(search).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-find-${RUN}.png` });

	await search.fill("bee");
	const result = control.getByRole("button", { name: "bee by Test Artist" });
	await expect(result).toBeVisible({ timeout: 10_000 });
	// 🚨 The bug this asserts: the thumb used to be hard-coded white, which is invisible on
	// the light surface. `currentColor` from the text token makes it a contrasting mark.
	const thumbColor = await result
		.locator("span")
		.first()
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(thumbColor).not.toBe("rgb(255, 255, 255)");
	await result.click();
	await expect(result).toHaveAttribute("aria-pressed", "true");
	await dialog.screenshot({ path: `.screenshots/badge-maker-find-result-${RUN}.png` });

	// Then the creator's own art, through the file input the panel keeps mounted.
	await control.locator('input[type="file"]').setInputFiles({
		name: "badge.png",
		mimeType: "image/png",
		buffer: artwork(),
	});

	// The staged preview is the object URL the browser holds; the saved badge is the
	// access-checked route. Seeing the blob first proves the dropzone took the file.
	await expect(control.locator('img[src^="blob:"]')).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-art-${RUN}.png` });

	// Save is what applies the draft. Closing without it is the Cancel case, which must not
	// write the emblem.
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();

	// The grid card wears the art it just saved: the two views are one rendering, so a
	// card that still drew the fallback would be the bug.
	const art = `img[src$="/api/subscriptions/badges/${badgeId}/art"]`;
	await expect(page.locator(art)).toBeVisible({
		timeout: 15_000,
	});

	// 🚨 **Cancel must not save the art draft.** The retired editor wrote shape, color and
	// the composition on click, so a creator who changed their mind still got the emblem
	// they had just rejected. Change both choices here, cancel, and read the stored row.
	await editButton.click();
	await dialog.getByRole("tab", { name: "Emblem" }).click();
	await control.getByRole("button", { name: "Circle" }).click();
	await control.getByRole("button", { name: "Moss" }).click();
	await dialog.getByRole("button", { name: "Cancel" }).click();

	const [stored] = await db
		.select({ artShape: badges.artShape, artColor: badges.artColor })
		.from(badges)
		.where(eq(badges.id, badgeId));
	expect(stored?.artShape).toBe("hexagon");
	expect(stored?.artColor).toBe("amber");

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

/**
 * The other half of the grid: a supporter picking a rung.
 *
 * ⭐ **The pick is the card's own action now**, and the picked card says so in the same
 * surface rather than in a list row beside it. The walker is the gauntlet's ordinary user
 * — signed in, giving nothing — so every rung above their amount is selectable and the
 * first pick is a plain selection with no subscription behind it.
 */
test("a supporter picks a rung and the card carries the highlight", async ({ page, context }) => {
	const errors = trackErrorsStrict(page);
	const label = `E2E pick ${RUN}`;

	// The rung belongs to the creator, so it is made with the creator's session, not the
	// browser's — then the browser signs in as the supporter who picks it.
	const creatorToken = await signInAsCreator(context);
	const created = await fetch(`${API_URL}/api/subscriptions/badges`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${creatorToken}`,
		},
		body: JSON.stringify({ threshold: "7.00", label, description: "A rung to pick." }),
	});
	expect(created.status, "could not create the pick fixture rung").toBe(201);
	pickBadgeId = ((await created.json()) as { badge: { id: number } }).badge.id;

	await signInAsWalker(context);
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=badges`);

	const card = page.locator("article").filter({ hasText: label });
	await expect(card).toBeVisible();
	await card.getByRole("button", { name: "Select" }).click();

	// The picked card wears "Selected" and the action card under the grid appears — the
	// purchase itself stays on the basket's one checkout.
	await expect(card.getByRole("button", { name: "Selected" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("badge-pick-actions")).toBeVisible();
	await page.getByTestId("badge-grid").screenshot({
		path: `.screenshots/badge-grid-selected-${RUN}.png`,
	});

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
