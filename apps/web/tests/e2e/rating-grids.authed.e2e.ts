// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's type decides which rating grid its Edit page asks, walked in a browser.
 *
 * Writing, books, music and other audio are rated on the light grid, whose answers are *In It* and
 * *Explicit*, where strong language can make a Work Mature and only sexual content reaches Adult.
 * Everything else is rated on the visual grid, where language never rates (Parker, 2026-09-18).
 * The grids store the same values, so what this walk would catch is the matrix showing a Work the
 * other grid: offering a piece of writing an Adult it cannot take, or a game an Explicit that its
 * server would drop.
 *
 * Runs on `media_fixture`, which has payouts set up.
 */
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const STEM = `Rating grids walk ${Date.now()}`;

let session = "";
/**
 * The Works this worker made. ⚠️ By id rather than by title: the two tests run in parallel, and a
 * sweep by title in one worker's `afterAll` deletes the other's Work while it is still being walked.
 */
const made: number[] = [];

test.afterAll(async () => {
	for (const id of made) {
		await fetch(`${API_URL}/api/content/works/${id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});

async function create(body: Record<string, unknown>): Promise<{ id: number; publicId: number }> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	const { work } = (await res.json()) as { work: { id: number; publicId: number } };
	made.push(work.id);
	return work;
}

test("a piece of writing is rated on the light grid, where its language can make it Mature", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const work = await create({
		type: "text",
		title: `${STEM} writing`,
		bodyHtml: "<p>Words a creator would call explicit.</p>",
	});

	await page.goto(`/studio/works/${work.publicId}/edit`);
	const matrix = page.locator("#work-rating table");
	await expect(matrix.getByRole("columnheader", { name: "In It", exact: true })).toBeVisible();
	await expect(matrix.getByRole("columnheader", { name: "Explicit", exact: true })).toBeVisible();
	// Only sexual content reaches Adult on this grid.
	await expect(page.getByRole("radio", { name: "Violence: Adult" })).toHaveCount(0);
	await expect(page.getByRole("radio", { name: "Sexual Content: Adult" })).toHaveCount(1);

	await page.getByRole("radio", { name: "Strong Language: Explicit" }).check();
	await page.getByRole("button", { name: 'Mark the Rest "Not in It"' }).click();
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
		timeout: 15_000,
	});

	const [row] = await db.select().from(works).where(eq(works.id, work.id));
	expect(row.maturity).toBe("mature");
	expect(row.maturityRows).toMatchObject({ language: "mature", violence: "none" });
});

test("a game is rated on the visual grid, where language never rates", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const work = await create({ type: "game", title: `${STEM} game` });

	await page.goto(`/studio/works/${work.publicId}/edit`);
	const matrix = page.locator("#work-rating table");
	await expect(matrix.getByRole("columnheader", { name: "Mature", exact: true })).toBeVisible();
	await expect(matrix.getByRole("columnheader", { name: "Explicit", exact: true })).toHaveCount(0);
	await expect(page.getByRole("radio", { name: "Violence: Adult" })).toHaveCount(1);
	await expect(page.getByRole("radio", { name: "Strong Language: Mature" })).toHaveCount(0);
});
