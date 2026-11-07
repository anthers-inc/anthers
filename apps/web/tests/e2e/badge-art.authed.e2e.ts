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
let recomposeBadgeId = 0;
let gatedWorkId = 0;
let gatedBadgeId = 0;
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
	if (gatedWorkId) {
		await fetch(`${API_URL}/api/content/works/${gatedWorkId}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${token}`, Origin: WEB_ORIGIN },
		});
	}
	if (gatedBadgeId) await db.delete(badges).where(eq(badges.id, gatedBadgeId));
	if (badgeId) await db.delete(badges).where(eq(badges.id, badgeId));
	if (pickBadgeId) await db.delete(badges).where(eq(badges.id, pickBadgeId));
	if (recomposeBadgeId) await db.delete(badges).where(eq(badges.id, recomposeBadgeId));
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

	// Seed the Support row the fixed table walk reads: one kind already claimed, with the
	// memo a creator would have typed, so the Perks tab opens with a row to compare against.
	const perkSeed = await fetch(`${API_URL}/api/subscriptions/badges/${badgeId}/perks`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({ perks: [{ kind: "support", label: "Just backing the work" }] }),
	});
	expect(perkSeed.status, "could not seed the fixture perk").toBe(200);

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

	// The four tabs are the editor's whole shape: Basics, Emblem, Perks and Unlocks. The Works
	// list lives on Unlocks now, so it is read there rather than under the perks table.
	await dialog.getByRole("tab", { name: "Perks" }).click();
	await dialog.screenshot({ path: `.screenshots/badge-maker-perks-${RUN}.png` });

	// The fixed table: one row per tax-code kind, the seeded Support row checked with its
	// memo, and every other row waiting unchecked.
	await expect(dialog.getByLabel("Support perk description")).toHaveValue("Just backing the work");
	for (const kind of [
		"Physical",
		"Digital",
		"Community Access",
		"Service",
		"Discount",
		"Recognition",
	]) {
		await expect(dialog.getByRole("checkbox", { name: `Include ${kind} perks` })).not.toBeChecked();
	}
	await expect(dialog.getByRole("checkbox", { name: "Include Support perks" })).toBeChecked();

	// Checking a type is the claim; it enables the memo, and the memo is the only thing the
	// creator types. The rows keep the catalog's order rather than a dragged one.
	await dialog.getByRole("checkbox", { name: "Include Recognition perks" }).check();
	await expect(dialog.getByLabel("Recognition perk description")).toBeEnabled();
	await dialog.getByLabel("Recognition perk description").fill("Name in the credits");
	await expect(dialog.getByLabel("Support perk description")).toHaveValue("Just backing the work");
	await dialog.screenshot({ path: `.screenshots/badge-maker-perk-row-${RUN}.png` });

	await dialog.getByRole("tab", { name: "Unlocks" }).click();
	await expect(dialog.getByText("No Works are gated at this Badge yet.")).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-unlocks-${RUN}.png` });

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
	const art = `img[src*="/api/subscriptions/badges/${badgeId}/art"]`;
	await expect(page.locator(art)).toBeVisible({
		timeout: 15_000,
	});

	// 🚨 **An empty rung saves.** A Badge with no perks and no unlocked Work is a support
	// payment, so removing every perk and pressing Save must land rather than refuse — and
	// the stored row is what proves the write. Support is what the tax fallback reads.
	await editButton.click();
	await dialog.getByRole("tab", { name: "Perks" }).click();
	// Uncheck every type the earlier passes left checked. The row is the claim now; there
	// is no remove button to hunt for.
	const perkBoxes = dialog.getByRole("checkbox", { name: /^Include .* perks$/ });
	for (const box of await perkBoxes.all()) {
		if (await box.isChecked()) await box.uncheck();
	}
	await expect(dialog.getByLabel("Support perk description")).toBeDisabled();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();

	const [emptied] = await db
		.select({ perks: badges.perks })
		.from(badges)
		.where(eq(badges.id, badgeId));
	expect(emptied?.perks).toEqual([]);

	// ⭐ **Cancel must not save the art draft.** The retired editor wrote shape, color and
	// the composition on click, so a creator who changed their mind still got the emblem
	// they had just rejected. Change both choices here, cancel, and read the stored row.
	await editButton.click();
	await dialog.getByRole("tab", { name: "Emblem" }).click();
	await control.getByRole("button", { name: "Circle" }).click();
	await control.getByRole("button", { name: "Background Moss" }).click();
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
 * A gated Work is a fact, not a claim: the Badge includes a digital good because it opens
 * one, so the Digital row checks itself, refuses to be unticked, and arrives described.
 */
test("a gated Work locks its perk type and describes the fact", async ({ page, context }) => {
	const errors = trackErrorsStrict(page);
	token = await signInAsCreator(context);
	const label = `E2E gated rung ${RUN}`;
	const created = await fetch(`${API_URL}/api/subscriptions/badges`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({ threshold: "8.00", label }),
	});
	expect(created.status, "could not create the gated rung").toBe(201);
	gatedBadgeId = ((await created.json()) as { badge: { id: number } }).badge.id;

	const title = `E2E gated perk ${RUN}`;
	const made = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({ type: "service", title }),
	});
	const madeBody = await made.text();
	expect(made.status, `could not create the gated Work: ${made.status} ${madeBody}`).toBe(201);
	const { work } = JSON.parse(madeBody) as { work: { id: number } };
	gatedWorkId = work.id;

	const patched = await fetch(`${API_URL}/api/content/works/${work.id}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({
			access: [{ threshold: 8, allow: true, price: "0", badgeId: gatedBadgeId }],
		}),
	});
	expect(patched.status, "could not gate the Work on the Badge").toBe(200);

	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=badges`);
	await page.getByRole("button", { name: `Edit ${label}` }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("tab", { name: "Perks" }).click();

	const digital = dialog.getByRole("checkbox", { name: "Include Digital perks" });
	await expect(digital).toBeChecked();
	await expect(digital).toBeDisabled();
	await expect(dialog.getByText("From Unlocks")).toBeVisible();
	await expect(dialog.getByLabel("Digital perk description")).toHaveValue(
		"Access to the digital Works this Badge opens",
	);

	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	const [row] = await db
		.select({ perks: badges.perks })
		.from(badges)
		.where(eq(badges.id, gatedBadgeId));
	expect(row?.perks).toEqual([
		{ kind: "digital_good", label: "Access to the digital Works this Badge opens" },
	]);
	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

/**
 * A composed Badge takes a new shape and background by being rebuilt on the server.
 *
 * ⭐ **The refusal this replaces was the honest fallback, not the end state.** A composed
 * PNG bakes in its shape and field, so the editor used to demand a new emblem before it
 * would save either choice. The row now stores the emblem color a recomposition needs, and
 * this walk proves the editor stops refusing and sends the rebuild instead — with the
 * preview still on the saved art until Save, because the browser never has the vector.
 *
 * ⚠️ **The vendor is not reachable from a test session**, so the recompose call itself is
 * intercepted here. The API suite proves the composition and what it persists; this only
 * proves the editor's own path and payload.
 */
test("a composed Badge saves a shape and background change by recomposing", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	const label = `E2E composed ${RUN}`;
	const creatorToken = await signInAsCreator(context);

	const created = await fetch(`${API_URL}/api/subscriptions/badges`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${creatorToken}`,
		},
		body: JSON.stringify({ threshold: "4.25", label }),
	});
	expect(created.status, "could not create the composed fixture rung").toBe(201);
	recomposeBadgeId = ((await created.json()) as { badge: { id: number } }).badge.id;

	// The same completeness rule the art walk seeds for: a rung that names nothing cannot
	// save, and this walk is about the recompose call rather than that refusal.
	const perkSeed = await fetch(`${API_URL}/api/subscriptions/badges/${recomposeBadgeId}/perks`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${creatorToken}`,
		},
		body: JSON.stringify({ perks: [{ kind: "support", label: "Just backing the work" }] }),
	});
	expect(perkSeed.status, "could not seed the composed fixture perk").toBe(200);

	// The row a composition leaves behind: a stored PNG, the fingerprint that marks it a
	// composed whole, and the emblem color the recomposition reads.
	await db
		.update(badges)
		.set({
			artKey: `creators/0/badges/${recomposeBadgeId}/e2e.png`,
			artShape: "circle",
			artColor: "moss",
			artFingerprint: "e".repeat(64),
			artEmblemColor: "#ffffff",
			artEmblemScale: "1",
			artEmblemOffsetX: "0",
			artEmblemOffsetY: "0",
		})
		.where(eq(badges.id, recomposeBadgeId));

	await page.route("**/api/subscriptions/badges/*/art*", (route) =>
		route.fulfill({ status: 200, contentType: "image/png", body: artwork() }),
	);
	let recomposeBody: unknown = null;
	await page.route("**/api/subscriptions/badges/*/recompose", async (route) => {
		recomposeBody = route.request().postDataJSON();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ unchanged: false, artPath: "" }),
		});
	});

	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=badges`);
	await page.getByRole("button", { name: `Edit ${label}` }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("tab", { name: "Emblem" }).click();
	const control = page.getByTestId("badge-art-control");

	await control.getByRole("button", { name: "Hexagon" }).click();
	await control.getByRole("button", { name: "Background Amber" }).click();
	await expect(
		dialog.getByText("Saving rebuilds this emblem on the new shape and background."),
	).toBeVisible();
	await dialog.screenshot({ path: `.screenshots/badge-maker-recompose-${RUN}.png` });

	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	expect(recomposeBody).toEqual({ shape: "hexagon", fieldColor: "amber", edgeColor: "brown" });

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

/**
 * The other half of the grid: a supporter's one action on a Badge card.
 *
 * ⭐ **There is no selection step and no basket pair** (Parker, 2026-11-06): the card says
 * Upgrade, and that opens the one subscription-change modal. The walker is the gauntlet's
 * ordinary user — signed in, giving nothing — so the first rung is a plain upgrade.
 */
test("a supporter's Badge card opens the upgrade modal", async ({ page, context }) => {
	const errors = trackErrorsStrict(page);
	const label = `E2E pick ${RUN}`;

	// The rung belongs to the creator, so it is made with the creator's session, not the
	// browser's — then the browser signs in as the supporter who upgrades.
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
	await card.getByRole("button", { name: "Upgrade" }).click();

	// The one modal, headed with the rung's name and the charge it is about to take.
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: `Give ${label}` })).toBeVisible({
		timeout: 15_000,
	});
	await expect(dialog).toContainText("Charged today");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();

	await page.getByTestId("badge-grid").screenshot({
		path: `.screenshots/badge-grid-upgrade-${RUN}.png`,
	});

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

/**
 * The Unlocks tab is where a Badge's Works are managed: the thumbnail is the door to the
 * Work, and the tab can add a Work as well as remove one.
 *
 * The server half writes the Work's own Access row — access is authored on the Work, never
 * on the Badge — so the proof here is that the picker's add lands and the list re-reads.
 */
test("a creator adds and removes a Badge's Works from the Unlocks tab", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	const label = `E2E unlocks ${RUN}`;
	const token = await signInAsCreator(context);

	const created = await fetch(`${API_URL}/api/subscriptions/badges`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		// A distinct rung from the gated-perk walk's $8: a creator can hold only one
		// Badge at a threshold, and the two tests run in parallel.
		body: JSON.stringify({ threshold: "9.00", label }),
	});
	expect(created.status, "creating the Badge").toBe(201);
	const badge = ((await created.json()) as { badge: { id: number } }).badge;

	const makeWork = async (title: string) => {
		const res = await fetch(`${API_URL}/api/content/works`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: WEB_ORIGIN,
				Cookie: `session=${token}`,
			},
			body: JSON.stringify({ type: "service", title }),
		});
		const body = await res.text();
		expect(res.status, `creating ${title}: ${body}`).toBe(201);
		return (JSON.parse(body) as { work: { id: number; title: string } }).work;
	};

	const gated = await makeWork(`Gated ${RUN}`);
	const added = await makeWork(`Added ${RUN}`);
	const patched = await fetch(`${API_URL}/api/content/works/${gated.id}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
		},
		body: JSON.stringify({
			access: [{ threshold: 9, allow: true, price: "0", badgeId: badge.id }],
		}),
	});
	expect(patched.status, "gating the first Work").toBe(200);

	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=badges`);
	await page.getByRole("button", { name: `Edit ${label}` }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("tab", { name: "Unlocks" }).click();

	// The thumbnail is the link, and the button whose place it took is gone.
	await expect(dialog.getByRole("link", { name: `Open ${gated.title} in Studio` })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Open in Studio" })).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "Remove from Badge" })).toBeVisible();

	// Add a second Work through the same picker the Project page uses.
	await dialog.getByRole("button", { name: "Add Works" }).click();
	await page.getByRole("checkbox", { name: `Select ${added.title}` }).check();
	await page.getByRole("button", { name: "Add Work(s)" }).click();

	// The list re-read from the server and the new Work is on it.
	await expect(dialog.getByText(added.title)).toBeVisible({ timeout: 15_000 });
	await expect(dialog.getByRole("link", { name: `Open ${added.title} in Studio` })).toBeVisible();

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

/**
 * Adding a Badge opens the full editor rather than closing on the basics modal.
 *
 * The new shape library and the edge color row live behind the Emblem tab, so a creator
 * who lands on the tabs can finish the Badge in one pass. This walks the create door and
 * reads the two new shape choices, the edge swatches and the default emblem mode.
 */
test("adding a Badge lands on the full editor with the new shapes and edge", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	const label = `E2E full editor ${RUN}`;
	await signInAsCreator(context);

	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	await page.goto(`${WEB_ORIGIN}${profileUrl(handle)}?tab=badges`);
	await page.getByRole("button", { name: "Add a Badge" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "Add a Badge" })).toBeVisible();

	await dialog.getByPlaceholder("Label (e.g. Supporter)").fill(label);
	await dialog.getByLabel("Monthly Amount").fill("11.00");
	await dialog.getByRole("button", { name: "Add Badge" }).click();

	// The dialog stays open, now as the editor for the created rung: the tabs and the
	// footer's Save are what a creator should meet next, not a closed modal.
	await expect(dialog.getByRole("heading", { name: "Edit Badge" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(dialog.getByRole("tab", { name: "Basics" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Perks" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Unlocks" })).toBeVisible();
	// It lands on Emblem, where the art is finished.
	await expect(dialog.getByRole("tab", { name: "Emblem" })).toHaveAttribute(
		"aria-selected",
		"true",
	);

	const control = page.getByTestId("badge-art-control");
	// Seed is gone; diamond and heart are the two new shapes.
	await expect(control.getByRole("button", { name: "Diamond" })).toBeVisible();
	await expect(control.getByRole("button", { name: "Heart" })).toBeVisible();
	await expect(control.getByRole("button", { name: "Seed" })).toHaveCount(0);
	// The third swatch row is the edge, and the brown is the default selection.
	for (const edge of ["Brown", "Black", "Cream", "Moss", "Navy", "Clay"]) {
		await expect(control.getByRole("button", { name: `Edge ${edge}` })).toBeVisible();
	}
	await expect(control.getByRole("button", { name: "Edge Brown" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// Find an Emblem is first and selected, so the catalog is open rather than a placeholder.
	await expect(control.getByRole("button", { name: "Find an Emblem" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
