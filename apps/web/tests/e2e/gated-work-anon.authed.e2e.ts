// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A **logged-out** viewer at a Work — the surface where the app has to hand someone to an
 * auth flow and get them back afterwards.
 *
 * Two Works, because there are now two of these and they must not look alike: a **gated**
 * one, where the visitor's access genuinely is in question, and a **Public Access** one,
 * where it is not and only the account is missing. See the second `describe`.
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

/**
 * 🚨 **The commons, signed out — the surface the account requirement created on 2026-08-28.**
 *
 * A Public Access Work is free to everyone and stays free to everyone; what a signed-out
 * visitor lacks is an account for their time to be attributed to. So this page must ask for
 * an account and must **not** read as a gate — no padlock, no blurred cover, no "members
 * only". That distinction is a live regression risk rather than a hypothetical: every
 * surface here branches on `!canAccess`, and reading that as "locked" would put a padlock on
 * the entire commons for exactly the visitor the public page exists for.
 *
 * ⚠️ The copy is asserted rather than just the buttons. "Free to everyone" is the load-bearing
 * half of the sentence — it is what stops the account requirement reading as a price.
 */
const PUBLIC_ACCESS = `/works/${gauntletPost("G1").slug}`;

test.describe("a Public Access Work, signed out", () => {
	test("asks for a free account, and does not pretend to be a gate", async ({ page }) => {
		await page.goto(PUBLIC_ACCESS);
		await expect(page).toHaveURL(new RegExp(`${PUBLIC_ACCESS}-\\d+$`));
		const here = new URL(page.url()).pathname;

		// Scoped to the card, not the page: "Log in" is in the header and the footer too, so
		// an unscoped role query would resolve three elements and, worse, could pass on the
		// header alone while the card had no second door at all.
		const card = page.locator(".card").filter({ hasText: /free to everyone on Anthers/i });
		await expect(card).toBeVisible();

		// The invitation, leading with signup — somebody meeting free work with no account
		// probably has none.
		const signup = card.getByRole("link", { name: /create a free account/i });
		await expect(signup).toBeVisible();
		await expect(signup).toHaveAttribute("href", `/subscribe?next=${encodeURIComponent(here)}`);
		await expect(card.getByRole("link", { name: /log in/i })).toHaveAttribute(
			"href",
			`/login?next=${encodeURIComponent(here)}`,
		);

		// It says what is true about the Work, not what is true about a gate.
		await expect(card.getByText(/members-only/i)).toHaveCount(0);
		await expect(card.getByText(/unlock/i)).toHaveCount(0);
		await expect(page.getByText(/^Locked/)).toHaveCount(0);

		// And the page itself is intact — this is the half that stays public.
		await expect(page.getByRole("heading", { name: gauntletPost("G1").title })).toBeVisible();
	});

	test("hands over no video, which is the whole point", async ({ page }) => {
		// The invitation stands *where the player would be*. A `<video>` element here would
		// mean the bytes were served to somebody no attention event can be attributed to —
		// the exact defect this rule closes, and the one that earned the creator nothing.
		await page.goto(PUBLIC_ACCESS);
		await expect(page.getByRole("link", { name: /create a free account/i })).toBeVisible();
		await expect(page.locator("video")).toHaveCount(0);
	});
});
