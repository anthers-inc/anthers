// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Putting on a record: the album view, the queue, and the two rules that fail silently.
 *
 * The queue's *logic* is covered exhaustively and cheaply in `src/lib/music-queue.test.ts`,
 * which is pure. What can only be checked in a browser is that the logic is actually
 * wired to an audio element and to the access model — so this file deliberately does not
 * re-test shuffle permutations, and does test:
 *
 *   🚨 **Auto-advance steps over a track the listener cannot play.** The fixture album's
 *      third track is gated, in the middle rather than at the end — at the end, skipping it
 *      would be indistinguishable from the queue simply running out. This is the rule
 *      Garnet has no equivalent for (it indexes a filesystem: what it lists, it can play),
 *      so nothing about it is ported and nothing but a test protects it.
 *
 *   🚨 **The gate reaches the words.** A denied viewer gets no lyrics, because a gated
 *      track's lyrics are as much the deliverable as its audio. The API-level assertion
 *      lives in `delivery-access.test.ts`; this one proves the browser never renders them.
 *
 * Runs against the media fixture, which nothing else resets — see
 * `packages/db/src/media-fixture.ts` for why borrowing the gauntlet's was not an option.
 */
import {
	MEDIA_FIXTURE_PROJECT,
	MEDIA_FIXTURE_TRACKS,
	MEDIA_FIXTURE_USERNAME,
	mediaFixtureWork,
} from "@anthers/db/media-fixture";
import { creatorProjectUrl } from "@anthers/web-shared/profile";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * ⚠️ **A project is addressed under its creator, and there is no `/projects/:slug` route.**
 * This read `/projects/${slug}` until 2026-09-03 and rendered the right album anyway: the old
 * root-level `/:username/:slug` catch-all matched it with the username "projects", and
 * `ProjectPage` fetches by slug alone, so nothing needed the first segment to be real. Handles
 * carry an `@` now, that path 404s, and this is the URL a reader actually has.
 */
const ALBUM_URL = creatorProjectUrl(MEDIA_FIXTURE_USERNAME, MEDIA_FIXTURE_PROJECT.slug);
const BAR = "[data-testid=player-bar]";
const NOW_PLAYING = `${BAR} [data-testid=now-playing-title]`;

const GATED = mediaFixtureWork("track3");
const FREE_WITH_LYRICS = mediaFixtureWork("track1");

/** What the bar currently says is playing, or null when the bar is not up. */
async function playing(page: Page): Promise<string | null> {
	const el = page.locator(NOW_PLAYING);
	return (await el.count()) === 0 ? null : ((await el.textContent()) ?? "").trim();
}

test.describe.configure({ mode: "serial" });

test("an album of audio Works renders as a record, in order, with the gate visible", async ({
	page,
}) => {
	await page.goto(ALBUM_URL);

	const rows = page.locator("[data-testid=track-row]");
	await expect(rows).toHaveCount(MEDIA_FIXTURE_TRACKS.length);

	// Order is `project_items.sortOrder` — the whole artifact of an EP, and the thing a
	// grid of cards throws away.
	for (const [i, spec] of MEDIA_FIXTURE_TRACKS.entries()) {
		await expect(rows.nth(i)).toContainText(spec.title);
	}

	// The gated one says so in a word, not only in an icon.
	const gatedRow = rows.filter({ hasText: GATED.title });
	await expect(gatedRow).toContainText("Gated");

	// And the header is honest about how much of the record can actually be heard, rather
	// than leaving it to be discovered one padlock at a time.
	await expect(page.getByText("3 playable, 1 gated")).toBeVisible();
});

test("pressing play starts the queue and raises the bar", async ({ page }) => {
	await page.goto(ALBUM_URL);
	await page.getByRole("button", { name: "Play", exact: true }).first().click();

	await expect(page.locator(BAR)).toBeVisible();
	await expect.poll(() => playing(page)).toBe(MEDIA_FIXTURE_TRACKS[0].title);

	/*
	 * 🚨 Asserted from the CONTROL, not from a DOM query for `<audio>`.
	 *
	 * The first version of this line was
	 *   `!!document.querySelector("audio")?.paused === false`
	 * which is a tautology: the provider builds its element with `new Audio()`, so it is
	 * never in the DOM, `querySelector` returns null, `null?.paused` is `undefined`, and
	 * `!!undefined === false` is **true** whether or not anything is playing. It passed
	 * against a player that had not started, and would have gone on passing forever.
	 *
	 * The transport's primary button reads "Pause" exactly while playback is running, so
	 * this is the same fact asked of something that can actually be false.
	 */
	await expect(page.locator(BAR).getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});

test("the queue steps over a gated track rather than stalling on it", async ({ page }) => {
	await page.goto(ALBUM_URL);

	// Start on the track immediately BEFORE the gate, so the next transition is the one
	// under test and nothing else has to happen first.
	const beforeGate = MEDIA_FIXTURE_TRACKS[1];
	const afterGate = MEDIA_FIXTURE_TRACKS[3];
	await page.locator("[data-testid=track-row]").filter({ hasText: beforeGate.title }).click();
	await expect.poll(() => playing(page)).toBe(beforeGate.title);

	/*
	 * Watch every title the bar shows, rather than only the final one.
	 *
	 * Asserting "it ends up on track 4" alone would pass against a player that stopped on
	 * the gate for three seconds and then moved on — visibly broken, and green. The
	 * recorded sequence is what proves the gated track was never selected at all.
	 */
	const seen = new Set<string>();
	await expect
		.poll(
			async () => {
				const t = await playing(page);
				if (t) seen.add(t);
				return t;
			},
			{
				timeout: 20_000,
				intervals: [250],
				message: "the queue never reached the track after the gate",
			},
		)
		.toBe(afterGate.title);

	expect([...seen], "the queue stopped on the gated track").not.toContain(GATED.title);
});

test("choosing a gated track selects it and says why, rather than playing something else", async ({
	page,
}) => {
	await page.goto(ALBUM_URL);
	const beforeGate = MEDIA_FIXTURE_TRACKS[1];
	await page.locator("[data-testid=track-row]").filter({ hasText: beforeGate.title }).click();
	await expect.poll(() => playing(page)).toBe(beforeGate.title);

	// Pause first, so the auto-advance cannot race the deliberate step.
	await page.locator(BAR).getByRole("button", { name: "Pause", exact: true }).click();
	await page.locator(BAR).getByRole("button", { name: "Next", exact: true }).click();

	// An explicit next lands ON the gate — that is the asymmetry the model encodes: the
	// listener asked for the next track, so give them the next track and explain it.
	await expect.poll(() => playing(page)).toBe(GATED.title);
	await expect(page.locator(BAR)).toContainText("Gated by");
	await expect(page.locator(BAR).getByRole("link", { name: /unlock/i })).toBeVisible();
});

test("listening survives navigating away", async ({ page }) => {
	await page.goto(ALBUM_URL);
	await page.getByRole("button", { name: "Play", exact: true }).first().click();
	await expect.poll(() => playing(page)).toBe(MEDIA_FIXTURE_TRACKS[0].title);

	// A client-side navigation, which is the case that matters: the provider sits above
	// the router, so the element is never torn down.
	await page.getByRole("link", { name: "Resources" }).first().click();
	await expect(page).toHaveURL(/\/resources/);
	await expect(page.locator(BAR)).toBeVisible();
	expect(await playing(page)).toBe(MEDIA_FIXTURE_TRACKS[0].title);
});

test("lyrics show on a free track and never on a gated one", async ({ page }) => {
	await page.goto(`/works/${FREE_WITH_LYRICS.slug}-${FREE_WITH_LYRICS.publicId}`);
	await expect(page.getByText("Lyrics", { exact: true })).toBeVisible();
	// The line breaks are the content: `whitespace-pre-wrap`, not a paragraph.
	await expect(page.getByText("First verse, second line")).toBeVisible();

	await page.goto(`/works/${GATED.slug}-${GATED.publicId}`);
	// 🚨 The negative one. The fixture's gated track has lyrics in the database, so this
	// fails the moment they stop being withheld — an all-empty implementation would pass
	// the positive case above and this one, which is why both exist.
	await expect(page.getByText(GATED.lyrics ?? "")).toHaveCount(0);
	await expect(page.getByText("Lyrics", { exact: true })).toHaveCount(0);
});
