// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's Works table, walked in a browser: the table renders, the sidebar below the
 * Studio nav carries its filters, and the filters and the sort both move the rows.
 *
 * What the walk owns is the join no unit test sees: the filter sections are registered into
 * the signed-in layout's sidebar by a page inside the web-shared package, so a broken
 * registration renders the old layout silently — everything works except the place the
 * filters live. The sidebar's position (below the nav, in the same aside) is asserted
 * rather than assumed, and URL-carried params are read back, since the URL is the shareable
 * state a filtered view produces.
 *
 * Runs on `media_fixture`, which has Works of several kinds and nothing else reset.
 */
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = `Table walk ${Date.now()}`;

let session = "";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
	type: string;
}

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

async function sweep(): Promise<void> {
	if (!session) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.describe.configure({ mode: "serial" });
test.afterAll(sweep);

/** The table row for a Work, found by its unique title. */
const rowFor = (page: import("@playwright/test").Page, title: string) =>
	page.locator("tbody tr").filter({ hasText: title });

async function createWork(title: string, type: string): Promise<void> {
	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			type,
			title,
			maturityRows: rowsRatedAs("general"),
			credits: [
				{
					types: ["created"],
					role: "Made by",
					contributor: "media_fixture",
				},
			],
		}),
	});
	expect(created.status).toBe(201);
}

test("the Works table renders with its filters in the sidebar, below the Studio nav", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await sweep();

	const title = `${TITLE_PREFIX} a`;
	await createWork(title, "video");

	await page.goto("/studio/works");
	const aside = page.locator("aside");
	await expect(aside.getByRole("heading", { name: "Search" })).toBeVisible();
	await expect(aside.getByRole("heading", { name: "Visibility" })).toBeVisible();
	await expect(aside.getByRole("heading", { name: "Work Type" })).toBeVisible();

	// Below the nav, not above it — the section is a sidebar second level, and a
	// registration bug that rendered nothing would be caught by the visibility calls
	// above; this one catches a registration that rendered somewhere else.
	const navBottom = await aside
		.getByRole("navigation", { name: "Studio", exact: true })
		.evaluate((el) => el.getBoundingClientRect().bottom);
	const filtersTop = await aside
		.getByRole("heading", { name: "Search" })
		.evaluate((el) => el.getBoundingClientRect().top);
	expect(filtersTop).toBeGreaterThan(navBottom);

	await expect(page.locator("tbody tr")).not.toHaveCount(0);
	await expect(rowFor(page, title)).toHaveCount(1);
	// Unreleased by birth — the row's visibility cell says so in words.
	await expect(rowFor(page, title)).toContainText("Private");
});

test("the sidebar filters move the rows and ride the URL", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	const title = `${TITLE_PREFIX} filterable`;
	// One Work kind the fixture account never carries outside this run: "service" appears
	// in the filter list only because this row exists, so picking it isolates exactly one.
	await createWork(title, "service");

	await page.goto("/studio/works");

	// Search narrows to the one row; then a search naming nothing narrows to the
	// filtered-out state, whose remedy is a button rather than an upload.
	await page.getByRole("textbox", { name: /filter by title/i }).fill("nothing-matches-this-xyzzy");
	await expect(page.getByText("No Works match these filters.")).toBeVisible();
	await page.getByRole("button", { name: "Clear filters" }).click();
	await expect(page.locator("tbody tr").first()).toBeVisible();

	// The work-type filter isolates the one service Work this run made.
	await page.locator("aside").getByRole("button", { name: "Service", exact: true }).click();
	await expect(page).toHaveURL(/type=service/);
	await expect(page.locator("tbody tr")).toHaveCount(1);
	await expect(rowFor(page, title)).toBeVisible();

	// And the URL is the shareable state — a fresh navigation onto the filtered URL
	// shows the same single row, then the sidebar's All resets it.
	await page.goto("/studio/works?type=service");
	await expect(page.locator("tbody tr")).toHaveCount(1);
	await page.locator("aside").getByRole("button", { name: "All", exact: true }).click();
	await expect(page).not.toHaveURL(/type=/);
	await expect(rowFor(page, title)).toBeVisible();
});

test("the column headers sort, and repeat clicks flip the direction", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	await page.goto("/studio/works");

	// The default is Date, newest first — asserted as the header's own state rather than
	// a specific row on top, because which Work is newest is the fixture's business.
	const dateHeader = page.getByRole("button", { name: "Date" });
	await expect(dateHeader.locator("span")).toHaveText("↓");

	// A second column takes the same direction a user expects its data to read — views
	// high first — and then the repeat click flips it, the whole sorting UI contract.
	// The aria-sort assertions ride the clicked header's own th rather than a column
	// index, so the column order can move without them.
	const viewsHeader = page.getByRole("button", { name: "Views" });
	await viewsHeader.click();
	await expect(viewsHeader.locator("span")).toHaveText("↓");
	const viewsTh = viewsHeader.locator("xpath=ancestor-or-self::th[1]");
	await expect(viewsTh).toHaveAttribute("aria-sort", "descending");
	await viewsHeader.click();
	await expect(viewsHeader.locator("span")).toHaveText("↑");
	await expect(viewsTh).toHaveAttribute("aria-sort", "ascending");

	// And the previously sorted column stops claiming a sort.
	await expect(dateHeader.locator("xpath=ancestor-or-self::th[1]")).not.toHaveAttribute(
		"aria-sort",
	);
});
