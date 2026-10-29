// SPDX-License-Identifier: Apache-2.0
/**
 * A physical good's Selling section and the variants behind its media area's pencil — the
 * answers a creator gives in the Studio (Parker's physical-goods model, 2026-10-26).
 *
 * The walk proves the surface, not the arithmetic: the section exists for a good and is
 * absent for a kind that ships nothing, the unset listing reads as shippable-at-zero with
 * a three-day handling time rather than as a broken checkout, an edit round-trips through
 * a reload, and a variant added behind the media area's pencil survives a reload with it.
 *
 * The Work is created through the same route the New Work flow calls, so nothing here
 * depends on the four-card flow — the page is the subject.
 */

import {
	API_URL,
	createDraftWork,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const STEM = "Selling walk";

/** A real 1×1 PNG — small but honest: the gallery's preview is the picture it holds. */
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

let session = "";

function headers(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Origin: WEB_ORIGIN,
		Cookie: `session=${session}`,
	};
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
	if (!session) return;
	// The media fixture is shared and nothing else resets it, so a spec that creates Works
	// owns their removal — matched by this spec's stem, never by the account.
	const res = await fetch(`${API_URL}/api/content/works?mine=1`, { headers: headers() });
	if (!res.ok) return;
	const { works } = (await res.json()) as { works: Array<{ id: number; title: string }> };
	for (const work of works.filter((w) => w.title?.startsWith(STEM))) {
		await fetch(`${API_URL}/api/content/works/${work.id}`, {
			method: "DELETE",
			headers: headers(),
		}).catch(() => {});
	}
});

test("a physical good's variants and thumbnail live in the media area", async ({
	page,
	context,
}) => {
	// The walk opens three editors and reloads twice; the default 30 s is the harness's,
	// not this surface's.
	test.setTimeout(120_000);
	session = await signInAsMediaFixture(context);
	const draft = await createDraftWork(page, { type: "physical", title: `${STEM} mug` });
	await page.goto(draft.url);
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+/, { timeout: 15_000 });

	const manage = page.locator("#work-side-manage");
	await expect(manage.getByRole("heading", { name: "Shipping" })).toBeVisible();
	// Unsold-in: zero shipping and three business days are answers, not blanks.
	await expect(manage.getByText(/free shipping/i)).toBeVisible();
	await expect(manage.getByText(/3 business days to send/i)).toBeVisible();
	// The buyer's variants are not a Manage-tab section any more: they live behind the
	// media area's pencil, beside the store panel they configure.
	await expect(manage.getByRole("heading", { name: "Variants" })).toHaveCount(0);

	// Shipping: the pencil opens the field, the checkmark saves it.
	await manage.getByRole("button", { name: "Edit Shipping" }).click();
	await page.getByLabel("Shipping price").fill("6.5");
	await page.getByRole("button", { name: "Save Shipping" }).click();
	await expect(manage.getByText(/\$6\.50 to ship/i)).toBeVisible({ timeout: 15_000 });

	// The row, not the page, is the truth: a reload reads it back.
	await page.reload();
	await expect(page.locator("#work-side-manage").getByText(/\$6\.50 to ship/i)).toBeVisible({
		timeout: 15_000,
	});

	// A variant, with one value counted and one left unlimited.
	await page.getByRole("button", { name: "Manage This Good" }).click();
	await expect(page.getByRole("heading", { name: "Goods Management" })).toBeVisible();
	// The good's pictures are buyer-facing too, so they ride the same panel: the old
	// 16:9 thumbnail tab is the square gallery now.
	await expect(page.getByRole("tab", { name: "Variants" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Photos" })).toBeVisible();
	await expect(page.getByText(/no variants/i)).toBeVisible();
	await page.getByRole("button", { name: "Edit Variants" }).click();
	// An unset listing opens on an empty builder, so the first variant is added before it
	// can be named.
	await page.getByRole("button", { name: "Add a variant" }).click();
	await page.getByLabel("Variant 1 name").fill("Size");
	await page.getByLabel("Size value 1").fill("Mug");
	await page.getByLabel("Size Mug left in stock").fill("4");
	await page.getByRole("button", { name: "Add a value" }).click();
	await page.getByLabel("Size value 2").fill("Big mug");
	await page.getByRole("button", { name: "Save Variants" }).click();
	await expect(page.getByText(/Size:/)).toBeVisible({ timeout: 15_000 });

	// The gallery: two square pictures, a description on the first, and the first wears
	// the cover.
	await page.getByRole("tab", { name: "Photos" }).click();
	await expect(page.getByText(/no photos yet/i)).toBeVisible();
	await page
		.locator('input[type="file"][multiple]')
		.setInputFiles([stubImage("front.png"), stubImage("back.png")]);
	await expect(page.getByRole("img", { name: "Photo 1" })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("img", { name: "Photo 2" })).toBeVisible();
	await expect(page.getByText("Cover", { exact: true })).toBeVisible();
	await page.getByLabel("Describe photo 1").fill("Mug front");
	await page.getByLabel("Describe photo 1").blur();
	await expect(page.getByRole("img", { name: "Mug front" })).toBeVisible({ timeout: 15_000 });
	await page.getByLabel("Describe photo 2").fill("Mug back");
	await page.getByLabel("Describe photo 2").blur();
	await expect(page.getByRole("img", { name: "Mug back" })).toBeVisible({ timeout: 15_000 });

	// Done returns the media area's pencil, and the draft now renders its own storefront
	// rather than the 404 it used to show the creator.
	await page.getByRole("button", { name: "Done" }).click();
	await expect(page.getByRole("button", { name: "Manage This Good" })).toBeVisible();
	await expect(page.getByRole("img", { name: "Mug front" })).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Next photo" }).click();
	await expect(page.getByRole("img", { name: "Mug back" })).toBeVisible();

	await page.reload();
	await page.getByRole("button", { name: "Manage This Good" }).click();
	await expect(page.getByText("Mug, Big mug")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("tab", { name: "Photos" }).click();
	await expect(page.getByRole("img", { name: "Mug front" })).toBeVisible({ timeout: 15_000 });
});

test("a kind that ships nothing carries no Selling section", async ({ page, context }) => {
	session = session || (await signInAsMediaFixture(context));
	const draft = await createDraftWork(page, { type: "video", title: `${STEM} clip` });
	await page.goto(draft.url);
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+/, { timeout: 15_000 });

	const manage = page.locator("#work-side-manage");
	await expect(manage.getByRole("combobox", { name: "Work kind" })).toBeVisible();
	await expect(manage.getByRole("heading", { name: "Shipping" })).toHaveCount(0);
	await expect(manage.getByRole("heading", { name: "Variants" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Manage This Good" })).toHaveCount(0);
});
