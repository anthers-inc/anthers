// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's type decides which rating grid its Edit page asks, walked in a browser.
 *
 * Writing, books, music and other audio are rated on the light grid, whose answers are *General* and
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
	// The Studio route is a redirect for every kind now (the kinds pass, 2026-10-14);
	// the Rating tab IS the table — always open, no edit state to enter (Parker, 2026-10-16).
	await page.getByRole("tab", { name: "Rating" }).click();
	const matrix = page.getByRole("tabpanel", { name: "Rating" }).locator("table");
	await expect(matrix.getByRole("columnheader", { name: "General", exact: true })).toBeVisible();
	await expect(matrix.getByRole("columnheader", { name: "Explicit", exact: true })).toBeVisible();
	// Only sexual content reaches Adult on this grid.
	await expect(page.getByRole("radio", { name: "Violence: Adult" })).toHaveCount(0);
	await expect(page.getByRole("radio", { name: "Sexual Content: Adult" })).toHaveCount(1);
	// The cells' explanation moved into the hover ⓘ (Parker, 2026-10-16): the rung's line
	// sits as the ⓘ's tip on exactly the cell it describes, nowhere in the cell's face.
	await expect(
		matrix.locator(
			'[data-tip="Gore, mutilation or torture described in sustained, graphic detail"]',
		),
	).toHaveCount(1);
	await expect(
		matrix.locator(
			`[data-tip="${"Conflict, peril, injury or death, described without dwelling on it"}"]`,
		),
	).toHaveCount(1);

	// The None heading answers every row at once, and the row's own radio overrides the one
	// row the rating turns on — the two ways the table is answered, in one walk.
	await matrix.getByRole("button", { name: "None", exact: true }).click();
	await page.getByRole("radio", { name: "Strong Language: Explicit" }).check();
	await page.getByRole("button", { name: "Save Rating" }).click();

	// POLLED: the DB read races nothing. The save's own response adopted the row, and the
	// poll waits for what the server holds rather than asserting on the click's wake.
	await expect
		.poll(async () => (await db.select().from(works).where(eq(works.id, work.id)))[0]?.maturity, {
			message: "the rating save never reached the row",
		})
		.toBe("mature");
	const [row] = await db.select().from(works).where(eq(works.id, work.id));
	expect(row.maturityRows).toMatchObject({ language: "mature", violence: "none" });

	// Parker's example for the closest-rung rule, left unsaved in the draft: the Adult
	// heading cannot set Violence to a rung the light grid denies it, so it sets Explicit.
	await matrix.getByRole("button", { name: "Adult", exact: true }).click();
	await expect(page.getByRole("radio", { name: "Violence: Explicit" })).toBeChecked();
	await expect(page.getByRole("radio", { name: "Violence: Adult" })).toHaveCount(0);
});

test("a game is rated on the visual grid, where language never rates", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const work = await create({ type: "game", title: `${STEM} game` });

	await page.goto(`/studio/works/${work.publicId}/edit`);
	// Same redirect, same tab, no edit state: the visual grid asserts itself in the open table.
	await page.getByRole("tab", { name: "Rating" }).click();
	const matrix = page.getByRole("tabpanel", { name: "Rating" }).locator("table");
	await expect(matrix.getByRole("columnheader", { name: "Mature", exact: true })).toBeVisible();
	await expect(matrix.getByRole("columnheader", { name: "Explicit", exact: true })).toHaveCount(0);
	await expect(page.getByRole("radio", { name: "Violence: Adult" })).toHaveCount(1);
	await expect(page.getByRole("radio", { name: "Strong Language: Mature" })).toHaveCount(0);
	// And the ⓘ tip is the visual grid's own line for the cell it sits on.
	await expect(
		matrix.locator(
			'[data-tip="Realistic injury in sustained detail: gore, mutilation or torture shown rather than implied"]',
		),
	).toHaveCount(1);
	// Language never rates here, so its Mature and Adult cells are dashed; with Self-Harm's
	// and Horror's Adult cells, four cells on this grid say N/A.
	await expect(matrix.getByText("N/A")).toHaveCount(4);
});
