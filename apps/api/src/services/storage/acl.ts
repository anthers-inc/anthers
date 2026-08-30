// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which uploaded media is world-readable — a pure allowlist, so the decision is
 * testable without S3, a bucket, or a network. Same shape as `services/access.ts`
 * and `packages/shared/src/attention.ts`: the policy is a function, and the caller
 * consults it rather than restating it.
 *
 * The rule is stated as an ALLOWLIST on purpose. It used to be a denylist at the
 * upload route — "private if video/audio/asset, else public" — and `mediaType`
 * arrives unvalidated straight off a multipart form, so any unrecognized value fell
 * through to the catch-all key prefix *and* came out public. Inverted, an unknown
 * type is locked, and a media type added to the route's switch later stays locked
 * until someone deliberately lists it here.
 */

/**
 * Display chrome — the imagery a viewer is meant to see *before* they have access:
 * avatars, headers, covers, thumbnails, gallery shots, inline post images.
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

/**
 * The key prefixes that hold display chrome, under `creators/{id}/`.
 *
 * This is the same policy as `PUBLIC_MEDIA_TYPES` seen from the other end. The allowlist
 * above answers *"may this upload be world-readable?"* at write time, when the media type
 * is in hand; this answers *"is this object world-readable?"* at read time, when only the
 * key is. Both must say the same thing about the same object, and `storage-buckets.test.ts`
 * asserts they do against the key shapes the media-upload route actually mints.
 *
 * 🚨 **This became load-bearing when storage moved to a provider without per-object ACLs.**
 * On S3 and Spaces, `public-read` versus `private` is carried by the object itself, so the
 * two kinds can share a bucket and a mistake exposes exactly one file. Cloudflare R2 has no
 * per-object ACL: access is granted by attaching a custom domain to a **bucket**, and
 * everything inside it becomes readable by key. So the boundary has to be the bucket, and
 * this function is what decides which one an object belongs to.
 *
 * Fails closed, like the allowlist above: a key that does not match the expected shape, or
 * sits under a prefix nobody listed, is private.
 */
export const PUBLIC_KEY_PREFIXES: readonly string[] = [
	"avatars/",
	"headers/",
	"covers/",
	"thumbnails/",
	"gallery/",
	"inline-images/",
];

/** Whether a storage key holds display chrome, and so belongs in the public bucket. */
export function isPublicKey(key: string): boolean {
	// Every key the application mints is `creators/{id}/…`; the media type is the segment
	// (or two) that follows. Anything else is unrecognized and therefore private.
	const match = /^creators\/\d+\/(.+)$/.exec(key);
	if (!match) return false;
	return PUBLIC_KEY_PREFIXES.some((prefix) => match[1].startsWith(prefix));
}

/**
 * Where quarantined material is parked, in the private bucket, with no way back out.
 *
 * 🚨 **This prefix is the second of two independent denials, and it exists because the
 * first one can be forgotten.** `resolveAccessSync` refuses a quarantined Work to
 * everybody including its buyers, which every delivery route inherits — but a route
 * added later that signs a key without resolving a Work would hand the bytes over, and
 * that is the one failure in this codebase with no acceptable version. So the key
 * itself is unservable: {@link assertServableKey} throws in `getUrl` and in the
 * presigner, which is every door bytes leave through.
 *
 * It is deliberately NOT under `creators/{id}/`, so `isPublicKey` returns false for it
 * on the existing fail-closed path rather than on a new rule that could disagree.
 */
export const QUARANTINE_PREFIX = "quarantine/";

/** Whether a storage key names quarantined material. */
export function isQuarantinedKey(key: string): boolean {
	return key.startsWith(QUARANTINE_PREFIX);
}

/**
 * The key a quarantined object is parked at. Reversible on purpose — a quarantine is a
 * state and never a delete, so a cleared finding has to be able to put the object back
 * exactly where the database still says it is.
 */
export function quarantineKeyFor(key: string): string {
	return isQuarantinedKey(key) ? key : `${QUARANTINE_PREFIX}${key}`;
}

/** The key a quarantined object came from. Inverse of {@link quarantineKeyFor}. */
export function originalKeyFor(key: string): string {
	return isQuarantinedKey(key) ? key.slice(QUARANTINE_PREFIX.length) : key;
}

/**
 * Refuse to produce any URL for quarantined material. Called by both storage backends.
 *
 * Throwing rather than returning null is the whole point: a null would be handed to a
 * caller expecting a string and would surface as an odd 404 somewhere downstream, which
 * is indistinguishable from an ordinary missing object. A throw stops the request, and a
 * 500 on a quarantined key is the correct outcome — nothing should be asking.
 */
export function assertServableKey(key: string): void {
	if (isQuarantinedKey(key)) {
		throw new Error(`Refusing to serve quarantined object: ${key}`);
	}
}
