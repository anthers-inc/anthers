// SPDX-License-Identifier: Apache-2.0
/**
 * Drafting a Work with no file, and changing its kind on the fly.
 *
 * 🚨 **The assertion worth the spec is the absence of a gate.** The old Upload page refused to
 * create until a file was picked, which meant a failed upload or a not-yet-rendered file cost
 * the creator every word typed beside it (Parker, 2026-10-10). The New Work flow creates the
 * draft at its type step; this walk creates one through the same API route, lands on the
 * Work's own page — the editing surface every kind shares (the kinds pass, 2026-10-14) —
 * changes the kind there, which saves at once, and asks the server at the end what actually
 * stood. It also guards both halves of the composition:
 * - the fileless Work cannot be released (`media_missing`), so a draft is still not a publish;
 * - the kind change carried the save, which is the server's rating reset and the page's
 *   restructure agreeing with each other.
 *
 * Runs in the `authed` project on `media_fixture`, which nothing else resets — see
 * `signInAsMediaFixture` in `fixtures.ts`. The flow itself has its own walk; this one is about
 * the page and the kind change.
 */
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	API_URL,
	createDraftWork,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

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

	const draft = await createDraftWork(page, { type: "comic", title: TITLE });
	await page.goto(draft.url);

	// The Work's OWN page — the editing surface for every kind (the kinds pass,
	// 2026-10-14) — with the deliverable's silhouette and the set editor now in the
	// empty media card (the media-area task, 2026-10-23).
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	await expect(page.getByText(/the pages open here/i)).toBeVisible();
	const box = page.getByRole("status").filter({ hasText: /the pages open here/i });
	await expect(box.getByRole("button", { name: /drop page images/i })).toBeVisible();
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

test("a fileless audio draft picks its file from the empty media card", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);

	const title = `${TITLE} audio`;
	const draft = await createDraftWork(page, { type: "audio", title });
	await page.goto(draft.url);
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	// The empty card is the intake now (Parker, 2026-10-23): its dropper is where a
	// fileless audio Work picks its source, the same way a video's does.
	const box = page.getByRole("status").filter({ hasText: /the player starts here/i });
	await expect(box).toBeVisible();
	const picker = box.getByRole("button", { name: /drop an audio file or click to browse/i });
	await expect(picker).toBeVisible();
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
