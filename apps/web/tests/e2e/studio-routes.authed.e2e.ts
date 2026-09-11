// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Studio is a SECTION of this app, not a separate origin.
 *
 * `apps/studio-web` served it from `studio.anthers.org` until 2026-08-11, for cross-origin
 * isolation that turned out to be dormant (`@ffmpeg/core-mt` hangs at pthread spawn
 * in-browser) and never to have required a second origin anyway — isolation is a
 * per-DOCUMENT property. It is `/studio` here now.
 *
 * 🚨 **These run in the `gauntlet` project because they need a real session.** Signed out,
 * every route on this app renders the same marketing page, so a `chromium`-project version
 * of these assertions passes whether or not the routes exist — which is a test that proves
 * nothing while looking green. That version was written, confirmed vacuous, and deleted.
 *
 * What they pin:
 *
 *   - **That `/studio` resolves to the Studio at all.** The gauntlet viewer is NOT a
 *     creator, so the creator gate redirects them to `/settings`; that redirect is the
 *     observable proof the Studio route matched, because any other match renders
 *     something that is not the Studio.
 *
 *     ⚠️ These do NOT pin route ORDER, and an earlier version of this comment claimed they
 *     did. Moving the `/studio` block below the catch-all was tried and every test still
 *     passed: React Router v6 ranks matches by specificity, so a static segment beats a
 *     dynamic one wherever it is registered. Worth knowing before someone "fixes" an
 *     ordering bug that cannot exist — and worth remembering that the sabotage is what
 *     found this, not the green run.
 *   - **The legacy `/dashboard/*` tree** still lands somewhere sensible. It used to
 *     hard-navigate across origins; it is an in-app redirect now.
 *   - **That the Studio's own buttons GO there** — added 2026-08-17, and the gap they close
 *     is the point. Every test above reaches a route by typing its URL, which is precisely
 *     what cannot see a wrong `<Link to>`. The Studio's pages live in `@anthers/web-shared`
 *     while its routes are mounted in `apps/web`, so the merge re-prefixed the shell's nav
 *     and left the pages linking to the pre-merge root paths, none of which announced
 *     themselves as broken. ⚠️ **A wrong in-app link still need not 404** — `/settings`,
 *     `/library` and `/@somebody` are all real destinations a stale Studio link could
 *     reach. So these tests click, and they assert the Studio shell is still on screen
 *     afterwards rather than only checking the URL.
 */
import { expect, type Page, test } from "@playwright/test";
import { API_URL, signInAsCreator, WEB_ORIGIN } from "./fixtures";

/**
 * The Studio chrome. Asserting on it is what distinguishes "the link went to the Studio
 * page" from "the link fell through to a page that happens to render". A URL check alone
 * passes on any destination at all, including the ones that look like a page.
 */
function studioNav(page: Page) {
	return page.getByRole("navigation").getByRole("link", { name: "Dashboard" });
}

test("/studio resolves to the Studio and its creator gate", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));

	await page.goto("/studio");

	// Signed in but not a creator → the gate sends us to account settings, in-app.
	//
	// ⭐ The `?creator=1` is a stronger assertion than the bare path, not noise: only the
	// Studio's gate adds it, so it distinguishes "the Studio route matched and bounced us"
	// from "something else happened to land on /settings". It is also what tells the person
	// why they were moved — the redirect was silent until 2026-09-11.
	await expect(page).toHaveURL(/\/settings\?creator=1$/);
	expect(errors).toEqual([]);
});

test("legacy /dashboard paths redirect into /studio", async ({ page }) => {
	await page.goto("/dashboard/analytics");
	// StudioRedirect strips /dashboard → /studio/analytics, then the creator gate applies.
	// Landing on the gate's own destination proves both hops ran; a dead-end would have
	// stayed put.
	await expect(page).toHaveURL(/\/settings\?creator=1$/);
});

test("a creator reaches the Studio itself", async ({ page, context }) => {
	await signInAsCreator(context);

	await page.goto("/studio");
	// Past the gate: the Studio shell renders rather than bouncing to /login or /settings.
	await expect(page).toHaveURL(/\/studio$/);
	await expect(page.getByRole("navigation").getByText("Dashboard")).toBeVisible();
});

test("every Studio tab lands on its own route", async ({ page, context }) => {
	await signInAsCreator(context);

	// ⭐ **The nav is places, not actions, as of 2026-09-11.** It read *Dashboard · Catalog ·
	// New Post · Analytics · Settings* — a verb among locations — while Projects had no entry
	// at all. Anthers' three objects now each have a home: the Catalog owns Projects and
	// Works, Posts owns posts, and the Dashboard says what needs attention.
	//
	// "Import" is absent because the itch.io import endpoints all return "not yet
	// implemented", so a creator who reached the page found a form that always failed.
	// Restore the row when the Cross-Publishing lane ships them.
	const tabs = [
		{ name: "Catalog", url: /\/studio\/catalog$/ },
		{ name: "Posts", url: /\/studio\/posts$/ },
		{ name: "Analytics", url: /\/studio\/analytics$/ },
		{ name: "Settings", url: /\/studio\/settings$/ },
		{ name: "Dashboard", url: /\/studio$/ },
	];

	await page.goto("/studio");
	await expect(studioNav(page)).toBeVisible();

	for (const { name, url } of tabs) {
		await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
		await expect(page, `the "${name}" tab did not land on its route`).toHaveURL(url);
		await expect(studioNav(page), `the "${name}" tab left the Studio shell`).toBeVisible();
	}
});

test("every New button lands inside the Studio", async ({ page, context }) => {
	await signInAsCreator(context);

	// The New buttons live on each index rather than in the nav. Every one of these was
	// root-absolute until 2026-08-17 and each resolved to a real, wrong page — `/settings`,
	// `/library` and `/@somebody` are all real destinations a stale Studio link can reach —
	// so the shell assertion is doing the actual work, not the URL check.
	const buttons = [
		{ from: "/studio/catalog", name: "New Work", url: /\/studio\/works\/new$/ },
		{ from: "/studio/catalog", name: "New Project", url: /\/studio\/projects\/new$/ },
		{ from: "/studio/posts", name: "New Post", url: /\/studio\/posts\/new$/ },
	];

	for (const { from, name, url } of buttons) {
		await page.goto(from);
		await expect(studioNav(page)).toBeVisible();
		await page.getByRole("link", { name, exact: true }).first().click();
		await expect(page, `"${name}" did not land on its Studio route`).toHaveURL(url);
		await expect(studioNav(page), `"${name}" left the Studio shell`).toBeVisible();
	}
});

test("the Dashboard stopped being a copy of everything the creator owns", async ({
	page,
	context,
}) => {
	await signInAsCreator(context);
	await page.goto("/studio");
	await expect(studioNav(page)).toBeVisible();

	// 🚨 **An absence, so it needs a test** — nothing else in the repository can tell that a
	// section is gone rather than merely empty. The Dashboard listed "Your Projects" and
	// "Your Posts" in two tables and never mentioned a Work, which is how the object carrying
	// every gate, price and Time Pool minute came to be the one absent from the front door.
	// Both moved to the tab that owns them on 2026-09-11.
	await expect(page.getByRole("heading", { name: "Your Projects" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Your Posts" })).toHaveCount(0);

	// And they are reachable, at the tab that owns each.
	await page.goto("/studio/catalog");
	await expect(page.getByRole("link", { name: "New Project", exact: true })).toBeVisible();
	await page.goto("/studio/posts");
	await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
});

test("the pre-rename Catalog path redirects rather than rendering", async ({ page, context }) => {
	await signInAsCreator(context);

	// `/studio/library` mounted `CatalogPage` a second time, so the address bar could read
	// "library" while the heading read "Catalog" — the confusion the 2026-08-13 rename was
	// for. Kept as a redirect because bookmarks from before it still exist.
	await page.goto("/studio/library");
	await expect(page).toHaveURL(/\/studio\/catalog$/);
	await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
});

test("a creator can create a Project and lands on its shelf", async ({ page, context }) => {
	const token = await signInAsCreator(context);
	// Unique per run: the gauntlet reset does not touch projects, and `POST /projects` 409s
	// on a duplicate slug — so a fixed slug would pass once and fail forever after.
	const slug = `e2e-project-${Date.now()}`;

	try {
		await page.goto("/studio/catalog");
		await page.getByRole("link", { name: "New Project", exact: true }).first().click();
		await expect(page).toHaveURL(/\/studio\/projects\/new$/);
		await expect(page.getByRole("heading", { name: "New Project" })).toBeVisible();

		// Located by PLACEHOLDER, not by label: `FormField` renders its label as a sibling of
		// the input with no `htmlFor`, so `getByLabel` matches nothing on this site whether or
		// not the field exists — a locator that cannot fail. The title drives the slug field,
		// so fill the slug second and cleanup knows what to delete.
		await page.getByPlaceholder("My Project", { exact: true }).fill("E2E Project");
		await page.getByPlaceholder("my-project", { exact: true }).fill(slug);
		await page.getByRole("button", { name: "Create Project" }).click();

		// Creating ends on the EDIT page, not the public one — the shelves are edit-only,
		// and they are the whole reason a creator made a Project.
		await expect(page).toHaveURL(new RegExp(`/studio/projects/${slug}/edit$`));
		await expect(page.getByRole("heading", { name: "Works" })).toBeVisible();
		await expect(studioNav(page)).toBeVisible();

		// 🚨 IN VIEWPORT, not merely visible — `toBeVisible` passes on an element scrolled
		// off the top, and that is exactly what happened here. `LoggedInLayout` scrolls an
		// inner `<main>` rather than the window, so `ScrollToTop`'s `window.scrollTo(0, 0)`
		// was a no-op for every signed-in page: this one arrived 222px down with its heading
		// behind the sticky Studio header. Nothing errored and the URL was right.
		//
		// ⚠️ **This asserts where the page ARRIVES, so it has to run before anything scrolls
		// it.** The shelf walk below reaches the bottom of the form; putting it first made
		// this fail for a reason that had nothing to do with the scroll behavior it guards.
		await expect(page.getByRole("heading", { name: "Edit Project" })).toBeInViewport();

		// 🚨 **Both shelves, because the second one had no surface at all.** A Project holds
		// Works AND posts in two ordered lists — the database, the API and the public Project
		// page all said so — and `POST /projects/:slug/posts`, its delete and its reorder were
		// implemented, owner-checked and called from nowhere. The only way a post ever joined a
		// Project was a select on the New Post form that was hidden on edit and ignored by
		// `PATCH /posts/:slug`, so membership was set at birth or never.
		await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
		await page.getByRole("button", { name: "Add a post" }).click();
		await expect(page.getByRole("heading", { name: "Add a post" })).toBeVisible();
	} finally {
		// The dev DB is shared with the unit suites and is not a clean room; don't add to it.
		await fetch(`${API_URL}/api/content/projects/${slug}`, {
			method: "DELETE",
			headers: { Origin: WEB_ORIGIN, Cookie: `session=${token}` },
		});
	}
});
