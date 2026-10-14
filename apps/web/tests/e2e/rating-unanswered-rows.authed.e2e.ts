// SPDX-License-Identifier: Apache-2.0
/**
 * A Work holding a rating with no rows behind it, walked in a browser: the Studio treats it as
 * unrated until every row of its matrix is answered, as the server does.
 *
 * 🚨 **Rated means every row answered** (Parker, 2026-09-18). A Work rated before the matrix
 * existed carries a rating and no rows, and release refuses it with `maturity_undeclared`. The
 * Edit page and the Catalog card used to ask whether the Work held a rating, which such a Work
 * does, so they offered a release the server would refuse. This walk is what would catch them
 * asking the old question again. The rating is written straight into the database, because no
 * creator path produces this state any more.
 *
 * Runs on `media_fixture`, which has payouts set up, so the only thing locking the release
 * control is the rating.
 */
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	API_URL,
	CREATED_CREDIT,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE_PREFIX = "Unanswered rows walk ";
const TITLE = `${TITLE_PREFIX}${Date.now()}`;

let session = "";

async function sweep(): Promise<void> {
	if (!session) return;
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works: own } = (await res.json()) as { works: Array<{ id: number; title: string }> };
	for (const w of own.filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.afterAll(sweep);

test("a Work rated before the matrix is released only once every row is answered", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await sweep();

	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			type: "text",
			title: TITLE,
			bodyHtml: "<p>Rated before there was a matrix to rate it with.</p>",
			streamEnabled: true,
			access: [{ threshold: 0, allow: true, price: "0" }],
			// The gate under test is the rating's, not the credits one — stage the human credit.
			credits: CREATED_CREDIT,
		}),
	});
	expect(created.status).toBe(201);
	const { work } = (await created.json()) as { work: { id: number; publicId: number } };
	await db
		.update(works)
		.set({ maturity: "general", maturitySource: "creator" })
		.where(eq(works.id, work.id));

	// The Works table is how a back catalog is released thirty rows at a time, so it has to
	// say which ones still need answering.
	await page.goto("/studio/works");
	const row = page.locator("tbody tr").filter({ hasText: TITLE });
	await expect(row).toContainText("Rate this");
	await expect(row.getByRole("button", { name: "Release" })).toBeDisabled();

	await row.getByRole("link", { name: "Rate this" }).click();
	// The Studio route redirects to the Work's page (every kind's editing surface now);
	// the incomplete rating is the Rating tab's read, and the release field says why
	// its own control waits (the kinds pass, 2026-10-14).
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	await page.getByRole("tab", { name: "Rating" }).click();
	await expect(
		page.getByText("A rating exists on this Work, but not every row of its matrix is answered", {
			exact: false,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "Edit Rating" }).click();

	// The release field waits for the same reason, said beside its control.
	await page.getByRole("tab", { name: "Details" }).click();
	await page.getByRole("button", { name: "Edit Release" }).click();
	const released = page.getByLabel("Released to my public Catalog");
	await expect(page.getByText(/answer every row of the rating first/i)).toBeVisible();
	await expect(released).toBeDisabled();
	// (The schedule input itself stays offered while unrated, as the batch editor's rule had it.)

	// Answering the rows is the whole fix; the rating saves alone, and then the release
	// field's own save carries the release. Switching tabs unmounts a field's edit
	// state, so the rating's edit opens again here.
	await page.getByRole("tab", { name: "Rating" }).click();
	await page.getByRole("button", { name: "Edit Rating" }).click();
	await page.getByRole("button", { name: 'Mark the Rest "Not in It"' }).click();
	await page.getByRole("button", { name: "Save Rating" }).click();
	await page.getByRole("tab", { name: "Details" }).click();
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(released).toBeEnabled({ timeout: 15_000 });
	await released.check();
	await page.getByRole("button", { name: "Save Release" }).click();

	// POLLED: the DB read waits for what the server holds, rather than racing the save's
	// response home under a full suite's load.
	await expect
		.poll(async () => (await db.select().from(works).where(eq(works.id, work.id)))[0]?.visibility, {
			message: "the release save never reached the row",
		})
		.toBe("released");
	const [stored] = await db.select().from(works).where(eq(works.id, work.id));
	expect(stored.maturityRows).toMatchObject({ violence: "none", language: "none" });
});
