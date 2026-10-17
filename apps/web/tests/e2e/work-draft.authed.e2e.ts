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
	for (const w of owned.filter((w) => w.title === TITLE || w.title.startsWith(`${TITLE} `))) {
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
	// The fileless state's dropper is IN the box for the kinds whose deliverable is
	// a file (the dropper task, 2026-10-17) — but not for the paged kinds, whose SET
	// editor (with its own add-pages dropper) stays the Manage tab's form. The comic
	// is paged, so the placeholder box itself is bare. Scoped to the box: the page
	// still carries the set editor's dropper, in the Manage panel, by design.
	const box = page.getByRole("status").filter({ hasText: /the pages open here/i });
	await expect(box.getByRole("button", { name: /drop .* or click to browse/i })).toHaveCount(0);
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(
		page.getByRole("checkbox", { name: /released to my public catalog/i }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Cancel editing Release" }).click();

	// The kind control offers itself for an empty private draft — on the MANAGE tab
	// (Parker, 2026-10-17): the kind is the machinery's first fact, and the machinery
	// is the Manage tab's; the Details tab is the Work's composition. Scoped to the
	// panel, so the walk pins where the select lives, not only that it exists. The
	// select saves at once and the row answers, so the page follows the row rather
	// than a bar's save.
	const kind = page.locator("#work-side-manage").getByRole("combobox", { name: "Work kind" });
	await expect(kind).toBeVisible();
	await expect(
		page.locator("#work-tab-details").getByRole("combobox", { name: "Work kind" }),
	).toHaveCount(0);
	await expect(kind).toHaveValue("comic");
	await kind.selectOption("ebook");

	// The kind select saves at once and the row answers, so the page follows the row:
	// the file's silhouette is a book's, and no file section claims anything but the
	// truth. Still scoped to the Manage panel — the select keeps its tab through the
	// restructure the change causes.
	await expect(
		page.locator("#work-side-manage").getByRole("combobox", { name: "Work kind" }),
	).toHaveValue("ebook", {
		timeout: 15_000,
	});
	await expect(page.getByText(/the book opens here/i)).toBeVisible();

	const [row] = await db.select().from(works).where(eq(works.title, TITLE));
	expect(row?.type).toBe("ebook");
	// An unrated draft stays unrated through a kind change; nothing answered nothing.
	expect(row?.maturity).toBe("unrated");
});

test("a fileless audio draft drops its file in the Work placeholder, not in a tab", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);

	const title = `${TITLE} audio`;
	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("audio");
	await page.getByPlaceholder("Work title").fill(title);
	await page.getByRole("button", { name: /skip for now/i }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	// The dropper rides INSIDE the placeholder (the dropper task, 2026-10-17): the
	// box is the Work's place, so the act of filling it happens there, with its own
	// warning line under the silhouette. That both halves matter — the picker the
	// box gains, AND the Manage tab's fileless section gone — is why both are
	// asserted: the tab is where the act used to be. Scoped to the panel, because
	// the box itself stays on the page through every tab.
	const box = page.getByRole("status").filter({ hasText: /the player starts here/i });
	await expect(box.getByText(/no file yet/i)).toBeVisible();
	const dropper = box.getByRole("button", { name: /drop an audio file or click to browse/i });
	await expect(dropper).toBeVisible();
	await page.getByRole("tab", { name: /Manage/ }).click();
	const managePanel = page.locator("#work-side-manage");
	await expect(managePanel.getByText(/no file yet/i)).toHaveCount(0);
	await expect(managePanel.getByRole("button", { name: /drop an audio file/i })).toHaveCount(0);

	// And the act itself, done where it now lives: the pick attaches through the
	// box, and the row holds the file.
	await box.locator('input[type="file"]').setInputFiles({
		name: `${title}.mp3`,
		mimeType: "audio/mpeg",
		buffer: Buffer.from("ID3 a tiny audio stand-in for the walk"),
	});
	await expect
		.poll(async () => {
			const listing = await fetch(`${API_URL}/api/content/works`, {
				headers: { Cookie: `session=${session}` },
			});
			const { works: owned } = (await listing.json()) as {
				works: { title: string; sourceKey: string | null }[];
			};
			return owned.find((w) => w.title === title)?.sourceKey ?? null;
		})
		.toBeTruthy();
});
