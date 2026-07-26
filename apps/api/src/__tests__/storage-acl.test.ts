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
