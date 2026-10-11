// SPDX-License-Identifier: Apache-2.0
/**
 * Drafting a Work with no file, and changing its kind on the fly.
 *
 * 🚨 **The assertion worth the spec is the absence of a gate.** The Upload page once refused to
 * create until a file was picked, which meant a failed upload or a not-yet-rendered file cost
 * the creator every word typed beside it (Parker, 2026-10-10). This walk creates a Work from a
 * kind and a name alone, lands on its Edit page, changes the kind there, and saves — asking the
 * server at the end what actually stood. It also guards both halves of the composition:
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

	// On the Work's own page, with the file section holding the no-file state and release
	// refusing to be offered for a Work that cannot be released yet.
	await expect(page).toHaveURL(/\/studio\/works\/\d+\/edit$/, { timeout: 15_000 });
	await expect(page.getByText(/this work has no file yet/i)).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: /released to my public catalog/i }),
	).toBeDisabled();

	// The kind control offers itself for an empty private draft, and changing it
	// restructures the page: the media section follows the kind, in place, unsaved.
	const kind = page.getByRole("combobox", { name: "Work kind" });
	await expect(kind).toBeVisible();
	await expect(kind).toHaveValue("comic");
	await kind.selectOption("ebook");

	// The save carries the kind; the server's answer drives the page from here on.
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
		timeout: 15_000,
	});

	// The row now says Book, and the page follows the row: the override cleared, the
	// select (still offered — the draft has no media to strand) shows the saved kind, and
	// no file section claims anything but the truth.
	await expect(page.getByRole("combobox", { name: "Work kind" })).toHaveValue("ebook");
	await expect(page.getByText(/this work has no file yet/i)).toBeVisible();

	const [row] = await db.select().from(works).where(eq(works.title, TITLE));
	expect(row?.type).toBe("ebook");
	// An unrated draft stays unrated through a kind change; nothing answered nothing.
	expect(row?.maturity).toBe("unrated");
});
