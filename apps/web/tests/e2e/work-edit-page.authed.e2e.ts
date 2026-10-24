// SPDX-License-Identifier: Apache-2.0
/**
 * A video Work's editing surface, on the Work's own page (Parker, 2026-10-13) — the Work
 * rendered by the user's own parts, editable in place, its fields each saving themselves.
 *
 * What these pin, each of which a form beside the Work would get wrong without anything failing:
 *
 *   - **The Work itself is on the page**, drawn by the user's own parts. A processed video
 *     plays in the user's player rather than appearing as a file name in a form.
 *   - **Loading is not a save**: with the per-field model there is no page-wide bar to lie.
 *   - **A field saves itself alone, and Cancel puts back what is saved.**
 *   - **The user's view and the editing surface lead to each other** — the Studio route
 *     redirects to the page, and the preview's Edit button comes back.
 *
 * Runs on `media_fixture`, whose Works nothing else resets, and whose seeded video is a real
 * processed file. Works made here are titled with this spec's prefix and swept in `afterAll`.
 */
import {
	API_URL,
	createDraftWork,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE_PREFIX = "Edit walk ";
const STEM = `${TITLE_PREFIX}${Date.now()}`;
const FIXTURE_VIDEO = "A short film that really plays";
const FIXTURE_COMIC = "A comic that really turns";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
	description: string;
	tags?: string[] | null;
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

/**
 * The media fixture video's tags before this spec borrowed it to seed a popularity count.
 * Restored in `afterAll`, because the fixture is shared with every other walk.
 */
let fixtureTagsBefore: { id: number; tags: string[] } | null = null;

async function patchTags(id: number, tags: string[]) {
	const res = await fetch(`${API_URL}/api/content/works/${id}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ tags }),
	});
	expect(res.ok, `patching tags on Work ${id} should answer 200`).toBe(true);
}

// In `afterAll`, so a walk that fails halfway still takes its Work back.
test.afterAll(async () => {
	if (!session) return;
	if (fixtureTagsBefore) await patchTags(fixtureTagsBefore.id, fixtureTagsBefore.tags);
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});

/**
 * A video's editing surface is the Work's own page (Parker, 2026-10-13): the Studio route
 * redirects there, the editing banner is the mode, the work's player is on the page, and
 * the user's view and it lead to each other.
 */
test("a video's editing surface is its own page, and the two lead to each other", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const [video] = (await ownWorks()).filter((w) => w.title === FIXTURE_VIDEO);
	expect(video, "the media fixture's video is missing").toBeTruthy();

	// The Studio route REDIRECTS: the creator lands on the Work's own page, in editor mode.
	await page.goto(`/studio/works/${video.publicId}/edit`);
	await expect(page).toHaveURL(/\/works\/[^/?]+$/);
	// The editing banner is gone (the View As task, 2026-10-16): the editor mode is
	// what the page is, and the View As row on the Manage tab is its one marker.
	await expect(page.getByRole("group", { name: "View this Work as" })).toBeVisible();
	// The Work itself, the player — the same page a user is drawn.
	await expect(page.locator("video")).toHaveCount(1);

	// Loading is not a save anywhere: with per-field saves there is no page-wide bar at all.
	await page.waitForLoadState("networkidle");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);

	// The released Work's listing, as its record link. Followed rather than only found,
	// because a link built wrongly still renders: the link is the record's own address on
	// Taproot (Parker, 2026-10-10), and it is a pure function of the stored `at://` address —
	// so the walk pins it to exactly that, then proves the record it names is real by reading
	// it back from the session's own network the way Anthers itself reads a record raw
	// (`recordFetchUrlFor`, getRecord on the repository it lives in).
	const record = page.getByRole("link", { name: "View the raw ATProto record on Taproot" });
	const href = (await record.getAttribute("href")) ?? "";
	const [owner] = (await ownWorks()).filter((w) => w.title === FIXTURE_VIDEO) as (OwnedWork & {
		atprotoUri?: string | null;
	})[];
	expect(owner?.atprotoUri, "the media fixture's video carries its listing address").toBeTruthy();
	expect(href, "the link is the stored address itself, pointed at Taproot").toBe(
		`https://atproto.at/uri/${owner?.atprotoUri}`,
	);
	const pds = process.env.ATPROTO_TEST_PDS;
	expect(pds, "the browser session names its own AT Protocol network").toBeTruthy();
	const [did, collection, rkey] = (owner?.atprotoUri ?? "").replace("at://", "").split("/");
	const readBackRes = await fetch(
		`${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`,
	);
	const readBackBody = await readBackRes.text();
	const readBack = JSON.parse(readBackBody) as { value?: { $type?: string } };
	expect(
		readBack.value?.$type,
		`getRecord answered ${readBackRes.status} for ${owner?.atprotoUri}: ${readBackBody.slice(0, 300)}`,
	).toBe("org.anthers.work");
	// And it is every reader's: a signed-out read of the same Work carries the same record
	// link the owner's shape carries — no longer the creator's alone.
	const asStranger = (await (
		await fetch(`${API_URL}/api/content/works/${video.publicId}`)
	).json()) as { work?: { recordUrl?: string | null } };
	expect(asStranger.work?.recordUrl).toBe(`https://atproto.at/uri/${owner?.atprotoUri}`);

	// The user's view, and back again from it — by way of the View As row's modes, and
	// its Creator button leaving the preview (the page does not round a Studio redirect).
	await page.getByRole("button", { name: "Signed-Out" }).click();
	await expect(page).toHaveURL(/\/works\/[^/?]+\?previewAs=out$/);
	await expect(
		page.getByRole("link", { name: "View the raw ATProto record on Taproot" }),
	).toBeVisible();
	// The row stays on the Manage tab in the preview too (Parker, 2026-10-17): the
	// modes do not jump to the page's top when one takes — the owner's copy of the
	// user's Record carries the same first tab the editor's does, so the buttons
	// that switched the mode are where they were, and that is where the way back is.
	await expect(
		page.locator("#work-side-manage").getByRole("group", { name: "View this Work as" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Creator", exact: true }).click();
	await expect(page).toHaveURL(/\/works\/[^/?]+$/);
	await expect(page.getByRole("group", { name: "View this Work as" })).toBeVisible();
});

test("a field saves itself alone, and Cancel puts back what is saved", async ({
	page,
	context,
}) => {
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

	await page.goto(`/studio/works/${work.publicId}/edit`);
	// The Studio route redirected; the page under test is the Work's own.
	await expect(page).toHaveURL(/\/works\/[^/?]+$/);
	// The editing banner is gone (the View As task, 2026-10-16): the editor mode is
	// what the page is, and the View As row on the Manage tab is its one marker.
	await expect(page.getByRole("group", { name: "View this Work as" })).toBeVisible();

	// The title alone is centered, with its pencil hanging off the text's top-right corner
	// (Parker, 2026-10-19): centering the two as a group is what pulled the title off the
	// page's center, which no save, cancel or reload would ever catch.
	const titleHeading = page.locator("h1").filter({ hasText: STEM });
	const titleEdit = page.getByRole("button", { name: "Edit Title" });
	const byline = titleHeading.locator("xpath=ancestor::header[1]");
	const [headingBox, pencilBox, bylineBox] = await Promise.all([
		titleHeading.boundingBox(),
		titleEdit.boundingBox(),
		byline.boundingBox(),
	]);
	expect(
		headingBox && pencilBox && bylineBox,
		"the title, its pencil and the byline are all drawn",
	).toBeTruthy();
	expect(
		Math.abs(headingBox!.x + headingBox!.width / 2 - (bylineBox!.x + bylineBox!.width / 2)),
		"the title text itself is what the page centers",
	).toBeLessThanOrEqual(2);
	expect(
		pencilBox!.x,
		"the pencil is off the title's right edge, not inside the centered group",
	).toBeGreaterThanOrEqual(headingBox!.x + headingBox!.width - 1);
	expect(
		Math.abs(pencilBox!.y - headingBox!.y),
		"the pencil sits at the title's top",
	).toBeLessThanOrEqual(8);

	// The title field, opened: the pencil opens, the X cancels, the check saves.
	await page.getByRole("button", { name: "Edit Title" }).click();
	const title = page.getByRole("textbox", { name: "Title" });
	await expect(title).toHaveValue(STEM);

	// ── Cancel ──
	await title.fill(`${STEM} renamed`);
	await page.getByRole("button", { name: "Cancel editing Title" }).click();
	await expect(
		page.locator("h1").filter({ hasText: STEM }),
		"cancel did not put back what is saved",
	).toBeVisible();

	// ── Save, and the page stays where it is ──
	await page.getByRole("button", { name: "Edit Title" }).click();
	await title.fill(`${STEM} renamed`);
	await page.getByRole("button", { name: "Save Title" }).click();
	await expect(page.locator("h1").filter({ hasText: `${STEM} renamed` })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);

	// And it is what the server holds, not only what the page shows.
	const [stored] = (await ownWorks()).filter((w) => w.title === `${STEM} renamed`);
	expect(stored, "the renamed Work is the row the server holds").toBeTruthy();

	// A reload reads the same, because it is the row's own state.
	await page.reload();
	await expect(page.locator("h1").filter({ hasText: `${STEM} renamed` })).toBeVisible();
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

	const draft = await createDraftWork(page, { type: "text", title });
	await page.goto(draft.url);
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	// Rated, on its own grid, on the Work's page — and still not releasable, because
	// there is nothing in it yet (`text_missing`).
	await page.getByRole("tab", { name: "Rating" }).click();
	// The tab IS the table, always open (Parker, 2026-10-16); the None heading answers
	// every row at once, which is what Mark the Rest used to do for the unanswered ones.
	await page
		.getByRole("tabpanel", { name: "Rating" })
		.locator("table")
		.getByRole("button", { name: "None", exact: true })
		.click();
	await page.getByRole("button", { name: "Save Rating" }).click();
	const released = page.getByRole("checkbox", { name: /released to my public catalog/i });

	// And not releasable until a human is credited either (`credits_creator_required`):
	// one credit row with its Created box ticked, naming the writer. The field lives in
	// the Credits tab; its save adopts the row like every other.
	await page.getByRole("tab", { name: "Credits" }).click();
	await page.getByRole("button", { name: "Edit Credits" }).click();
	await page.getByRole("button", { name: "Add a credit" }).click();
	await page.getByRole("textbox", { name: "Credit 1 role" }).fill("Written by");
	await page.getByRole("checkbox", { name: "Credit 1 Created" }).check();
	const contributor = page.getByRole("textbox", { name: "Credit 1 contributors" });
	await contributor.fill("The Walker");
	await contributor.press("Enter");
	await page.getByRole("button", { name: "Save Credits" }).click();
	await page.getByRole("tab", { name: "Details" }).click();
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(released).toBeDisabled();

	// The standfirst is the Description field, edited in the Details tab where a user
	// reads it as a line of the record.
	await page.getByRole("button", { name: "Cancel editing Release" }).click();
	await page.getByRole("button", { name: "Edit Description" }).click();
	await page.getByPlaceholder("Describe this Work…").fill("A standfirst for the walk.");
	await page.getByRole("button", { name: "Save Description" }).click();

	// And a piece of writing is its body, written in the Manage tab in the typography
	// the read prints.
	await page.getByRole("tab", { name: /Manage/ }).click();
	await page.getByRole("button", { name: "Edit Body" }).click();
	await page.locator(".tiptap").click();
	await page.keyboard.type("The first hard frost came early this year.");
	await page.getByRole("button", { name: "Save Body" }).click();

	// The release walk returns to the Details tab, where the release field lives.
	await page.getByRole("tab", { name: "Details" }).click();
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(released).toBeEnabled();
	await released.check();
	await page.getByRole("button", { name: "Save Release" }).click();

	// Where the writing is, is the page: the article in the deliverable's reading
	// measure, the standfirst above it — the body's save adopted the row in place, so
	// the same page that took the words now shows them set.
	const article = page.locator("article").filter({ hasText: "The first hard frost" });
	await expect(article).toBeVisible({ timeout: 15_000 });
	expect(await article.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Spectral");
	// The standfirst sits above the body, under the headline, rather than after the Work.
	// The description rides in both places now (Parker, 2026-10-14), so the first of the
	// two is the one above the article — the deliverable's, which the record follows.
	const standfirst = page.getByText("A standfirst for the walk.").first();
	const [above, below] = await Promise.all([standfirst.boundingBox(), article.boundingBox()]);
	expect(above && below && above.y < below.y).toBe(true);
});

test("a comic's media manager carries Thumbnail before Pages", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	const [comic] = (await ownWorks()).filter((w) => w.title === FIXTURE_COMIC);
	expect(comic, "the media fixture's comic is missing").toBeTruthy();
	if (!comic) return;

	await page.goto(`/studio/works/${comic.publicId}/edit`);
	// Manage is the tab the creator lands on, and the View As row is still its first fact;
	// the thumbnail and the pages are the media manager's sections now (Parker, 2026-10-23).
	await expect(page.getByRole("heading", { name: "View As" })).toBeVisible();
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	const sections = page.getByRole("tablist", { name: "Media management sections" });
	// The order is the tab strip's: delivery first, the medium's own sections after it, and
	// Pages only for the paged kinds, immediately before the version history.
	await expect(sections.getByRole("tab")).toHaveText([
		"Delivery",
		"Source",
		"Thumbnail",
		"Pages",
		"Versions",
	]);
});

/**
 * Tags are added and changed in the Details tab, below the description.
 *
 * The things a form-only build would get wrong are the point: an existing tag shows how
 * many Works use it, a tag nobody has used is still a choice the creator may make (the
 * button says so), and the list is editable after saving rather than a create-time field.
 */
test("a Work's tags are added and removed from the Details tab", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	const title = `${STEM} tagged`;
	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "text", title }),
	});
	const { work } = (await created.json()) as { work: { publicId: number } };
	const suffix = Date.now().toString(36);
	// An existing tag needs a released Work carrying it — the media fixture's video is one.
	// Borrowing it makes the directory's count real rather than a stubbed number, and
	// `afterAll` puts its tags back.
	const existing = `walk-existing-${suffix}`;
	const [video] = (await ownWorks()).filter((w) => w.title === FIXTURE_VIDEO);
	expect(video, "the media fixture's video is missing").toBeTruthy();
	if (!video) return;
	fixtureTagsBefore = { id: video.id, tags: video.tags ?? [] };
	await patchTags(video.id, [...(video.tags ?? []), existing]);
	// Unique enough that the "no Work uses it yet" row is true in this session's directory.
	const fresh = `walk-new-${suffix}`;
	expect(fresh).not.toBe(existing);

	await page.goto(`/studio/works/${work.publicId}/edit`);
	await page.getByRole("button", { name: "Edit Tags" }).click();
	const input = page.getByPlaceholder("Search tags, or type a new one…");

	// The existing tag is offered with the count behind it.
	await input.fill(existing);
	const suggestion = page.getByRole("button", { name: new RegExp(`${existing}.*1 work`) });
	await expect(suggestion).toBeVisible();
	await suggestion.click();

	// A tag nobody uses yet says so, and can still be added.
	await input.fill(fresh);
	await page.getByRole("button", { name: new RegExp(`Use “${fresh}”`) }).click();
	await page.getByRole("button", { name: "Save Tags" }).click();

	// The read view is the chips, and the server holds the same list.
	const details = page.getByRole("tabpanel", { name: "Details" });
	await expect(details.getByText(existing, { exact: true })).toBeVisible();
	await expect(details.getByText(fresh, { exact: true })).toBeVisible();
	await page.reload();
	await expect(details.getByText(existing, { exact: true })).toBeVisible();
	const [stored] = (await ownWorks()).filter((w) => w.title === title);
	expect(stored?.tags).toEqual([existing, fresh]);

	// A Work's tags change at any time: remove both from the same field.
	await page.getByRole("button", { name: "Edit Tags" }).click();
	await page.getByRole("button", { name: `Remove tag ${existing}` }).click();
	await page.getByRole("button", { name: `Remove tag ${fresh}` }).click();
	await page.getByRole("button", { name: "Save Tags" }).click();
	await expect(details.getByText(existing, { exact: true })).toHaveCount(0);
	const [cleared] = (await ownWorks()).filter((w) => w.title === title);
	expect(cleared?.tags).toEqual([]);
});

test("the creator's own comic page renders the book, not the no-pages placeholder", async ({
	page,
	context,
}) => {
	// The owner's Work page goes through a different serializer from a reader's, and it
	// used to omit the page and section counts the readers branch on. The result was the
	// creator seeing "This book has no pages yet" on a Work everyone else could read.
	session = await signInAsMediaFixture(context);
	const [comic] = (await ownWorks()).filter((w) => w.title === FIXTURE_COMIC);
	expect(comic, "the media fixture's comic is missing").toBeTruthy();
	if (!comic) return;

	await page.goto(`/studio/works/${comic.publicId}/edit`);
	await expect(page.locator(`[aria-label='Comic reader: ${FIXTURE_COMIC}']`)).toBeVisible();
	await expect(page.getByText("This book has no pages yet")).toHaveCount(0);
});
