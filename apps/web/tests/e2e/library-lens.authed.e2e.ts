// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Library and its first lens, walked in a browser.
 *
 * 🚨 **The load-bearing assertion is that a lens is a VIEW, never a container.** Switching
 * to the music lens and back must leave the shelf holding exactly what it held before. That
 * property is easy to state and easy to break — a lens that "owns" its items is the obvious
 * implementation, and here it would mean a view change silently dropping something a person
 * paid for. Garnet writes the same rule down for uninstalling a workflow; Anthers' version
 * is stronger because entitlement is money.
 *
 * The other half is that the lens is not a filter wearing a new name: it reorganizes the
 * same items into albums you play from, rather than narrowing a grid.
 */
import { MEDIA_FIXTURE_PROJECT, mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

const TRACK = mediaFixtureWork("track1");

/**
 * Save the fixture album and one loose track for the signed-in viewer, through the real
 * endpoint. Idempotent server-side, so re-runs need no cleanup.
 */
async function saveFixtures(page: Page) {
	const cookies = await page.context().cookies();
	const session = cookies.find((c) => c.name === "session")?.value;
	expect(session, "the authed project should carry a session cookie").toBeTruthy();

	// The album's Project id and the track's Work id, read from the API rather than
	// hard-coded — public ids are stable, database ids are not.
	const project = await fetch(`${API_URL}/api/content/projects/${MEDIA_FIXTURE_PROJECT.slug}`).then(
		(r) => r.json(),
	);
	const work = await fetch(`${API_URL}/api/content/works/${TRACK.slug}-${TRACK.publicId}`).then(
		(r) => r.json(),
	);

	for (const body of [{ projectId: project.project.id }, { workId: work.work.id }]) {
		const res = await fetch(`${API_URL}/api/content/library`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: WEB_ORIGIN, // CSRF checks Origin
				Cookie: `session=${session}`,
			},
			body: JSON.stringify(body),
		});
		expect([201, 404]).toContain(res.status);
	}
}

/** How many cards the bare shelf is showing. */
async function shelfCount(page: Page): Promise<number> {
	await page.goto("/library");
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
	return page.locator(".card").count();
}

test.describe.configure({ mode: "serial" });

test("a lens is a view, not a container — the shelf survives switching", async ({ page }) => {
	await page.goto("/library");
	await saveFixtures(page);

	const before = await shelfCount(page);
	expect(before, "the fixtures should be on the shelf").toBeGreaterThan(0);

	// Scoped to the View group: "Music" is also a media-type tab, and the two mean
	// genuinely different things — one reorganizes the shelf, the other narrows it.
	const views = page.getByRole("tablist", { name: "View" });
	await views.getByRole("tab", { name: "Music" }).click();
	await expect(page).toHaveURL(/lens=music/);
	await views.getByRole("tab", { name: "Shelf" }).click();
	await expect(page).toHaveURL(/^(?!.*lens=music).*$/);

	expect(await shelfCount(page), "the lens changed what is IN the Library").toBe(before);
});

test("the music lens organizes rather than filters", async ({ page }) => {
	await page.goto("/library?lens=music");

	// An album, as an album: cover, artist, track count — not a row in the same grid.
	await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
	await expect(page.getByText(MEDIA_FIXTURE_PROJECT.title).first()).toBeVisible();
	await expect(page.getByText(/\d+ tracks?/).first()).toBeVisible();

	// And the media tabs are gone: under a lens they would be a second, competing way to
	// narrow the same list, which is the "it's just a filter" reading this rejects.
	await expect(
		page.getByRole("tablist", { name: "Media type" }).getByRole("tab", { name: "Games" }),
	).toBeHidden();
});

test("an album plays straight from the shelf", async ({ page }) => {
	await page.goto("/library?lens=music");

	await page
		.getByRole("button", { name: new RegExp(`^Play ${MEDIA_FIXTURE_PROJECT.title}`) })
		.click();

	// The bar comes up and the transport says it is playing. Asserted from the control
	// rather than from a DOM query for `<audio>` — the provider's element is built with
	// `new Audio()` and is never in the document, so `querySelector("audio")` is null and
	// any assertion phrased around it passes vacuously.
	const bar = page.locator("[data-testid=player-bar]");
	await expect(bar).toBeVisible();
	await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});
