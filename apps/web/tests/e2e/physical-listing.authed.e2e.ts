// SPDX-License-Identifier: Apache-2.0
/**
 * A physical good's storefront as its editor — the variant rows, quantity bounds, pictures
 * and parcel policies a creator sets on the page a buyer reads (Parker's physical-goods
 * model, 2026-10-26; the inline-editing pass, 2026-10-29).
 *
 * The walk proves the surface, not the arithmetic: the policy block exists for a good and is
 * absent for a kind that ships nothing, the unset listing reads as shippable-at-zero with a
 * three-day handling time rather than as a broken checkout, each field opens from its own
 * pencil, and every edit round-trips through a reload.
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

test("a physical good's fields are edited on its storefront", async ({ page, context }) => {
	// The walk opens several editors and reloads; the default 30 s is the harness's,
	// not this surface's.
	test.setTimeout(120_000);
	session = await signInAsMediaFixture(context);
	const draft = await createDraftWork(page, { type: "physical", title: `${STEM} mug` });
	await page.goto(draft.url);
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+/, { timeout: 15_000 });

	// The buyer-facing fields are not on the Manage tab any more: the creator's own
	// storefront is where they are read and edited.
	const manage = page.locator("#work-side-manage");
	await expect(manage.getByRole("heading", { name: "Shipping" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Shipping & Policies" })).toBeVisible();
	await expect(page.getByText("Work not found")).toHaveCount(0);

	// Shipping: the pencil in the policy block opens it.
	await page.getByRole("button", { name: "Edit Shipping" }).click();
	await page.getByLabel("Shipping price").fill("6.5");
	await page.getByRole("button", { name: "Save Shipping" }).click();
	await expect(page.getByText(/\$6\.50 to ship/i)).toBeVisible({ timeout: 15_000 });

	// A variant, built in the storefront and read back as a row with its own pencil.
	await expect(page.getByText(/nothing to choose/i)).toBeVisible();
	await page.getByRole("button", { name: "Add a variant" }).click();
	await page.getByLabel("Variant 1 name").fill("Size");
	await page.getByLabel("Size value 1").fill("Mug");
	await page.getByLabel("Size Mug left in stock").fill("4");
	await page.getByRole("button", { name: "Add a value" }).click();
	await page.getByLabel("Size value 2").fill("Big mug");
	await page.getByRole("button", { name: "Save variant" }).click();
	await expect(page.getByRole("button", { name: "Edit Size variant" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: "Mug", exact: true })).toBeVisible();

	// A row's editor takes the whole right side: the price box, the policy block, the other
	// variants and the buy door step out of its way until it closes.
	await page.getByRole("button", { name: "Edit Size variant" }).click();
	await expect(page.getByTestId("physical-quote-box")).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Shipping & Policies" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Buy Now" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit Size variant" })).toHaveCount(0);
	await page.getByRole("button", { name: "Cancel" }).click();

	// Photos: the carousel's own pencil, then two square pictures with descriptions.
	await page.getByRole("button", { name: "Edit photos" }).click();
	await expect(page.getByRole("button", { name: "Add photos" })).toBeVisible();
	await page
		.locator('input[type="file"][multiple]')
		.setInputFiles([stubImage("front.png"), stubImage("back.png")]);
	await expect(page.getByRole("img", { name: "Photo 1" })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("img", { name: "Photo 2" })).toBeVisible();
	// The first picture starts as the cover; the star moves it and never leaves the gallery
	// without one.
	await expect(page.getByRole("button", { name: "Photo 1 is the cover" })).toBeVisible();
	await page.getByLabel("Describe photo 1").fill("Mug front");
	await page.getByLabel("Describe photo 1").blur();
	await expect(page.getByRole("img", { name: "Mug front" })).toBeVisible({ timeout: 15_000 });
	await page.getByLabel("Describe photo 2").fill("Mug back");
	await page.getByLabel("Describe photo 2").blur();
	await expect(page.getByRole("img", { name: "Mug back" })).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Set photo 2 as cover" }).click();
	await expect(page.getByRole("button", { name: "Photo 2 is the cover" })).toBeVisible({
		timeout: 15_000,
	});
	await page.getByRole("button", { name: "Done" }).click();

	// The carousel returns, with the cover first.
	await expect(page.getByRole("img", { name: "Mug back" })).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Next photo" }).click();
	await expect(page.getByRole("img", { name: "Mug front" })).toBeVisible();

	// The row, not the page, is the truth: a reload reads every edit back.
	await page.reload();
	await expect(page.getByText(/\$6\.50 to ship/i)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("button", { name: "Edit Size variant" })).toBeVisible();
	await expect(page.getByRole("img", { name: "Mug back" })).toBeVisible();

	// A removal is confirmed first, and the remaining picture carries the cover.
	await page.getByRole("button", { name: "Edit photos" }).click();
	page.once("dialog", (dialog) => void dialog.accept());
	await page.getByRole("button", { name: "Remove photo 1" }).click();
	await expect(page.getByRole("img", { name: "Mug back" })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("button", { name: "Photo 1 is the cover" })).toBeVisible();
});

test("a kind that ships nothing carries no storefront policy block", async ({ page, context }) => {
	session = session || (await signInAsMediaFixture(context));
	const draft = await createDraftWork(page, { type: "video", title: `${STEM} clip` });
	await page.goto(draft.url);
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+/, { timeout: 15_000 });

	const manage = page.locator("#work-side-manage");
	await expect(manage.getByRole("combobox", { name: "Work kind" })).toBeVisible();
	await expect(manage.getByRole("heading", { name: "Shipping" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Shipping & Policies" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit photos" })).toHaveCount(0);
});
