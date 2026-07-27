// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The upload ACL allowlist — that storage fails CLOSED.
 *
 * This is a regression guard on a security posture rather than a feature. Two
 * fail-open defaults were the mechanism behind the delivery leaks fixed in the
 * delivery-access work: `S3StorageService.upload` defaulted its `acl` argument to
 * "public", and the upload route decided publicness with a denylist over a value
 * (`mediaType`) that arrives unvalidated off a multipart form — so anything the
 * route didn't recognise landed world-readable.
 *
 * Both are inverted now, and the cases below are the ones that would silently
 * regress: an unknown type, a missing type, and the catch-all. If someone adds a
 * media type to the upload route's switch and forgets this list, the object is
 * locked and they get a bug report — which is the intended failure direction.
 */
import { describe, expect, it } from "bun:test";
import { aclForMediaType, PUBLIC_MEDIA_TYPES } from "../services/storage/acl";

describe("upload ACL allowlist", () => {
	it("publishes display chrome", () => {
		// The imagery a viewer is meant to see before they have access. Enumerated
		// rather than looped over the set, so deleting an entry fails a test instead
		// of quietly shrinking both sides of the assertion.
		for (const type of [
			"avatar",
			"header",
			"cover",
			"thumbnail",
			"gallery",
			"image",
			"screenshot",
			"inline-image",
			"jam-cover",
		]) {
			expect(aclForMediaType(type), type).toBe("public");
		}
	});

	it("keeps deliverables private", () => {
		for (const type of ["video", "audio", "asset"]) {
			expect(aclForMediaType(type), type).toBe("private");
		}
	});

	it("fails closed on anything it doesn't recognise", () => {
		// The actual bug: `mediaType` is `formData.get("mediaType") as string | null`,
		// so a client can send any string, or none, and it used to come out public.
		for (const type of [null, undefined, "", "wat", "Avatar", "AVATAR", "video ", "__proto__"]) {
			expect(aclForMediaType(type), JSON.stringify(type)).toBe("private");
		}
	});

	it("treats the allowlist as exact — no case folding, no trimming", () => {
		// Recorded so nobody "helpfully" normalises the input later: loosening the
		// match is the direction that reopens the hole, and it should be a decision
		// with a test change attached, not an incidental tidy-up.
		expect(PUBLIC_MEDIA_TYPES.has("avatar")).toBe(true);
		expect(PUBLIC_MEDIA_TYPES.has("Avatar")).toBe(false);
		expect(PUBLIC_MEDIA_TYPES.has(" avatar")).toBe(false);
	});
});

/**
 * The presigned path — the other half, and the one where being "correct" in the
 * server's source is not enough.
 *
 * Verified against the live `anthers-media` bucket on 2026-07-26: the presigner hoists
 * `x-amz-acl` into the query string, and Spaces IGNORES it there — an object signed
 * `public-read` in the query came back owner-only. It is honoured only as a request
 * header. So the ACL takes effect exactly when the client echoes the header, which is
 * why `getPresignedUploadUrl` returns headers instead of leaving the caller to infer
 * them. A regression here is silent: uploads keep succeeding, objects just quietly take
 * the bucket default again.
 *
 * These run offline — presigning is local HMAC, no network and no real credentials.
 */
describe("presigned upload ACL", () => {
	// s3.ts reads its config at module scope, so the env has to exist before the import.
	process.env.SPACES_REGION ??= "nyc3";
	process.env.SPACES_BUCKET ??= "test-bucket";
	process.env.SPACES_KEY ??= "test-key";
	process.env.SPACES_SECRET ??= "test-secret";

	async function presign(acl: "public" | "private") {
		const { S3StorageService } = await import("../services/storage/s3");
		return new S3StorageService().getPresignedUploadUrl("k/obj.mp4", "video/mp4", acl);
	}

	it("returns the ACL as a header the client must echo", async () => {
		expect((await presign("private")).headers["x-amz-acl"]).toBe("private");
		expect((await presign("public")).headers["x-amz-acl"]).toBe("public-read");
	});

	it("signs a usable PUT URL", async () => {
		const { url } = await presign("private");
		const q = new URL(url).searchParams;
		expect(q.get("X-Amz-Signature")).toBeTruthy();
		expect(q.get("X-Amz-Expires")).toBe("3600");
	});

	it("local mode presigns nothing and demands no headers", async () => {
		const { LocalStorageService } = await import("../services/storage/local");
		const out = await new LocalStorageService().getPresignedUploadUrl("k", "video/mp4", "private");
		expect(out.headers).toEqual({});
		expect(out.url).toContain("/api/content/media-upload/direct");
	});
});
