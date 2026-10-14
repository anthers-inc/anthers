// SPDX-License-Identifier: Apache-2.0
/**
 * Drafting a Work with no file, and changing its kind on the fly.
 *
 * 🚨 **The assertion worth the spec is the absence of a gate.** The Upload page once refused to
 * create until a file was picked, which meant a failed upload or a not-yet-rendered file cost
 * the creator every word typed beside it (Parker, 2026-10-10). This walk creates a Work from a
 * kind and a name alone, lands on the Work's own page — the editing surface every kind now
 * shares (the kinds pass, 2026-10-14) — changes the kind there, which saves at once, and asks
 * the server at the end what actually stood. It also guards both halves of the composition:
 * - the fileless Work cannot be released (`media_missing`), so a draft is still not a publish;
 * - the kind change carried the save, which is the server's rating reset and the page's
 *   restructure agreeing with each other.
 *
 * Runs in the `authed` project on `media_fixture`, which nothing else resets — see
 * `signInAsMediaFixture` in `fixtures.ts`. Unlike the upload walks it shares the project with,
 * nothing binary is needed: the whole point is that no file is ever picked.
 */
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE = `Draft walk ${Date.now()}`;
let session = "";

test.afterAll(async () => {
	if (!session) return;
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works: owned } = (await res.json()) as { works: { id: number; title: string }[] };
	for (const w of owned.filter((w) => w.title === TITLE)) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});

test("a Work is drafted from a kind and a name, and its kind changes on its page", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);

	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("comic");
	await page.getByPlaceholder("Work title").fill(TITLE);
	await page.getByRole("button", { name: /skip for now/i }).click();

	// The Work's OWN page — the editing surface for every kind (the kinds pass,
	// 2026-10-14) — with the deliverable's silhouette holding its place and release
	// refusing to be offered for a Work that cannot be released yet.
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	await expect(page.getByText(/the pages open here/i)).toBeVisible();
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(
		page.getByRole("checkbox", { name: /released to my public catalog/i }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Cancel editing Release" }).click();

	// The kind control offers itself for an empty private draft; the select saves at
	// once and the row answers, so the page follows the row rather than a bar's save.
	const kind = page.getByRole("combobox", { name: "Work kind" });
	await expect(kind).toBeVisible();
	await expect(kind).toHaveValue("comic");
	await kind.selectOption("ebook");

	// The row now says Book, and the page follows the row: the file's silhouette is a
	// book's, and no file section claims anything but the truth.
	await expect(page.getByRole("combobox", { name: "Work kind" })).toHaveValue("ebook", {
		timeout: 15_000,
	});
	await expect(page.getByText(/the book opens here/i)).toBeVisible();

	const [row] = await db.select().from(works).where(eq(works.title, TITLE));
	expect(row?.type).toBe("ebook");
	// An unrated draft stays unrated through a kind change; nothing answered nothing.
	expect(row?.maturity).toBe("unrated");
});
