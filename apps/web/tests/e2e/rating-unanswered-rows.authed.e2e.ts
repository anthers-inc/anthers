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
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

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
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(created.status).toBe(201);
	const { work } = (await created.json()) as { work: { id: number; publicId: number } };
	await db
		.update(works)
		.set({ maturity: "general", maturitySource: "creator" })
		.where(eq(works.id, work.id));

	// The card is how a back catalog is released thirty at a time, so it has to say which ones
	// still need answering.
	await page.goto("/studio/catalog");
	const card = page.locator(".card").filter({ hasText: TITLE });
	await expect(card).toContainText("Rate this");
	await expect(card.getByRole("button", { name: "Release" })).toBeDisabled();

	await card.getByRole("link", { name: "Rate this" }).click();
	await expect(page).toHaveURL(new RegExp(`/studio/works/${work.publicId}/edit$`));
	const released = page.getByLabel("Released to my public Catalog");
	await expect(
		page.getByText("This Work is rated General today, but not every row is answered."),
	).toBeVisible();
	await expect(page.getByText("Answer every row of the Rating above first.")).toBeVisible();
	await expect(released).toBeDisabled();
	await expect(page.getByLabel("Release time")).toBeDisabled();

	// Answering the rows is the whole fix, and the release goes in the same save.
	await page.getByRole("button", { name: 'Mark the Rest "Not in It"' }).click();
	await expect(released).toBeEnabled();
	await released.check();
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
		timeout: 15_000,
	});

	const [row] = await db.select().from(works).where(eq(works.id, work.id));
	expect(row.visibility).toBe("released");
	expect(row.maturityRows).toMatchObject({ violence: "none", language: "none" });
});
