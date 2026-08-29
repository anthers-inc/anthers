// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Storage configuration, and the URL↔key invariant a provider migration can silently break.
 *
 * Two jobs.
 *
 * **1. Prove the configuration is REQUIRED rather than guessed.** ⚠️ This file once pinned
 * the opposite — that every default reproduced a working URL for the provider of the day —
 * and that property became the defect: the region default it pinned is the specific value
 * that made every Cloudflare R2 call fail. What needs pinning is that a half-configured
 * environment fails loudly at boot instead of on the first upload.
 *
 * **2. Pin the invariant `urlToKey(getUrl(key)) === key`.** Absolute URLs are persisted —
 * playlists, HLS manifests, processed audio and some thumbnails go into the database as
 * full URLs — and are decoded back to keys by taking the URL's **pathname**. The two halves
 * live in different modules and neither fails when they disagree. The failure mode is
 * specific and nasty: point the public base at a **path-style** endpoint and the bucket name
 * is prepended to every key written from then on, so newly uploaded media 404s while
 * everything older keeps working. That reads as an upload bug for as long as it takes
 * somebody to think of storage.
 */
import { describe, expect, it } from "bun:test";
import { urlToKey } from "../routes/content";
import { publicUrlFor, resolveStorageConfig } from "../services/storage/config";

/**
 * A complete, valid environment — production's shape, with the two buckets split.
 *
 * Spread it and override only what a test is about. Every variable here is now REQUIRED, so
 * a partial object throws; that is the point, and `base()` keeps it from becoming noise in
 * tests that care about something else.
 */
const base = (over: Record<string, string> = {}) => ({
	STORAGE_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
	STORAGE_REGION: "auto",
	STORAGE_BUCKET: "anthers-media-private",
	STORAGE_PUBLIC_BUCKET: "anthers-media-public",
	STORAGE_PUBLIC_BASE_URL: "https://cdn.anthers.org",
	STORAGE_FORCE_PATH_STYLE: "true",
	STORAGE_KEY: "test-key",
	STORAGE_SECRET: "test-secret",
	...over,
});

/** Keys as the application actually mints them — see the media-upload presign route. */
const REAL_KEYS = [
	"creators/1/assets/9f2c4ad1e0b34f6.zip",
	"creators/42/videos/hls/8a1b2c3d/master.m3u8",
	"creators/42/videos/hls/8a1b2c3d/segment_00042.ts",
	"creators/7/thumbnails/deadbeefcafe.jpg",
	"creators/7/audio/originals/1234abcd.flac",
];

describe("the configuration is required, not guessed", () => {
	/**
	 * 🚨 These replace a suite that asserted the opposite — that every unset variable fell
	 * back to a DigitalOcean Spaces string. That was correct while Spaces was live and became
	 * a liability the moment it wasn't: `STORAGE_REGION` defaulting to `nyc3` is exactly what
	 * made every R2 call fail, and because SigV4 folds region into the credential scope it
	 * surfaced on presigned URLs as `SignatureDoesNotMatch` rather than as anything about a
	 * region. A default that is right for a vendor you have left is worse than no default.
	 */
	it("throws when nothing is set, rather than inventing an endpoint", () => {
		expect(() => resolveStorageConfig({})).toThrow(/Storage is not configured/);
	});

	it("names every missing variable at once, so it takes one round trip to fix", () => {
		try {
			resolveStorageConfig({ STORAGE_ENDPOINT: "https://x.example", STORAGE_REGION: "auto" });
			throw new Error("expected resolveStorageConfig to throw");
		} catch (e) {
			const m = (e as Error).message;
			expect(m).toContain("STORAGE_BUCKET");
			expect(m).toContain("STORAGE_PUBLIC_BASE_URL");
			expect(m).toContain("STORAGE_KEY");
			expect(m).toContain("STORAGE_SECRET");
			// The two that WERE supplied must not be reported as missing.
			expect(m).not.toContain("STORAGE_ENDPOINT");
			expect(m).not.toContain("STORAGE_REGION");
		}
	});

	it("no longer honours the SPACES_* names at all", () => {
		// The fallback existed because a live Spaces deployment would have failed every
		// upload on empty credentials during a rename. That deployment is deleted, so an
		// environment carrying only the old names is now a misconfiguration and says so.
		expect(() =>
			resolveStorageConfig({
				SPACES_REGION: "nyc3",
				SPACES_BUCKET: "anthers-media",
				SPACES_KEY: "AKIA",
				SPACES_SECRET: "s3cr3t",
			}),
		).toThrow(/Storage is not configured/);
	});

	it("treats whitespace as unset, because a dashboard paste can leave a space", () => {
		expect(() => resolveStorageConfig(base({ STORAGE_KEY: "   " }))).toThrow(/STORAGE_KEY/);
	});
});

describe("pointing it somewhere else", () => {
	it("takes an explicit endpoint and public base", () => {
		const config = resolveStorageConfig(base());
		expect(config.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
		expect(config.publicBaseUrl).toBe("https://cdn.anthers.org");
		expect(config.forcePathStyle).toBe(true);
	});

	it("tolerates a trailing slash on the public base", () => {
		// Otherwise the URL gets a double slash, the pathname keeps it, and the key comes
		// back with a leading empty segment. A trailing slash is exactly what someone pastes.
		const config = resolveStorageConfig(
			base({ STORAGE_PUBLIC_BASE_URL: "https://cdn.anthers.org/" }),
		);
		expect(publicUrlFor(config, "a/b.zip")).toBe("https://cdn.anthers.org/a/b.zip");
	});
});

describe("the URL↔key invariant", () => {
	it("round-trips every key shape the app mints, on the CDN custom domain", () => {
		const config = resolveStorageConfig(base());
		for (const key of REAL_KEYS) {
			expect({ key, back: urlToKey(publicUrlFor(config, key)) }).toEqual({ key, back: key });
		}
	});

	it("recovers keys from any host, so the CDN domain can change without a backfill", () => {
		// `urlToKey` takes the pathname and ignores the host, which is what made the Spaces→R2
		// move need no data migration. Nothing in the database points at Spaces any more, so
		// that specific rescue is spent — but the property is the same one that would save the
		// next domain change, and it is cheap to keep asserted rather than rediscovered.
		for (const host of [
			"https://anthers-media.nyc3.digitaloceanspaces.com", // the retired provider
			"https://cdn.anthers.org", // today
			"https://media.example.net", // whatever comes next
		]) {
			expect(urlToKey(`${host}/creators/9/audio/x.mp3`)).toBe("creators/9/audio/x.mp3");
		}
	});

	it("🚨 BREAKS against a path-style endpoint, which is why the custom domain is required", () => {
		// R2's S3 API is path-style: the bucket sits in the path, so the pathname is no
		// longer the key. This is the one configuration that must never reach production,
		// and the test exists to make the consequence concrete rather than cautionary.
		const config = resolveStorageConfig(
			base({
				STORAGE_PUBLIC_BASE_URL: "https://abc123.r2.cloudflarestorage.com/anthers-media-public",
			}),
		);
		const key = "creators/1/assets/game.zip";
		expect(urlToKey(publicUrlFor(config, key))).toBe(
			"anthers-media-public/creators/1/assets/game.zip",
		);
		expect(urlToKey(publicUrlFor(config, key))).not.toBe(key);
	});

	it("is lossy for a key containing a literal % — known, pre-existing, not fixed here", () => {
		// Keys end in a user-supplied extension (`filename.split(".").pop()`), so this is
		// reachable rather than theoretical. Pinned so that adding encoding later is a
		// deliberate change with a failing test to update, not a silent one — fixing it
		// properly means encoding on the way out AND migrating stored URLs.
		const config = resolveStorageConfig(base());
		expect(urlToKey(publicUrlFor(config, "creators/1/assets/a%20b.zip"))).toBe(
			"creators/1/assets/a b.zip",
		);
	});
});
