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

/**
 * A complete, valid environment. Every storage variable is required now — the Spaces-shaped
 * defaults were removed once that provider was retired — so spread this and override only
 * what the test is about.
 */
const base = (over: Record<string, string> = {}) => ({
	STORAGE_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
	STORAGE_REGION: "auto",
	STORAGE_BUCKET: "anthers-media-private",
	STORAGE_PUBLIC_BASE_URL: "https://cdn.anthers.org",
	STORAGE_KEY: "test-key",
	STORAGE_SECRET: "test-secret",
	...over,
});

describe("the split is off until a second bucket is configured", () => {
	it("puts both kinds in one bucket when no public bucket is named", () => {
		// `STORAGE_PUBLIC_BUCKET` is the one storage variable that still has a fallback, and
		// it is a real posture rather than a vendor guess: one bucket with per-object ACLs
		// carrying the distinction. With it unset the routing cannot be wrong, because both
		// answers are the same bucket.
		const config = resolveStorageConfig(base());
		expect(config.bucket).toBe("anthers-media-private");
		expect(config.publicBucket).toBe("anthers-media-private");
	});

	it("separates them once a public bucket is named", () => {
		// Getting this backwards would route gated deliverables into the bucket the CDN
		// domain points at — which on a provider where the domain IS the grant is a way to
		// ask for exactly the exposure this whole split exists to prevent.
		const config = resolveStorageConfig(base({ STORAGE_PUBLIC_BUCKET: "anthers-media-public" }));
		expect(config.bucket).toBe("anthers-media-private");
		expect(config.publicBucket).toBe("anthers-media-public");
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

describe("the presigned-upload ACL header follows the bucket split", () => {
	/**
	 * 🚨 This suite pins a fact about R2, not a preference — measured against a live bucket
	 * on 2026-08-11, not inferred from the S3 compatibility table.
	 *
	 * `getPresignedUploadUrl` returns headers for the client to echo verbatim. On Spaces that
	 * is load-bearing: the presigner hoists `x-amz-acl` into the query string, Spaces ignores
	 * it there, and an object whose header is dropped silently reverts to the bucket default.
	 * On R2 echoing the same header returns **403 SignatureDoesNotMatch**, because the extra
	 * header changes the canonical request the signature covers. With it, 403; without it,
	 * 200.
	 *
	 * The asymmetry worth remembering, because it is what makes the compatibility table
	 * misleading: a **direct** `PutObject` carrying `ACL` succeeds on R2 (the SDK signs what
	 * it sends). Only the **presigned** path breaks — and every creator upload is presigned.
	 * "R2 ignores x-amz-acl" is true of one path and fatally false of the other.
	 */
	it("echoes the ACL when one bucket holds both kinds, where it carries access", () => {
		expect(resolveStorageConfig(base()).sendObjectAcl).toBe(true);
	});

	it("stays silent once a second bucket carries the distinction — where it is fatal", () => {
		const config = resolveStorageConfig(base({ STORAGE_PUBLIC_BUCKET: "anthers-media-public" }));
		expect(config.sendObjectAcl).toBe(false);
	});

	it("is derived from the split alone, not from the vendor or the endpoint", () => {
		// The rule is about which layer carries access, not about who the provider is. Tying
		// it to a hostname would get both of these backwards: a two-bucket deployment on a
		// provider WITH per-object ACLs must still stay silent (the bucket already decides),
		// and a single-bucket one on a provider without them must still echo.
		const twoBucketsOnSpacesShapedEndpoint = resolveStorageConfig(
			base({
				STORAGE_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
				STORAGE_REGION: "nyc3",
				STORAGE_BUCKET: "a-private",
				STORAGE_PUBLIC_BUCKET: "a-public",
			}),
		);
		const oneBucketOnR2 = resolveStorageConfig(
			base({ STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com", STORAGE_BUCKET: "solo" }),
		);
		expect({
			twoBuckets: twoBucketsOnSpacesShapedEndpoint.sendObjectAcl,
			oneBucket: oneBucketOnR2.sendObjectAcl,
		}).toEqual({ twoBuckets: false, oneBucket: true });
	});
});
