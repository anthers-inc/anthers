// SPDX-License-Identifier: Apache-2.0
/**
 * The Library, its lenses, and its sidebar, walked in a browser.
 *
 * 🚨 **The load-bearing assertion is that a lens is a VIEW, never a container.** Switching
 * to the music lens and back must leave the shelf holding exactly what it held before. That
 * property is easy to state and easy to break — a lens that "owns" its items is the obvious
 * implementation, and here it would mean a view change silently dropping something a person
 * paid for. Garnet writes the same rule down for uninstalling a workflow; Anthers' version
 * is stronger because entitlement is money.
 *
 * The other half is that the lens is not a filter wearing a new name: it reorganizes the
 * same items into albums you play from, rather than narrowing a grid. Since the sidebar
 * restructure (2026-10-11) the Lenses are the Library's middle sidebar section and the
 * Type and Tags filters the shared section beneath them — the sidebar spec
 * (`sidebar-structure.authed.e2e.ts`) pins the structure; this one pins the Library's
 * content: the lens rows, the dial, and the greying.
 */
import { MEDIA_FIXTURE_PROJECT, mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

const TRACK = mediaFixtureWork("track1");

/**
 * Save the fixture album and one loose track for the signed-in user, through the real
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

/** The sidebar lens rows, by label. */
function lensRow(page: Page, label: string) {
	return page.getByRole("button", { name: label, exact: true });
}

test.describe.configure({ mode: "serial" });

test("a lens is a view, not a container — the shelf survives switching", async ({ page }) => {
	await page.goto("/library");
	await saveFixtures(page);

	const before = await shelfCount(page);
	expect(before, "the fixtures should be on the shelf").toBeGreaterThan(0);

	// Scoped to the sidebar's Lenses section: "Music" is also a shared Type row, and
	// the two mean genuinely different things — one reorganizes the shelf, the other
	// narrows it; the lens row says Music Player and the type row says Music.
	await expect(page.getByRole("heading", { name: "Lenses", exact: true })).toBeVisible();
	await lensRow(page, "Music Player").click();
	await expect(page).toHaveURL(/lens=music/);
	await lensRow(page, "No Lens").click();
	await expect(page).toHaveURL(/^(?!.*lens=music).*$/);

	expect(await shelfCount(page), "the lens changed what is IN the Library").toBe(before);
});

test("the Library's sidebar reads Lenses, then the shared Type and Tags", async ({ page }) => {
	await page.goto("/library");
	await saveFixtures(page);
	await expect(page.getByRole("heading", { name: "Lenses", exact: true })).toBeVisible();

	// The four lens rows in order: the two unbuilt ones greyed with the marker, not
	// absent — the vocabulary is stable the same way the shared Type list's is.
	const sections = page.evaluate(() => {
		const headings = [...document.querySelectorAll("aside section h3")];
		const rows = (name: string) => {
			const s = headings.find((h) => h.textContent === name)?.closest("section");
			return [...(s?.querySelectorAll("button") ?? [])].map(
				(b) =>
					`${b.textContent?.trim()}${b.getAttribute("aria-disabled") === "true" ? " [greyed]" : ""}`,
			);
		};
		return { lenses: rows("Lenses"), type: rows("Type"), tags: rows("Tags") };
	});
	expect((await sections).lenses).toEqual([
		"No Lens",
		"Music Player",
		"Channel Guide(Coming Soon) [greyed]",
		"Bookshelf(Coming Soon) [greyed]",
	]);
	expect((await sections).type?.length).toBeGreaterThan(0);
	// Tags carries the feed's shape: with nothing selected, the search input only.
	expect(await page.getByPlaceholder("Search tags…").count()).toBe(1);
	// The section ORDER: Lenses above Type above Tags — middle section, then shared.
	const y = (name: string) =>
		page.evaluate((n) => {
			const h = [...document.querySelectorAll("aside section h3")].find((x) => x.textContent === n);
			return h ? h.getBoundingClientRect().y : -1;
		}, name);
	expect(await y("Lenses")).toBeLessThan(await y("Type"));
	expect(await y("Type")).toBeLessThan(await y("Tags"));

	// A greyed lens row is not a view: the disabled button is the whole proof, and the
	// URL carries no lens — the (Coming Soon) entry is vocabulary, not a control that
	// navigates anywhere. (Playwright refuses to click a disabled button; the state is
	// the assertion, not a click.) The marker rides the row's accessible name, so the
	// match is the substring.
	await expect(page.getByRole("button", { name: "Channel Guide" })).toBeDisabled();
	await expect(page).toHaveURL(/\/library$/);
});

test("a type greys where the Library holds nothing of it; a row with stock stays live", async ({
	page,
}) => {
	await page.goto("/library");
	await expect(page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();

	// Posts never exist in a Library; the row greys permanently. Games and Software
	// are greyed by absence — the walker's shelf runs on the media fixture.
	await expect(page.getByRole("button", { name: "Posts", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Games", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Software", exact: true })).toBeDisabled();

	// And greying is by stock, not decoration: save a music track and its row is live.
	await saveFixtures(page);
	await expect(page.getByRole("button", { name: "Music", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "Music", exact: true }).click();
	await expect(page).toHaveURL(/type=music/);
});

test("the music lens organizes rather than filters", async ({ page }) => {
	await page.goto("/library?lens=music");

	// An album, as an album: cover, artist, track count — not a row in the same grid.
	await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
	await expect(page.getByText(MEDIA_FIXTURE_PROJECT.title).first()).toBeVisible();
	await expect(page.getByText(/\d+ tracks?/).first()).toBeVisible();

	// And the types the lens excludes are GREYED in the shared section: under the
	// Music Player the Type list cannot narrow what the lens reorganizes — the lens
	// decides what it draws on.
	await expect(page.getByRole("button", { name: "Games", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Music", exact: true })).toBeEnabled();
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

test("the music lens's spoken-word dial re-scopes the view without touching the shelf", async ({
	page,
}) => {
	await page.goto("/library");
	await saveFixtures(page);

	// A view change, not a container change — the same invariant the lens itself is
	// held to: toggling the dial off and on must leave the shelf holding exactly what
	// it held. The dial is the lens's control, rendered beneath the Music Player row
	// only while that lens is active.
	const before = await shelfCount(page);
	await page.goto("/library?lens=music");

	const dial = page.getByRole("checkbox", { name: /include spoken word/i });
	await expect(dial).toBeVisible();
	await expect(dial).not.toBeChecked(); // music by default
	// Click through the wrapping <label> text rather than `.check()` on the input: the
	// daisyUI toggle re-skins the control, and the accessible surface a finger or a
	// user lands on is the labeled row, which is what the assertion is about.
	await page.getByText("Include spoken word", { exact: true }).click();
	await expect(page).toHaveURL(/spoken=1/);
	await page.getByText("Include spoken word", { exact: true }).click();
	await expect(page).toHaveURL(/^(?!.*spoken=1).*$/);

	expect(await shelfCount(page), "the dial changed what is IN the Library").toBe(before);
});

test("the dial's widening ungreys the audio Type row", async ({ page }) => {
	await page.goto("/library?lens=music");
	await saveFixtures(page);
	await expect(page.getByRole("button", { name: "Audio", exact: true })).toBeDisabled();
	await page.getByText("Include spoken word", { exact: true }).click();
	await expect(page).toHaveURL(/spoken=1/);
	await expect(page.getByRole("button", { name: "Audio", exact: true })).toBeEnabled();
});

test("a removed lens reads as No Lens, and nothing else breaks with it", async ({ page }) => {
	// The Video lens was retired on 2026-10-11 — a lens is a UI/UX shift, never a type
	// filter in disguise, and the plain video grid is just the Video type filter. A
	// stale `lens=video` bookmark must land on the plain shelf, not a broken page.
	await page.goto("/library?lens=video");
	await saveFixtures(page);
	await expect(page.getByRole("heading", { name: "Watchlist" })).toHaveCount(0);
	expect(await page.locator(".card").count()).toBeGreaterThan(0);
});

test("a tag filter narrows the shelf and its removal restores it", async ({ page }) => {
	await page.goto("/library");
	await saveFixtures(page);

	const before = await shelfCount(page);
	expect(before).toBeGreaterThan(0);

	// The Tags section is the feed's shape: search names candidates, and Enter on a
	// typed token adds it anyway. A tag nothing on the shelf carries must empty the
	// view (AND semantics), and removing the filter restores the shelf — the shelf is
	// narrowed by filters, but never changed BY them.
	await page.getByPlaceholder("Search tags…").fill("zzz-shelf-has-nothing");
	await page.getByPlaceholder("Search tags…").press("Enter");
	expect(await page.locator(".card").count()).toBe(0);
	await page.getByRole("button", { name: "Remove tag zzz-shelf-has-nothing" }).click();
	expect(await shelfCount(page)).toBe(before);
});
