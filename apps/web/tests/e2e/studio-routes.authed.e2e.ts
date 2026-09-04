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
	await expect(page).toHaveURL(/\/settings$/);
	expect(errors).toEqual([]);
});

test("legacy /dashboard paths redirect into /studio", async ({ page }) => {
	await page.goto("/dashboard/analytics");
	// StudioRedirect strips /dashboard → /studio/analytics, then the creator gate applies.
	// Landing on /settings proves both hops ran; a dead-end would have stayed put.
	await expect(page).toHaveURL(/\/settings$/);
});

test("a creator reaches the Studio itself", async ({ page, context }) => {
	await signInAsCreator(context);

	await page.goto("/studio");
	// Past the gate: the Studio shell renders rather than bouncing to /login or /settings.
	await expect(page).toHaveURL(/\/studio$/);
	await expect(page.getByRole("navigation").getByText("Dashboard")).toBeVisible();
});

test("every Dashboard action button lands inside the Studio", async ({ page, context }) => {
	await signInAsCreator(context);
	await page.goto("/studio");
	await expect(studioNav(page)).toBeVisible();

	// Header buttons, in the order the Dashboard renders them. Each was root-absolute until
	// 2026-08-17 and each resolved to a real, wrong page — so the shell assertion below is
	// doing the actual work.
	//
	// "Import" was removed from this list when the itch.io import UI was hidden — the
	// three import endpoints all return "not yet implemented", so a creator who reached
	// the page found a form that always failed. Restore this row when the Cross-Publishing
	// lane ships its import endpoints and the route + nav link are re-enabled.
	const actions = [
		{ name: "Analytics", url: /\/studio\/analytics$/ },
		{ name: "New Project", url: /\/studio\/projects\/new$/ },
		{ name: "New Post", url: /\/studio\/posts\/new$/ },
	];

	for (const { name, url } of actions) {
		await page.goto("/studio");
		await page.getByRole("link", { name, exact: true }).first().click();
		await expect(page, `"${name}" did not land on its Studio route`).toHaveURL(url);
		await expect(studioNav(page), `"${name}" left the Studio shell`).toBeVisible();
	}
});

test("a creator can create a Project and lands on its shelf", async ({ page, context }) => {
	const token = await signInAsCreator(context);
	// Unique per run: the gauntlet reset does not touch projects, and `POST /projects` 409s
	// on a duplicate slug — so a fixed slug would pass once and fail forever after.
	const slug = `e2e-project-${Date.now()}`;

	try {
		await page.goto("/studio");
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

		// Creating ends on the EDIT page, not the public one — the Works shelf is edit-only,
		// and it is the whole reason a creator made a Project.
		await expect(page).toHaveURL(new RegExp(`/studio/projects/${slug}/edit$`));
		await expect(page.getByRole("heading", { name: "Works" })).toBeVisible();
		await expect(studioNav(page)).toBeVisible();

		// 🚨 IN VIEWPORT, not merely visible — `toBeVisible` passes on an element scrolled
		// off the top, and that is exactly what happened here. `LoggedInLayout` scrolls an
		// inner `<main>` rather than the window, so `ScrollToTop`'s `window.scrollTo(0, 0)`
		// was a no-op for every signed-in page: this one arrived 222px down with its heading
		// behind the sticky Studio header. Nothing errored and the URL was right.
		await expect(page.getByRole("heading", { name: "Edit Project" })).toBeInViewport();
	} finally {
		// The dev DB is shared with the unit suites and is not a clean room; don't add to it.
		await fetch(`${API_URL}/api/content/projects/${slug}`, {
			method: "DELETE",
			headers: { Origin: WEB_ORIGIN, Cookie: `session=${token}` },
		});
	}
});
