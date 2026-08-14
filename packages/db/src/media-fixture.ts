// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The **media fixture** — a creator whose only job is to own Works that really play.
 *
 * 🚨 **It exists because the User Gauntlet fixture is a shared mutable resource and the
 * player specs cannot borrow it.** `db:gauntlet` deletes every Work belonging to
 * `gauntlet_creator` on each reset, and the gauntlet walk resets at the top of its own
 * `beforeAll` — in a Playwright project that runs *alongside* the `authed` project. So a
 * spec that seeds media into the gauntlet's Works races the walk that deletes them: the
 * transcode row vanishes mid-encode and `db:gauntlet:media` dies with
 * `job finished as "undefined"`. That is not a flake to retry around, it is two suites
 * owning one fixture.
 *
 * This one is owned by nobody else. Nothing resets it, so seeding is **idempotent and
 * cheap**: a Work that already carries a completed transcode is left alone, which means
 * ffmpeg runs once on a machine and never again.
 *
 * The *shape* lives here, in `packages/db`, beside the gauntlet's. The media production
 * lives in `apps/api/src/scripts/seed-media-fixture.ts`, because transcoding and storage
 * are the API's and `packages/db` must not depend upward on an app. Same split, same
 * reason.
 */

/** Public ids are fixed and far from the gauntlet's 9000000xx block, so they cannot collide. */
const PUBLIC_ID_BASE = 910000000;

export const MEDIA_FIXTURE_USERNAME = "media_fixture";
export const MEDIA_FIXTURE_EMAIL = "media_fixture@example.test";
/** Long enough for the password policy; this account is never signed into by a human. */
export const MEDIA_FIXTURE_PASSWORD = "mediafixturepassword123";
export const MEDIA_FIXTURE_DISPLAY_NAME = "Media Fixture";

/** Prefix every Work slug shares, so the fixture's footprint is one `like` away. */
export const MEDIA_FIXTURE_SLUG_PREFIX = "media-fixture-";

export interface MediaFixtureWork {
	/** Stable key for referring to it from a spec. */
	key: string;
	slug: string;
	publicId: number;
	title: string;
	media: "video" | "audio" | "ebook";
	/** Position within the fixture's Project — the album's track order. */
	trackNumber: number;
	/**
	 * Gated behind one Seed to this creator, rather than free to everyone.
	 *
	 * 🚨 **The album has to contain one.** A queue that can only ever hold playable tracks
	 * cannot demonstrate — or test — the one rule Garnet's model has no equivalent for:
	 * that Anthers resolves access per request, so a queue legitimately holds tracks the
	 * listener turns out not to own. An all-free fixture makes the skip logic structurally
	 * invisible, which is the "sabotage tells you where the test ISN'T" shape.
	 */
	gated?: boolean;
	/** Untimestamped words, so the lyrics surfaces have something real to render. */
	lyrics?: string;
}

/**
 * The Works.
 *
 * One video and four audio tracks. Four rather than one because the music work needs a
 * queue with somewhere to advance *to* — a single-track album cannot tell a "next" that
 * works from a "next" that silently does nothing — and because **track 3 is gated**, which
 * is what makes the skip-over-locked behaviour observable at all.
 *
 * The gated one is in the MIDDLE on purpose: at the end it would be indistinguishable from
 * the queue simply running out.
 */
export const MEDIA_FIXTURE_WORKS: MediaFixtureWork[] = [
	{
		key: "ebook",
		slug: `${MEDIA_FIXTURE_SLUG_PREFIX}comic`,
		publicId: PUBLIC_ID_BASE + 2,
		title: "A comic that really turns",
		media: "ebook",
		trackNumber: 0,
	},
	{
		key: "video",
		slug: `${MEDIA_FIXTURE_SLUG_PREFIX}video`,
		publicId: PUBLIC_ID_BASE + 1,
		title: "A short film that really plays",
		media: "video",
		trackNumber: 0,
	},
	{
		key: "track1",
		slug: `${MEDIA_FIXTURE_SLUG_PREFIX}track-1`,
		publicId: PUBLIC_ID_BASE + 11,
		title: "Track 1",
		media: "audio",
		trackNumber: 1,
		lyrics: "First verse, first line\nFirst verse, second line\n\nChorus goes here",
	},
	{
		key: "track2",
		slug: `${MEDIA_FIXTURE_SLUG_PREFIX}track-2`,
		publicId: PUBLIC_ID_BASE + 12,
		title: "Track 2",
		media: "audio",
		trackNumber: 2,
	},
	{
		key: "track3",
		slug: `${MEDIA_FIXTURE_SLUG_PREFIX}track-3`,
		publicId: PUBLIC_ID_BASE + 13,
		title: "Track 3 (gated)",
		media: "audio",
		trackNumber: 3,
		gated: true,
		// Gated lyrics, so the withholding has something to withhold. A viewer without
		// access must see neither these words nor the audio.
		lyrics: "These words are behind the gate",
	},
	{
		key: "track4",
		slug: `${MEDIA_FIXTURE_SLUG_PREFIX}track-4`,
		publicId: PUBLIC_ID_BASE + 14,
		title: "Track 4",
		media: "audio",
		trackNumber: 4,
	},
];

/** Look a fixture Work up by key. Throws rather than returning undefined, so a typo in a
 *  spec fails at the assertion that names it instead of three lines later. */
export function mediaFixtureWork(key: string): MediaFixtureWork {
	const found = MEDIA_FIXTURE_WORKS.find((w) => w.key === key);
	if (!found) throw new Error(`No media fixture Work "${key}"`);
	return found;
}

/** The audio Works, in track order — the fixture's "album". */
export const MEDIA_FIXTURE_TRACKS = MEDIA_FIXTURE_WORKS.filter((w) => w.media === "audio").sort(
	(a, b) => a.trackNumber - b.trackNumber,
);

/** The Project the tracks sit in, ordered. An album is a Project of ordered audio Works. */
export const MEDIA_FIXTURE_PROJECT = {
	slug: `${MEDIA_FIXTURE_SLUG_PREFIX}album`,
	title: "An album that really plays",
	description: "Three tracks in order, for exercising the queue.",
};
