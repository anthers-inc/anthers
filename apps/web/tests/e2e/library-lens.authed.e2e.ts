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
 * same items into releases you open, rather than narrowing a grid. Since the sidebar
 * restructure (2026-10-11) the Lenses are the Library's middle sidebar section and the
 * Type and Tags filters the shared section beneath them — the sidebar spec
 * (`sidebar-structure.authed.e2e.ts`) pins the structure; this one pins the Library's
 * content: the lens rows, the dial, and the graying.
 */
import { fileURLToPath } from "node:url";
import { MEDIA_FIXTURE_PROJECT, mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { API_URL, emailedCode, expect, leashedExecFileSync, test, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const TRACK = mediaFixtureWork("track1");

/**
 * Save the fixture album and one of its tracks for the signed-in user, through the real
 * endpoint. Idempotent server-side, so re-runs need no cleanup. The track is a separate
 * shelf entry and must still group under the saved Project in the lens.
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

test("the Library's sidebar reads Lenses, Access, Type, Tags", async ({ page }) => {
	await page.goto("/library");
	await saveFixtures(page);
	await expect(page.getByRole("heading", { name: "Lenses", exact: true })).toBeVisible();

	// The four lens rows in order: the two unbuilt ones grayed with the marker, not
	// absent — the vocabulary is stable the same way the shared Type list's is.
	const sections = page.evaluate(() => {
		const headings = [...document.querySelectorAll("aside section h3")];
		const rows = (name: string) => {
			const s = headings.find((h) => h.textContent === name)?.closest("section");
			return (
				[...(s?.querySelectorAll("button") ?? [])]
					// The heading's (i) explainer is its own control, not one of the section's
					// selectable rows — and its textContent carries the whole tip copy, shown
					// or not, so it would read as a fourth mode.
					.filter((b) => b.getAttribute("aria-label") !== "More Information")
					.map(
						(b) =>
							`${b.textContent?.trim()}${b.getAttribute("aria-disabled") === "true" ? " [grayed]" : ""}`,
					)
			);
		};
		return { lenses: rows("Lenses"), type: rows("Type"), access: rows("Access") };
	});
	expect((await sections).lenses).toEqual([
		"No Lens",
		"Music Player",
		"Channel Guide",
		"Bookshelf",
	]);
	expect((await sections).type?.length).toBeGreaterThan(0);
	// Access, the Library consumes: the three-mode control renders (Any live by default).
	expect((await sections).access).toEqual(["Any", "Unlocked", "Locked"]);
	// Tags carries the feed's shape: with nothing selected, the search input only.
	expect(await page.getByPlaceholder("Search tags…").count()).toBe(1);
	// The section ORDER: Lenses above Access above Type above Tags — Lenses, then the
	// shared filters with Access first (the Library holds locked saves, and Access is
	// the row that reads them).
	const y = (name: string) =>
		page.evaluate((n) => {
			const h = [...document.querySelectorAll("aside section h3")].find((x) => x.textContent === n);
			return h ? h.getBoundingClientRect().y : -1;
		}, name);
	expect(await y("Lenses")).toBeLessThan(await y("Access"));
	expect(await y("Access")).toBeLessThan(await y("Type"));
	expect(await y("Type")).toBeLessThan(await y("Tags"));

	// Every lens row is live on the Library, one per built view — the two newest
	// flipped live by their own tasks on 2026-10-11, so no (Coming Soon) marker and
	// none disabled remains here. The grayed-row vocabulary stays pinned once per
	// tab family: the sidebar-structure spec carries it on the Feed, the only tab
	// with unbuilt lens rows.
	for (const label of ["No Lens", "Music Player", "Channel Guide", "Bookshelf"]) {
		await expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled();
	}
	await expect(page).toHaveURL(/\/library$/);
});

test("a type grays where the Library holds nothing of it; a row with stock stays live", async ({
	page,
}) => {
	await page.goto("/library");
	await expect(page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();

	// Posts have no stock in this walk's Library (they will once the Save unification
	// adds posts as Library rows); the row grays by absence like any empty type.
	// Games and Software are grayed by absence — the walker's shelf runs on the media
	// fixture.
	await expect(page.getByRole("button", { name: "Posts", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Games", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Software", exact: true })).toBeDisabled();

	// And graying is by stock, not decoration: save a music track and its row is live.
	await saveFixtures(page);
	await expect(page.getByRole("button", { name: "Music", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "Music", exact: true }).click();
	await expect(page).toHaveURL(/type=music/);
});

test("the music lens organizes rather than filters", async ({ page }) => {
	await saveFixtures(page);
	await page.goto("/library?lens=music");

	// A release, as a release: cover, artist, track count — not a row in the same grid.
	await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();
	await expect(page.getByText(MEDIA_FIXTURE_PROJECT.title).first()).toBeVisible();
	await expect(page.getByText(/\d+ tracks?/).first()).toBeVisible();

	// The loose track saved from the Project is grouped under it rather than standing
	// beside it as a second card. One Project and one of its tracks is one release.
	await expect(page.getByTestId("release-card")).toHaveCount(1);
	await expect(page.getByText(TRACK.title, { exact: true })).toHaveCount(0);

	// And the types the lens excludes are GRAYED in the shared section: under the
	// Music Player the Type list cannot narrow what the lens reorganizes — the lens
	// decides what it draws on.
	await expect(page.getByRole("button", { name: "Games", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Music", exact: true })).toBeEnabled();
});

test("opening a release shows its tracks in the lens, and back returns to the collection", async ({
	page,
}) => {
	await saveFixtures(page);
	await page.goto("/library?lens=music");

	await expect(page.getByTestId("release-card")).toHaveCount(1);
	await page
		.getByRole("button", { name: new RegExp(`^Open ${MEDIA_FIXTURE_PROJECT.title}`) })
		.click();

	// The release's own header and its whole track list — the Project was saved, so the
	// release opens whole. The gated member keeps its row and says so rather than vanishing.
	await expect(page.getByRole("heading", { name: MEDIA_FIXTURE_PROJECT.title })).toBeVisible();
	await expect(page.getByTestId("track-row")).toHaveCount(4);
	await expect(page.getByText("Gated", { exact: true })).toHaveCount(1);

	// Back goes to the collection, not to the Project page and not to the plain shelf.
	await page.getByRole("button", { name: "Releases", exact: true }).click();
	await expect(page.getByTestId("release-grid")).toBeVisible();
	await expect(page.getByTestId("release-card")).toHaveCount(1);
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

test("the dial's widening ungrays the audio Type row", async ({ page }) => {
	await page.goto("/library?lens=music");
	await saveFixtures(page);
	// Spoken word needs an episode on the shelf: without stock, the Audio row would
	// stay grayed by absence (the graying is by supply, and the fixture's episode is
	// the spoken-word stock).
	const cookies = await page.context().cookies();
	const session = cookies.find((c) => c.name === "session")?.value;
	const episode = await fetch(
		`${API_URL}/api/content/works/${mediaFixtureWork("episode").slug}-${mediaFixtureWork("episode").publicId}`,
	).then((r) => r.json());
	await fetch(`${API_URL}/api/content/library`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${session}`,
		},
		body: JSON.stringify({ workId: episode.work.id }),
	});

	await expect(page.getByRole("button", { name: "Audio", exact: true })).toBeDisabled();
	await page.getByText("Include spoken word", { exact: true }).click();
	await expect(page).toHaveURL(/spoken=1/);
	await expect(page.getByRole("button", { name: "Audio", exact: true })).toBeEnabled();
});

test("an Access filter reads the resolved verdict the cards already carry", async ({ page }) => {
	await page.goto("/library");
	await saveFixtures(page);
	const before = await shelfCount(page); // album + track

	// Unlocked keeps the free track and drops the album, which has no access reading.
	await page.getByRole("button", { name: "Unlocked", exact: true }).click();
	await expect(page).toHaveURL(/access=unlocked/);
	await expect(page.locator(".card"), "the album drops; the unlocked stock stands").toHaveCount(
		before - 1,
	);

	// Locked is the complement — with nothing locked saved, the view empties rather
	// than lying.
	await page.getByRole("button", { name: "Locked", exact: true }).click();
	await expect(page).toHaveURL(/access=locked/);
	await expect(page.locator(".card")).toHaveCount(0);

	// Any restores.
	await page.getByRole("button", { name: "Any", exact: true }).click();
	await expect(page).toHaveURL(/^(?!.*access=).*$/);
	await expect(page.locator(".card")).toHaveCount(before);
});

test("a removed lens reads as No Lens, and nothing else breaks with it", async ({ page }) => {
	// The Video lens was retired on 2026-10-11 — a lens is a UI/UX shift, never a type
	// filter in disguise, and the plain video grid is just the Video type filter. A
	// stale `lens=video` bookmark must land on the plain shelf, not a broken page.
	await page.goto("/library?lens=video");
	await saveFixtures(page);
	await expect(page.getByRole("heading", { name: "Watchlist" })).toHaveCount(0);
	// The library read resolves after load; the Library heading only renders once it has.
	await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
	await expect(page.locator(".card").first()).toBeVisible();
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
	await expect(page).toHaveURL(/tags=zzz-shelf-has-nothing/);
	await expect(
		page.locator(".card"),
		"nothing carries the tag, so AND semantics empty the view",
	).toHaveCount(0);
	await page.getByRole("button", { name: "Remove tag zzz-shelf-has-nothing" }).click();
	await expect(page).toHaveURL(/^(?!.*tags=).*$/);
	await expect(page.locator(".card")).toHaveCount(before);
});

// ── The 2026-10-11 lens pair — Bookshelf and Channel Guide ──────────────────
//
// Both read the same shelf list the older lenses draw on (`withTags`), so the walk's
// setup is saving fixture Works and nothing more.

/** Save one fixture Work for the signed-in user, and return its serialized Work. */
async function saveFixtureWork(page: Page, key: string) {
	const cookies = await page.context().cookies();
	const session = cookies.find((c) => c.name === "session")?.value;
	expect(session, "the authed project should carry a session cookie").toBeTruthy();
	const fixture = mediaFixtureWork(key);
	const res = await fetch(`${API_URL}/api/content/works/${fixture.slug}-${fixture.publicId}`).then(
		(r) => r.json(),
	);
	const work = res.work as { id: number; pageCount?: number };
	const save = await fetch(`${API_URL}/api/content/library`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${session}`,
		},
		body: JSON.stringify({ workId: work.id }),
	});
	expect([201, 404]).toContain(save.status);
	return work;
}

test("the Bookshelf lens stands the saved comic up as a spine", async ({ page }) => {
	// The ribbon reads the further-along of the device's keys and the user's row, and
	// this file's walks share the media fixture user with every reader walk — whose
	// legitimate page turns write rows past this walk's local seed. So the assertion
	// runs on its own throwaway account, whose comic row nothing else writes, and the
	// seeded device keys are the only position the account carries.
	const account = makeRailAccount(`spine_${Date.now().toString(36)}`);
	try {
		await signInThroughUi(page, account.email);
		const comic = await saveFixtureWork(page, "comic");
		const pageCount = comic.pageCount ?? 0;
		expect(
			pageCount,
			"the fixture comic renders pages — no pages, no spine ribbon",
		).toBeGreaterThan(1);

		// Seed where this device last got in it — the store `lib/reading-positions.ts`
		// owns, written by the comic reader on navigation. The spine marker is the
		// shelf's read of the same data: page 2 of the fixture's pages, as a ribbon on
		// the spine. The account holds no row for the comic, so this device's seed is
		// the whole story.
		await page.addInitScript(
			(seed) => {
				localStorage.setItem("anthers_reading_progress", JSON.stringify({ [String(seed.id)]: 2 }));
			},
			{ id: comic.id },
		);

		await page.goto("/library?lens=bookshelf");
		await expect(page.getByRole("heading", { name: "Bookshelf" })).toBeVisible();
		await expect(page.getByText("A comic that really turns").first()).toBeVisible();

		// The ribbon, at the depth the device got to: round(2 / pageCount) percent.
		// Scoped to the shelf's own rows — an unfinished position rides the rail above
		// too, so its spine carries a second, equal marker this walk is not about.
		const expected = `${Math.round((2 / pageCount) * 100)}%`;
		await expect(page.getByTestId("bookshelf-shelf").getByTestId("spine-marker")).toHaveAttribute(
			"style",
			new RegExp(`height:\\s*${expected.replace("%", "")}%`),
		);
	} finally {
		await purgeRailAccount(account.id);
	}
});

/**
 * Push one real position row through the routes the readers write through.
 *
 * The rail's rows are per-user value state, and this file's walks share the media
 * fixture user with every reader walk in the project — so the rail assertions run
 * against their own throwaway account, whose rows nothing else writes:
 * `makeRailAccount` makes it, `/login` signs it, and it is purged before the test
 * ends, its rows cascading with it.
 */
async function putReadingPosition(page: Page, workId: number, progress: number) {
	const cookies = await page.context().cookies();
	const session = cookies.find((c) => c.name === "session")?.value;
	expect(session, "the signed-in page should carry a session cookie").toBeTruthy();
	const res = await fetch(`${API_URL}/api/content/reading-positions/${workId}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${session}`,
		},
		body: JSON.stringify({ progress, position: {} }),
	});
	expect(res.status, "the signed-in user writes their own row").toBe(200);
}

/** A throwaway account, made the canonical way (`db:local-account`), as the basket spec does. */
function makeRailAccount(name: string): { email: string; id: number } {
	const address = `${name}@example.com`;
	const out = JSON.parse(
		leashedExecFileSync("bun", ["run", "db:local-account", "--name", name, "--email", address], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { handle: string; userId: number };
	return { email: address, id: out.userId };
}

async function purgeRailAccount(id: number): Promise<void> {
	const { purgeAccountIds } = await import("../../../api/src/__tests__/purge");
	await purgeAccountIds([id]);
}

/** Sign in through the real /login UI — the throwaway account's own ceremony. */
async function signInThroughUi(page: Page, email: string): Promise<void> {
	await page.goto("/login");
	await page.locator('input[autocomplete="username"]').fill(email);
	await page.getByRole("button", { name: /^continue$/i }).click();
	await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();
	await page.keyboard.type(await emailedCode(email));
	await expect
		.poll(() => page.url(), { message: `sign-in as ${email} never landed`, timeout: 15_000 })
		.not.toContain("/login");
}

test("the continue-reading rail stands the unfinished readings up, newest first", async ({
	page,
}) => {
	const account = makeRailAccount(`rail_${Date.now().toString(36)}`);
	try {
		await signInThroughUi(page, account.email);

		const comic = await saveFixtureWork(page, "comic");
		const ebook = await saveFixtureWork(page, "ebook");

		// Rows through the real route, this account's own: the ebook touched first, the
		// comic most recently — so the comic stands first on the rail.
		await putReadingPosition(page, ebook.id, 0.8);
		await putReadingPosition(page, comic.id, 0.3);

		await page.goto("/library?lens=bookshelf");
		await expect(page.getByRole("heading", { name: "Continue reading" })).toBeVisible();

		// Unfinished positions on book-like Works only — the two rows, nothing else —
		// headed by the last one touched. The account opened exactly two Works, so the
		// count is exact rather than "at least".
		const rail = page.getByTestId("continue-reading");
		const railSpines = rail.getByRole("listitem");
		await expect(railSpines).toHaveCount(2);
		await expect(railSpines.first().getByText("A comic that really turns")).toBeVisible();

		// The ribbon follows the row, not this device: the comic reads 30% from the row
		// pushed moments ago, which no local key here ever carried.
		await expect(rail.locator('[data-testid="spine-marker"]').first()).toHaveAttribute(
			"style",
			/height:\s*30%/,
		);

		// The rail never replaces the shelf: the same Works stand below on the shelf rows.
		await expect(page.getByRole("heading", { name: "Bookshelf" })).toBeVisible();
	} finally {
		// The account's rows cascade with it; the shelf entries go with the account too.
		await purgeRailAccount(account.id);
	}
});

test("the Channel Guide lens puts a channel per creator and its timeline under them", async ({
	page,
}) => {
	await saveFixtureWork(page, "video");

	await page.goto("/library?lens=channel-guide");
	await expect(page.getByRole("heading", { name: "Channel Guide" })).toBeVisible();

	// One channel: the video's creator, holding exactly their timeline. The fixture
	// walker saved one video, so one channel stands.
	const channels = page.getByTestId("guide-channel");
	await expect(channels).toHaveCount(1);
	await expect(page.getByText(mediaFixtureWork("video").title).first()).toBeVisible();

	// Select it: the playlist-player arrangement — the player pane and this video's
	// channel in the rail, the selection highlighted.
	await page.getByTestId("guide-block").click();
	await expect(page.getByTestId("guide-playing")).toBeVisible();
	await expect(page.getByTestId("guide-rail-block")).toHaveCount(1);

	// Up next is UP — this channel's only program is its newest, so there is nothing
	// above it and the control says so by refusing; the guide ends rather than looping.
	await expect(page.getByTestId("guide-next")).toBeDisabled();

	// The X closes the player and the guide returns, whole.
	await page.getByRole("button", { name: "Back to the guide" }).click();
	await expect(page.getByTestId("guide-playing")).toHaveCount(0);
	await expect(channels).toHaveCount(1);
});

test("the new lenses are views, not containers — switching through them leaves the shelf exact", async ({
	page,
}) => {
	await page.goto("/library");
	await saveFixtures(page);
	await saveFixtureWork(page, "video");
	await saveFixtureWork(page, "comic");

	const before = await shelfCount(page);
	expect(before, "the fixture stock should be on the shelf").toBeGreaterThan(0);

	await page.getByRole("button", { name: "Channel Guide", exact: true }).click();
	await expect(page).toHaveURL(/lens=channel-guide/);
	await page.getByRole("button", { name: "Bookshelf", exact: true }).click();
	await expect(page).toHaveURL(/lens=bookshelf/);
	await page.getByRole("button", { name: "Music Player", exact: true }).click();
	await expect(page).toHaveURL(/lens=music/);
	await page.getByRole("button", { name: "No Lens", exact: true }).click();
	await expect(page).toHaveURL(/^(?!.*lens=).*$/);

	expect(await shelfCount(page), "walking every lens changed what is IN the Library").toBe(before);
});
