// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Storage configuration, and the URL↔key invariant a provider migration can silently break.
 *
 * Two jobs, and the first is the reason this file exists tonight rather than later.
 *
 * **1. Prove the Spaces→configurable change is a no-op.** The endpoint and public URL base
 * used to be hard-coded; they are now resolved from the environment. Every default has to
 * reproduce the old string exactly, or "we only made it configurable" is a claim rather
 * than a fact.
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

const SPACES = { SPACES_REGION: "nyc3", SPACES_BUCKET: "anthers-media" };

/** Keys as the application actually mints them — see the media-upload presign route. */
const REAL_KEYS = [
	"creators/1/assets/9f2c4ad1e0b34f6.zip",
	"creators/42/videos/hls/8a1b2c3d/master.m3u8",
	"creators/42/videos/hls/8a1b2c3d/segment_00042.ts",
	"creators/7/thumbnails/deadbeefcafe.jpg",
	"creators/7/audio/originals/1234abcd.flac",
];

describe("the defaults reproduce DigitalOcean Spaces exactly", () => {
	it("builds the endpoint and public base that were hard-coded before", () => {
		// The two literal strings this change replaced. If either drifts, an environment
		// that sets nothing new starts talking to a different place — which is precisely
		// what "no-op" is supposed to rule out.
		const config = resolveStorageConfig(SPACES);
		expect(config.endpoint).toBe("https://nyc3.digitaloceanspaces.com");
		expect(config.publicBaseUrl).toBe("https://anthers-media.nyc3.digitaloceanspaces.com");
		expect(config.forcePathStyle).toBe(false);
		expect(publicUrlFor(config, "creators/1/x.zip")).toBe(
			"https://anthers-media.nyc3.digitaloceanspaces.com/creators/1/x.zip",
		);
	});

	it("defaults the region the way the old constant did", () => {
		expect(resolveStorageConfig({}).endpoint).toBe("https://nyc3.digitaloceanspaces.com");
	});

	it("still reads the SPACES_* names, because production has not been re-specced", () => {
		// 🚨 Pushing to `release` does not apply the committed spec — production keeps
		// whatever `doctl` last set. Without this fallback the rename would deploy cleanly,
		// start cleanly, and fail every upload with empty credentials.
		const config = resolveStorageConfig({
			...SPACES,
			SPACES_KEY: " AKIA ",
			SPACES_SECRET: "s3cr3t",
		});
		expect(config.accessKeyId).toBe("AKIA");
		expect(config.bucket).toBe("anthers-media");
		expect(config.secretAccessKey).toBe("s3cr3t");
	});

	it("prefers the new names when both are present", () => {
		const config = resolveStorageConfig({
			...SPACES,
			SPACES_BUCKET: "old-bucket",
			STORAGE_BUCKET: "new-bucket",
		});
		expect(config.bucket).toBe("new-bucket");
	});
});

describe("pointing it somewhere else", () => {
	it("takes an explicit endpoint and public base", () => {
		const config = resolveStorageConfig({
			STORAGE_REGION: "auto",
			STORAGE_BUCKET: "anthers-media-private",
			STORAGE_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
			STORAGE_PUBLIC_BASE_URL: "https://cdn.anthers.org",
			STORAGE_FORCE_PATH_STYLE: "true",
		});
		expect(config.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
		expect(config.publicBaseUrl).toBe("https://cdn.anthers.org");
		expect(config.forcePathStyle).toBe(true);
	});

	it("tolerates a trailing slash on the public base", () => {
		// Otherwise the URL gets a double slash, the pathname keeps it, and the key comes
		// back with a leading empty segment. A trailing slash is exactly what someone pastes.
		const config = resolveStorageConfig({ STORAGE_PUBLIC_BASE_URL: "https://cdn.anthers.org/" });
		expect(publicUrlFor(config, "a/b.zip")).toBe("https://cdn.anthers.org/a/b.zip");
	});
});

describe("the URL↔key invariant", () => {
	it("round-trips every key shape the app mints, on Spaces", () => {
		const config = resolveStorageConfig(SPACES);
		for (const key of REAL_KEYS) {
			expect({ key, back: urlToKey(publicUrlFor(config, key)) }).toEqual({ key, back: key });
		}
	});

	it("round-trips them on a CDN custom domain — the post-migration shape", () => {
		const config = resolveStorageConfig({ STORAGE_PUBLIC_BASE_URL: "https://cdn.anthers.org" });
		for (const key of REAL_KEYS) {
			expect({ key, back: urlToKey(publicUrlFor(config, key)) }).toEqual({ key, back: key });
		}
	});

	it("still recovers keys from URLs written against the OLD provider", () => {
		// The rows already in the database. `urlToKey` is hostname-agnostic, so a migration
		// needs no backfill — this asserts the property that makes that true, rather than
		// leaving it as an assumption somebody has to re-derive under time pressure.
		const stored = "https://anthers-media.nyc3.digitaloceanspaces.com/creators/9/audio/x.mp3";
		expect(urlToKey(stored)).toBe("creators/9/audio/x.mp3");
	});

	it("🚨 BREAKS against a path-style endpoint, which is why the custom domain is required", () => {
		// R2's S3 API is path-style: the bucket sits in the path, so the pathname is no
		// longer the key. This is the one configuration that must never reach production,
		// and the test exists to make the consequence concrete rather than cautionary.
		const config = resolveStorageConfig({
			STORAGE_PUBLIC_BASE_URL: "https://abc123.r2.cloudflarestorage.com/anthers-media-public",
		});
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
		const config = resolveStorageConfig(SPACES);
		expect(urlToKey(publicUrlFor(config, "creators/1/assets/a%20b.zip"))).toBe(
			"creators/1/assets/a b.zip",
		);
	});
});
