// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's Projects table, walked in a browser: tall rows carrying the project block
 * (header image, title, description) and a grid of the works it holds, with the filters
 * registered below the Studio nav — the Works table's walk's twin
 * (`studio-works-table.authed.e2e.ts`).
 *
 * What only a browser can prove is the join the page depends on: the works grid reads
 * `worksSummary`, which rides the owner listing and only the owner listing — the server
 * suite asserts the serialization, and this walk proves the page renders it and that a
 * project with no works says so rather than an empty grid wearing a broken page.
 *
 * Runs on `media_fixture`, which has payouts set up (a published project takes them) and
 * which nothing else resets. Serial, because the cleanup below is by slug prefix.
 */
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Project table walk ";
const now = Date.now();
const PUBLISHED_SLUG = `project-table-published-${now}`;
const DRAFT_SLUG = `project-table-draft-${now}`;
const PUBLISHED_TITLE = `${TITLE_PREFIX} published`;
const DRAFT_TITLE = `${TITLE_PREFIX} draft`;

let session = "";

async function sessioned() {
	return { "Content-Type": "application/json", Origin: WEB_ORIGIN, Cookie: `session=${session}` };
}

async function makeProject(slug: string, title: string, isPublished: boolean): Promise<void> {
	const res = await fetch(`${API_URL}/api/content/projects`, {
		method: "POST",
		headers: await sessioned(),
		body: JSON.stringify({ title, slug, isPublished }),
	});
	expect(res.status).toBe(201);
}

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
	// Leave no shelf behind; the slugs are unique per run as the studio-routes walk's are.
	if (!session) return;
	for (const slug of [PUBLISHED_SLUG, DRAFT_SLUG]) {
		await fetch(`${API_URL}/api/content/projects/${slug}`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});

test("the Projects table renders tall rows that carry the project block and its state", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await makeProject(PUBLISHED_SLUG, PUBLISHED_TITLE, true);
	await makeProject(DRAFT_SLUG, DRAFT_TITLE, false);

	await page.goto("/studio/projects");
	await expect(page).toHaveURL(/\/studio\/projects$/);

	const publishedRow = page.locator("tbody tr").filter({ hasText: PUBLISHED_TITLE });
	const draftRow = page.locator("tbody tr").filter({ hasText: DRAFT_TITLE });
	await expect(publishedRow).toHaveCount(1);
	await expect(draftRow).toHaveCount(1);
	// Status, as the badge each row's state names.
	await expect(publishedRow).toContainText("Published");
	await expect(draftRow).toContainText("Draft");
	// Empty for now — the works cell says so rather than rendering nothing.
	await expect(publishedRow).toContainText("No Works in this Project yet.");
});

test("the sidebar carries the Projects filters below the Studio nav, and they move the rows", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await page.goto("/studio/projects");

	const aside = page.locator("aside");
	// Below the nav, in the same aside — positioned, not merely present.
	await expect(aside.getByRole("heading", { name: "Search" })).toBeVisible();
	await expect(aside.getByRole("heading", { name: "Status" })).toBeVisible();
	const navBottom = await aside
		.getByRole("navigation", { name: "Studio", exact: true })
		.evaluate((el) => el.getBoundingClientRect().bottom);
	const filtersTop = await aside
		.getByRole("heading", { name: "Search" })
		.evaluate((el) => el.getBoundingClientRect().top);
	expect(filtersTop).toBeGreaterThan(navBottom);

	// Status narrows to the published row; the draft's row disappears with it.
	await aside.getByRole("button", { name: "Published", exact: true }).click();
	await expect(page).toHaveURL(/status=published/);
	await expect(page.locator("tbody tr").filter({ hasText: DRAFT_TITLE })).toHaveCount(0);

	// And the URL is the shareable state — a fresh navigation onto it shows the same.
	await page.goto(`/studio/projects?status=published&q=${encodeURIComponent(TITLE_PREFIX)}`);
	await expect(page.locator("tbody tr").filter({ hasText: PUBLISHED_TITLE })).toBeVisible();
	await expect(page.locator("tbody tr").filter({ hasText: DRAFT_TITLE })).toHaveCount(0);
});

test("the works grid renders the project's summary thumbnails as a way into each Work", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	// A Work made while this run is signed in does not join a Project by itself; the
	// shelf is edit-only, and this is the assignment the Studio's shelf picker makes.
	const work = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: await sessioned(),
		body: JSON.stringify({
			type: "text",
			title: `Chapter one ${now}`,
			bodyHtml: "<p>Written for the projects-table walk.</p>",
		}),
	});
	expect(work.status).toBe(201);
	const { work: made } = (await work.json()) as { work: { id: number; publicId: number } };
	const added = await fetch(`${API_URL}/api/content/projects/${PUBLISHED_SLUG}/works`, {
		method: "POST",
		headers: await sessioned(),
		body: JSON.stringify({ workId: made.id }),
	});
	expect(added.status).toBe(201);

	await page.goto("/studio/projects");
	const publishedRow = page.locator("tbody tr").filter({ hasText: PUBLISHED_TITLE });
	// A tile carries the Work's title, and it is the way into the Work — scoped to the
	// title itself rather than a cell index, so the row's column order can move without it.
	const tile = publishedRow.getByTitle(/Chapter one/);
	await expect(tile).toHaveCount(1);
	await tile.click();
	await expect(page).toHaveURL(new RegExp(`/studio/works/${made.publicId}/edit$`));
});
