// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's Edit page is the Work as a reader sees it, with what they see editable in place
 * (Parker, 2026-09-17), and one explicit Save that leaves the creator on the page.
 *
 * What these pin, each of which a form beside the Work would get wrong without anything failing:
 *
 *   - **The Work itself is on the page**, drawn by the reader's own parts. A processed video
 *     plays in the reader's player rather than appearing as a file name in a form.
 *   - **Loading is not an unsaved change.** The page learns things after it loads (the creator's
 *     Badge rungs, the file's processing), and a Save bar that appears on arrival is a page
 *     that cannot be trusted to mean it.
 *   - **Save stays, and Discard puts back what is saved.**
 *   - **The reader's view and the Edit page lead to each other.**
 *
 * Runs on `media_fixture`, whose Works nothing else resets, and whose seeded video is a real
 * processed file. Works made here are titled with this spec's prefix and swept in `afterAll`.
 */
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Edit walk ";
const STEM = `${TITLE_PREFIX}${Date.now()}`;
const FIXTURE_VIDEO = "A short film that really plays";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
	description: string;
}

let session = "";

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

// 🚨 **Serial, because the sweep is by title prefix.** Run in parallel workers, the first walk's
// `afterAll` deleted the second walk's Work between its save and its reload, which read as the
// save having lost the Work. `work-upload.authed.e2e.ts` met the same thing first.
test.describe.configure({ mode: "serial" });

// In `afterAll`, so a walk that fails halfway still takes its Work back.
test.afterAll(async () => {
	if (!session) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});

test("a Work's Edit page shows the Work as a reader sees it", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	const [video] = (await ownWorks()).filter((w) => w.title === FIXTURE_VIDEO);
	expect(video, "the media fixture's video is missing").toBeTruthy();

	await page.goto(`/studio/works/${video.publicId}/edit`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(FIXTURE_VIDEO);
	// The reader's player, not a file name standing in for it.
	await expect(page.locator("video")).toHaveCount(1);
	await expect(page.getByRole("heading", { name: "Only you see these" })).toBeVisible();

	// Nothing has been changed, so nothing is offered to save. Asked once everything the page
	// learns after it loads has arrived, which the Badge rungs are the last of.
	await page.waitForLoadState("networkidle");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);

	// The released Work's listing, as its record on the network. Followed rather than only found,
	// because a link built wrongly still renders: the seed wrote this record to the session's own
	// network, and the link has to reach exactly that record on the creator's own server.
	const record = page.getByRole("link", { name: "View the record" });
	const href = (await record.getAttribute("href")) ?? "";
	expect(href).toContain("/xrpc/com.atproto.repo.getRecord?");
	const fetched = (await (await fetch(href)).json()) as {
		uri?: string;
		value?: { $type?: string };
	};
	expect(fetched.value?.$type).toBe("org.anthers.work");
	// And it is the creator's alone: a signed-out read of the same Work carries no such field.
	const asStranger = (await (
		await fetch(`${API_URL}/api/content/works/${video.publicId}`)
	).json()) as { work?: Record<string, unknown> };
	expect(asStranger.work && "recordUrl" in asStranger.work).toBe(false);

	// The reader's view, and back again from it.
	await page.getByRole("link", { name: "Preview as a reader" }).click();
	await expect(page).toHaveURL(/\/works\/[^/?]+\?previewAs=out$/);
	await expect(page.getByText("Previewing as a reader")).toBeVisible();
	await page.getByRole("link", { name: "Edit This Work" }).click();
	await expect(page).toHaveURL(new RegExp(`/studio/works/${video.publicId}/edit$`));
});

test("saving stays on the page, and Discard puts back what is saved", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "video", title: STEM }),
	});
	const { work } = (await created.json()) as { work: { publicId: number } };
	const editUrl = new RegExp(`/studio/works/${work.publicId}/edit$`);

	await page.goto(`/studio/works/${work.publicId}/edit`);
	const title = page.getByRole("textbox", { name: "Title" });
	const description = page.getByRole("textbox", { name: "Description" });
	const unsaved = page.getByText("Unsaved changes");
	await expect(title).toHaveValue(STEM);
	await expect(unsaved).toHaveCount(0);

	// ── Discard ──
	await title.fill(`${STEM} renamed`);
	await expect(unsaved).toBeVisible();
	await page.getByRole("button", { name: "Discard" }).click();
	await expect(title).toHaveValue(STEM);
	await expect(unsaved).toHaveCount(0);

	// ── Save ──
	await description.fill("Written on the Work's own page.");
	await expect(unsaved).toBeVisible();
	await page.getByRole("button", { name: /save work/i }).click();
	// ⚠️ Anchored, because a string filter is a case-insensitive substring and "Unsaved changes"
	// contains "saved": unanchored, this passed before the save had even been sent.
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
	await expect(page).toHaveURL(editUrl);
	await expect(unsaved).toHaveCount(0);

	// And it is what the server holds, not only what the page shows.
	const [stored] = (await ownWorks()).filter((w) => w.title === STEM);
	expect(stored.description).toBe("Written on the Work's own page.");
	await page.reload();
	await expect(description).toHaveValue("Written on the Work's own page.");
});

/**
 * A piece of writing is made from a title, written on its own page, and reads as an article.
 *
 * ⭐ **The typography is the design, so the walk asserts it.** What tells a text Work apart from
 * a post is the reading experience (Parker, 2026-09-11): a text serif for the body and the
 * description set as a standfirst under the headline. A walk that only found the words would pass
 * with the article rendered as a post's prose block, which is the one thing this kind must not be.
 */
test("a piece of writing is written on its page and reads as an article", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const title = `${STEM} writing`;

	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("text");
	await page.getByPlaceholder("Work title").fill(title);
	await page.getByRole("button", { name: "Create Work" }).click();
	await expect(page).toHaveURL(/\/studio\/works\/\d+\/edit$/);

	// Rated, and still not releasable, because there is nothing in it yet (`text_missing`).
	await page.getByRole("button", { name: 'Mark the Rest "Not in It"' }).click();
	const released = page.getByRole("checkbox", { name: /released to my public catalog/i });
	await expect(released).toBeDisabled();

	await page.getByRole("textbox", { name: "Description" }).fill("A standfirst for the walk.");
	await page.locator(".tiptap").click();
	await page.keyboard.type("The first hard frost came early this year.");
	await expect(released).toBeEnabled();
	await released.check();
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();

	const [work] = (await ownWorks()).filter((w) => w.title === title);
	await page.goto(`/works/${work.publicId}`);
	const article = page.locator("article").filter({ hasText: "The first hard frost" });
	await expect(article).toBeVisible();
	expect(await article.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Spectral");
	// The standfirst sits above the body, under the headline, rather than after the Work.
	const standfirst = page.getByText("A standfirst for the walk.");
	const [above, below] = await Promise.all([standfirst.boundingBox(), article.boundingBox()]);
	expect(above && below && above.y < below.y).toBe(true);
});
