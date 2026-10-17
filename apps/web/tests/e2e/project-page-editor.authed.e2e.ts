// SPDX-License-Identifier: Apache-2.0
/**
 * **The Project page, which is its own editor** (the unified-editor pass, 2026-10-17):
 * the creator visits the public URL and finds the working page — the fields pencilled,
 * the shelves below with their sort modes and their multi-select picker — while anyone
 * else reaches the plain rendering, because only the owner reads a draft's URL at all.
 *
 * The API suite carries the endpoint rules (draft 404s, whole-order reorder, the shelf
 * conferring no access); this walk proves the page's behavior on top of them: that a
 * non-manual sort is a view and never writes, that drag belongs to Manual, and that the
 * picker's confirm adds everything ticked in one act.
 *
 * Runs on `media_fixture`, which carries payout setup (publishing takes it). Serial,
 * because the suite builds one Project across its tests and cleans up by slug and by
 * the works it made; those titles are prefixed so the gauntlet's own rows are never
 * mistaken for them.
 */
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { gauntletHandle } from "@anthers/db/gauntlet";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const now = Date.now();
const SLUG = `pp-editor-${now}`;
const TITLE_PREFIX = "Project editor walk work ";

interface Made {
	id: number;
	title: string;
	publicId: number;
}

let session = "";
let handle = "";
/** The works this walk made, deleted in the cleanup — the fixture's catalog is shared. */
const created: Made[] = [];

const authed = async () => ({
	"Content-Type": "application/json",
	Origin: WEB_ORIGIN,
	Cookie: `session=${session}`,
});

/**
 * Make a Work: released, or a draft. Text needs no file, so the release chain is the
 * rating, a created credit and an everyone row — the same shape the basket specs use.
 * An original release date rides when given; the `original` sort mode's own subject.
 */
async function makeWork(title: string, released: boolean, originallyReleased?: string) {
	const made = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: await authed(),
		body: JSON.stringify({ type: "text", title, bodyHtml: `<p>${title}</p>` }),
	});
	expect(made.status, `creating ${title} failed`).toBe(201);
	const { work } = (await made.json()) as { work: Made };
	if (released) {
		const patched = await fetch(`${API_URL}/api/content/works/${work.id}`, {
			method: "PATCH",
			headers: await authed(),
			body: JSON.stringify({
				visibility: "released",
				access: [{ threshold: 0, allow: true, price: "0" }],
				maturityRows: rowsRatedAs("general"),
				credits: [
					{ role: "Made by", contributor: handle || "Media Fixture", types: ["created"] },
				],
				...(originallyReleased ? { originallyReleased } : {}),
			}),
		});
		expect(patched.ok, `releasing ${title} failed: ${patched.status} ${await patched.text()}`).toBe(
			true,
		);
	}
	created.unshift(work);
	return work;
}

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
	if (!session) return;
	await fetch(`${API_URL}/api/content/projects/${SLUG}`, {
		method: "DELETE",
		headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
	});
	// The fixture's catalog is shared by every suite in this project (needsMedia): the
	// works this walk made have no business staying in it.
	for (const work of created) {
		await fetch(`${API_URL}/api/content/works/${work.id}`, {
			method: "DELETE",
			headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
		});
	}
});

/** The Works shelf's list, by its own role and name. */
function shelfRows(page: import("@playwright/test").Page) {
	return page.getByRole("list", { name: "Works on this Project" });
}

test("the editor is the page: the creator finds the shelves, the sort and the pencil there", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	handle = await gauntletHandle(API_URL, MEDIA_FIXTURE_USERNAME);

	// Deliberately added in an order that alphabetically reverses: manual order reads
	// [Zulu…, Bravo…]; alphabetical ascending reads [Bravo…, Zulu…]. A view that wrote
	// would not survive returning to Manual, which the third test reads back.
	const zulu = await makeWork(`${TITLE_PREFIX} Zulu`, true);
	// The API takes a full datetime; the editor sends midnight UTC for a date-only claim.
	await makeWork(`${TITLE_PREFIX} Bravo`, true, "1999-01-01T00:00:00.000Z");
	await makeWork(`${TITLE_PREFIX} Delta draft`, false);

	const made = await fetch(`${API_URL}/api/content/projects`, {
		method: "POST",
		headers: await authed(),
		body: JSON.stringify({ title: "Project editor walk", slug: SLUG, isPublished: false }),
	});
	expect(made.status).toBe(201);
	void zulu;

	await page.goto(`/@${handle}/${SLUG}`);
	await expect(page).toHaveURL(new RegExp(`/@[^/]+/${SLUG}$`));

	// The editor's marks, on the page a user reads: View As, the pencil, the shelves.
	await expect(page.getByRole("heading", { name: "View As" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Edit Title" })).toHaveCount(1);
	await expect(page.getByRole("heading", { name: "Works" })).toBeVisible();
	await expect(
		page.getByText("No Works yet. A Project is a shelf", { exact: false }),
	).toBeVisible();

	// The sort's controls: Manual is the default and the direction pair is greyed out —
	// visible, disabled — so the shape holds across modes.
	const sortSelect = page.getByLabel("Sort the works");
	const direction = page.getByLabel("Works sort direction");
	await expect(sortSelect).toHaveValue("manual");
	await expect(direction).toBeDisabled();
	await expect(direction).toBeVisible();
});

test("the multi-select picker adds everything ticked, in one act", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	await page.goto(`/@${handle}/${SLUG}`);

	const zulu = `${TITLE_PREFIX} Zulu`;
	const bravo = `${TITLE_PREFIX} Bravo`;
	await page.getByRole("button", { name: "Add a Work" }).click();
	await expect(page.getByRole("heading", { name: "Add Works" })).toBeVisible();
	const confirm = page.getByRole("button", { name: "Add Work(s)" });
	await expect(confirm).toBeDisabled();

	// Tick two rows — clicked, as the rows are the toggle now.
	for (const title of [zulu, bravo]) {
		await page.getByLabel(`Select ${title}`).click();
	}
	await expect(confirm).toBeEnabled();
	// Untick the SECOND row and retick it — the toggle has to toggle, and the count
	// follows. (Reticking Bravo keeps Zulu first in the picked order, so the adds — and
	// thus the shelf's Manual order — read [Zulu, Bravo], the reverse of Alphabetical.)
	await page.getByLabel(`Select ${bravo}`).click();
	await expect(page.getByText("1 selected")).toBeVisible();
	await page.getByLabel(`Select ${bravo}`).click();
	await expect(page.getByText("2 selected")).toBeVisible();

	await confirm.click();
	await expect(page.getByRole("heading", { name: "Add Works" })).toHaveCount(0);
	await expect(shelfRows(page)).toContainText(zulu);
	await expect(shelfRows(page)).toContainText(bravo);

	// Already-shelved Works are offered nowhere — reopen, and the row is not there.
	await page.getByRole("button", { name: "Add a Work" }).click();
	await expect(page.getByLabel(`Select ${zulu}`)).toHaveCount(0);
	await page.getByRole("button", { name: "Close" }).first().click();
});

test("a non-manual sort is a view: no write, no drag, and Manual gives the stored order back", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await page.goto(`/@${handle}/${SLUG}`);

	const zulu = `${TITLE_PREFIX} Zulu`;
	const bravo = `${TITLE_PREFIX} Bravo`;
	const sortSelect = page.getByLabel("Sort the works");
	const direction = page.getByLabel("Works sort direction");
	const rows = shelfRows(page).locator("li .truncate");

	// Manual first: two rows, in the order the adds went in — the stored order.
	await expect(direction).toBeDisabled();
	await expect(rows).toHaveText([zulu, bravo]);

	// Switch to Alphabetical ascending: the view re-orders, the direction pair enables,
	// and the grips stop dragging — a view is not an arrangement.
	await sortSelect.selectOption("title");
	await expect(direction).toBeEnabled();
	const grips = shelfRows(page).locator("span.cursor-grab");
	await expect(grips).toHaveCount(0);
	await expect(rows).toHaveText([bravo, zulu]);

	// Back to Manual: the stored order returns as it was, unsorted by the view — the
	// sorted view wrote nothing. The handle sits on the rows again.
	await sortSelect.selectOption("manual");
	await expect(rows).toHaveText([zulu, bravo]);
	await expect(grips).toHaveCount(2);
	await expect(direction).toBeDisabled();
});

test("a stranger reaching the URL sees the project, and none of the editor", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	// Publish — the payout gate sits behind the media fixture. The draft's page was the
	// owner test above's; a visitor needs the published row.
	const published = await fetch(`${API_URL}/api/content/projects/${SLUG}`, {
		method: "PATCH",
		headers: await authed(),
		body: JSON.stringify({ isPublished: true }),
	});
	expect(published.ok, `publishing failed: ${published.status} ${await published.text()}`).toBe(
		true,
	);

	// A signed-out browser: this test's own page, after the context's cookies clear —
	// the authed project's storageState is the walker's, who is not the creator either.
	await context.clearCookies();
	await page.goto(`/@${handle}/${SLUG}`);
	await expect(page.getByRole("heading", { name: "View As" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Add a Work" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit Title" })).toHaveCount(0);
	// The released members render; the draft member does not.
	await expect(page.getByText(`${TITLE_PREFIX} Zulu`).first()).toBeVisible();
	await expect(page.getByText(`${TITLE_PREFIX} Delta draft`)).toHaveCount(0);
});