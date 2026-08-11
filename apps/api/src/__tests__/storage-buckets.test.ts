// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which bucket an object belongs in — the public/private boundary, once it stopped being a
 * per-object flag.
 *
 * On S3 and DigitalOcean Spaces, `public-read` versus `private` rides on the object, so both
 * kinds share a bucket and a mistake exposes exactly one file. **Cloudflare R2 has no
 * per-object ACL.** Access is granted by attaching a custom domain to a *bucket*, and
 * everything in it becomes readable by anyone who knows the key. So the boundary has to move
 * up a level, and this is the file that says it is in the right place.
 *
 * The failure this guards against is not subtle in effect and is entirely silent in
 * operation: put one bucket behind a CDN domain while game assets, HLS segments and
 * processed audio sit in it, and every gated deliverable is a public URL. `acl.ts` already
 * records that gated HLS playlists reached production world-readable once, through the
 * per-object version of the same mistake.
 *
 * Two halves have to agree, and they are written from opposite ends:
 * `aclForMediaType` answers at **write** time, from the media type; `isPublicKey` answers at
 * **read** time, from the key. The last suite here is the one that checks they say the same
 * thing about the same object.
 */
import { describe, expect, it } from "bun:test";
import { aclForMediaType, isPublicKey, PUBLIC_MEDIA_TYPES } from "../services/storage/acl";
import { resolveStorageConfig } from "../services/storage/config";

/**
 * Keys exactly as the media-upload route mints them.
 *
 * ⚠️ Mirrored by hand from the `switch (mediaType)` in `routes/content.ts`, because that
 * mapping is inline in a route rather than an exported function. If it moves, this table is
 * the record of what storage was told to expect — update both, and prefer exporting the
 * mapping over widening this comment.
 */
const KEY_FOR: Record<string, string> = {
	avatar: "creators/7/avatars/abc123.png",
	header: "creators/7/headers/abc123.jpg",
	cover: "creators/7/covers/42/abc123.jpg",
	thumbnail: "creators/7/thumbnails/42/abc123.jpg",
	gallery: "creators/7/gallery/42/abc123.png",
	image: "creators/7/gallery/42/abc123.png",
	screenshot: "creators/7/gallery/42/abc123.png",
	"inline-image": "creators/7/inline-images/42/abc123.png",
	"jam-cover": "creators/7/jams/covers/42/abc123.png",
	video: "creators/7/videos/originals/abc123.mp4",
	audio: "creators/7/audio/originals/abc123.flac",
	asset: "creators/7/assets/42/abc123.zip",
};

/** Keys minted by the transcode/package jobs rather than by an upload. */
const HLS_SEGMENT = "creators/7/videos/hls/deadbeef/segment_00042.ts";
const HLS_MASTER = "creators/7/videos/hls/deadbeef/master.m3u8";
const JOB_THUMBNAIL = "creators/7/thumbnails/cafebabe.jpg";
const PROCESSED_AUDIO = "creators/7/audio/processed/abc123.mp3";

describe("the split is off until a second bucket is configured", () => {
	it("puts both kinds in one bucket by default, exactly as Spaces always has", () => {
		// The property that makes introducing this a no-op: with no `STORAGE_PUBLIC_BUCKET`,
		// every object resolves to the same bucket and the routing cannot be wrong.
		const config = resolveStorageConfig({ SPACES_BUCKET: "anthers-media", SPACES_REGION: "nyc3" });
		expect(config.bucket).toBe("anthers-media");
		expect(config.publicBucket).toBe("anthers-media");
		expect(config.publicBaseUrl).toBe("https://anthers-media.nyc3.digitaloceanspaces.com");
	});

	it("separates them, and points the public base at the PUBLIC bucket", () => {
		// Getting this backwards would build CDN URLs naming the private bucket — which is
		// both wrong and, on a provider where the CDN domain is the grant, a way to ask for
		// exactly the exposure this whole split exists to prevent.
		const config = resolveStorageConfig({
			STORAGE_BUCKET: "anthers-media-private",
			STORAGE_PUBLIC_BUCKET: "anthers-media-public",
			STORAGE_REGION: "nyc3",
		});
		expect(config.bucket).toBe("anthers-media-private");
		expect(config.publicBucket).toBe("anthers-media-public");
		expect(config.publicBaseUrl).toBe("https://anthers-media-public.nyc3.digitaloceanspaces.com");
	});
});

describe("what counts as public, by key", () => {
	it("accepts display chrome", () => {
		for (const key of [
			KEY_FOR.avatar,
			KEY_FOR.header,
			KEY_FOR.cover,
			KEY_FOR.thumbnail,
			KEY_FOR.gallery,
			KEY_FOR["inline-image"],
			KEY_FOR["jam-cover"],
			JOB_THUMBNAIL,
		]) {
			expect({ key, public: isPublicKey(key) }).toEqual({ key, public: true });
		}
	});

	it("refuses every gated deliverable", () => {
		for (const key of [
			KEY_FOR.video,
			KEY_FOR.audio,
			KEY_FOR.asset,
			HLS_SEGMENT,
			HLS_MASTER,
			PROCESSED_AUDIO,
		]) {
			expect({ key, public: isPublicKey(key) }).toEqual({ key, public: false });
		}
	});

	it("fails closed on anything it does not recognise", () => {
		// The same posture as `aclForMediaType`: an unlisted prefix, a legacy key shape, or
		// a string a client invented is private. Getting this backwards is the difference
		// between an object nobody can read and an object everybody can.
		for (const key of [
			"creators/7/uploads/abc123.bin", // the route's `default:` branch
			"creators/7/avatarsomething/x.png", // prefix-adjacent, not a prefix
			"legacy/thumbnails/x.jpg", // pre-`creators/` shape
			"thumbnails/x.jpg",
			"creators/abc/thumbnails/x.jpg", // non-numeric id
			"",
			"../creators/7/thumbnails/x.jpg",
		]) {
			expect({ key, public: isPublicKey(key) }).toEqual({ key, public: false });
		}
	});
});

describe("the write-time and read-time halves agree", () => {
	/**
	 * The actual invariant. `aclForMediaType` decides from the media type when the object is
	 * uploaded; `isPublicKey` decides from the key on every read and delete afterwards. They
	 * are in the same file and derived from the same list, and they are still two functions
	 * that could drift — at which point an object would be *written* to one bucket and
	 * *looked for* in the other, producing 404s for public chrome or, worse, a private object
	 * written into the public bucket.
	 */
	it("gives the same answer for every media type the route accepts", () => {
		for (const [mediaType, key] of Object.entries(KEY_FOR)) {
			expect({ mediaType, acl: aclForMediaType(mediaType) === "public" }).toEqual({
				mediaType,
				acl: isPublicKey(key),
			});
		}
	});

	it("covers every type on the public allowlist, so the table cannot silently fall behind", () => {
		// Without this, adding a media type to PUBLIC_MEDIA_TYPES and forgetting to add its
		// key prefix would leave the suite above green while the new type's objects were
		// written public and read private.
		for (const mediaType of PUBLIC_MEDIA_TYPES) {
			expect({ mediaType, hasKey: mediaType in KEY_FOR }).toEqual({ mediaType, hasKey: true });
		}
	});
});
