// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A **logged-out** viewer at a **gated Work** — the one surface where the app has to hand
 * someone to an auth flow and get them back afterwards.
 *
 * 🚨 **Why the filename says `.authed.` when the spec is deliberately signed OUT.** The
 * suffix selects the Playwright *project*, and what this needs from that project is its
 * `dependencies: ["setup"]` — the gauntlet fixture, which is the only source of a Work
 * that is actually gated. The `chromium` project has no such dependency (on purpose: its
 * specs are static and must not wait on a database), so a fixture-dependent spec placed
 * there would race the seeder and fail on whichever machine lost. The session is then
 * dropped below with `test.use`, because the state under test is *having no account*.
 *
 * What it pins: the two doors, and that both of them come back. Before 2026-08-17 this
 * card offered **only** "Log in", with no `?next=` and no router state — so a visitor with
 * no account had nothing to click, and one with an account was signed in and dropped on
 * their feed having lost the Work. The code comment above that branch claimed it would
 * "return to the post" and never had.
 */
import { gauntletPost } from "@anthers/db/gauntlet";
import { expect, test } from "./fixtures";

// No cookies, no origins: this spec's whole subject is the anonymous viewer. It overrides
// the project's `storageState`, not its `dependencies`, so the fixture is still seeded.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The first gated rung — baseline denied, so an anonymous viewer resolves `login_required`.
 *
 * Taken from the fixture definition rather than typed, for the reason the gauntlet spec
 * gives: the rung slugs are generated from `BADGE_RUNGS`, so a hardcoded one silently stops
 * existing when the ladder is retuned. It cost a cycle here already — `gauntlet-g2` is the
 * fixture's *key*, not its slug, and a 404 renders a page with no unlock card at all, which
 * reads exactly like the feature being broken.
 */
const GATED = `/works/${gauntletPost("G2").slug}`;

test.describe("a gated Work, signed out", () => {
	test("offers both doors, and both of them come back here", async ({ page }) => {
		await page.goto(GATED);

		// The canonical URL carries the publicId, so the return destination is whatever the
		// address bar settled on rather than what we typed — asserting against the settled
		// path is what makes this a test of the component and not of our own string.
		await expect(page).toHaveURL(new RegExp(`${GATED}-\\d+$`));
		const here = new URL(page.url()).pathname;

		const card = page.getByText("Unlock this post").locator("..");
		await expect(card).toBeVisible();

		const login = page.getByRole("link", { name: /log in to unlock/i });
		const signup = page.getByRole("link", { name: /create an account/i });

		// Both exist — the missing second door is half of what was wrong here.
		await expect(login).toBeVisible();
		await expect(signup).toBeVisible();

		// And both carry this exact Work as their return destination.
		await expect(login).toHaveAttribute("href", `/login?next=${encodeURIComponent(here)}`);
		await expect(signup).toHaveAttribute("href", `/subscribe?next=${encodeURIComponent(here)}`);
	});

	test("the destination survives the trip to the signup page", async ({ page }) => {
		await page.goto(GATED);
		await page.getByRole("link", { name: /create an account/i }).click();

		// `?next=` is still on the URL when the ceremony's own page loads, which is what
		// lets it survive a reload while the visitor goes to read their email.
		await expect(page).toHaveURL(
			new RegExp(`/subscribe\\?next=${encodeURIComponent(GATED).replace(/\//g, "%2F")}-\\d+$`),
		);
		await expect(page.getByRole("heading", { name: /anthers is free/i })).toBeVisible();
	});
});
