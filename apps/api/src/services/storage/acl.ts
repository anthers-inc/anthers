// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which uploaded media is world-readable — a pure allowlist, so the decision is
 * testable without S3, a bucket, or a network. Same shape as `services/access.ts`
 * and `packages/shared/src/attention.ts`: the policy is a function, and the caller
 * consults it rather than restating it.
 *
 * The rule is stated as an ALLOWLIST on purpose. It used to be a denylist at the
 * upload route — "private if video/audio/asset, else public" — and `mediaType`
 * arrives unvalidated straight off a multipart form, so any unrecognised value fell
 * through to the catch-all key prefix *and* came out public. Inverted, an unknown
 * type is locked, and a media type added to the route's switch later stays locked
 * until someone deliberately lists it here.
 */

/**
 * Display chrome — the imagery a viewer is meant to see *before* they have access:
 * avatars, headers, covers, thumbnails, gallery shots, inline post images, jam art.
 * Nothing here is ever a gated deliverable, which is the entire test for membership.
 */
export const PUBLIC_MEDIA_TYPES: ReadonlySet<string> = new Set([
	"avatar",
	"header",
	"cover",
	"thumbnail",
	"gallery",
	"image",
	"screenshot",
	"inline-image",
	"jam-cover",
]);

/**
 * The stored ACL for an uploaded media type. Fails closed: anything not explicitly
 * listed as display chrome — including `null`, `undefined`, and any string a client
 * invents — is private, and reaches viewers only through an access-checked endpoint
 * that signs per request.
 */
export function aclForMediaType(mediaType: string | null | undefined): "public" | "private" {
	return PUBLIC_MEDIA_TYPES.has(mediaType ?? "") ? "public" : "private";
}
