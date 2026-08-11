// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which S3-compatible provider the storage service talks to, and how public URLs are built.
 *
 * Split out of `s3.ts` and made **pure** on purpose: this is the only part of the storage
 * layer that has to be right *before* a migration rather than after one, and a function
 * taking an env-shaped object can be tested against every provider's URL shape without
 * credentials, a network, or a bucket.
 *
 * ── Vendor-neutral names, with the old ones still honoured ──────────────────────────
 *
 * The variables were `SPACES_*`, which named DigitalOcean in the configuration as well as
 * in the code. The new names are `STORAGE_*` and the old ones remain as fallbacks, because
 * **pushing to `release` does not apply the committed spec** — production keeps whatever
 * `doctl` last set. A rename with no fallback would deploy fine, start, and then fail every
 * upload with empty credentials. The fallback is what lets the code ship before the spec
 * catches up, in either order.
 *
 * ── 🚨 `publicBaseUrl` is load-bearing beyond cost, and this is the subtle part ─────
 *
 * Absolute URLs are **persisted**: playlists, HLS manifests, processed audio and some
 * thumbnails go into the database as full URLs rather than keys, and `urlToKey()` in
 * `routes/content.ts` recovers the key by taking the URL's **pathname**. That works for any
 * host, so rows written against DigitalOcean keep resolving after a move — no data
 * migration. What it assumes is **virtual-hosted style**, where the pathname *is* the key:
 *
 *     https://bucket.nyc3.digitaloceanspaces.com/creators/1/x.zip  →  creators/1/x.zip  ✓
 *     https://cdn.anthers.org/creators/1/x.zip                     →  creators/1/x.zip  ✓
 *     https://acct.r2.cloudflarestorage.com/bucket/creators/1/x.zip →  bucket/creators/…  ✗
 *
 * The third is R2's S3 API endpoint, which is path-style. Point `publicBaseUrl` there and
 * every URL written *from then on* decodes to a key with the bucket name glued to the
 * front — while every older row keeps working. The symptom is 404s on newly uploaded media
 * only, which reads as an upload bug rather than a configuration one. So the custom domain
 * is not merely the cheap path; it is the one that keeps this invariant true.
 * `storage-url-roundtrip.test.ts` asserts it.
 */

export interface StorageConfig {
	region: string;
	/**
	 * The bucket holding everything gated — game assets, HLS, processed audio, originals.
	 *
	 * 🚨 **Nothing may attach a custom domain or public dev URL to this bucket.** On R2 that
	 * is what grants access, and it is granted to the whole bucket at once: every private
	 * object would become readable by anyone who knows its key. Reads happen through
	 * presigned URLs against the S3 API and nothing else.
	 */
	bucket: string;
	/**
	 * The bucket holding display chrome — avatars, headers, covers, thumbnails, gallery and
	 * inline images, jam art. This is the one the CDN custom domain points at.
	 *
	 * Defaults to `bucket`, which is what DigitalOcean Spaces has always done: one bucket,
	 * with per-object ACLs carrying the distinction. That default is why introducing the
	 * split changes nothing until a second bucket is configured.
	 */
	publicBucket: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Base for UNSIGNED public URLs. No trailing slash. See the warning above. */
	publicBaseUrl: string;
	/**
	 * Path-style addressing (`endpoint/bucket/key`) rather than virtual-hosted
	 * (`bucket.endpoint/key`).
	 *
	 * False for DigitalOcean Spaces, which requires virtual-hosted. R2's S3 API wants
	 * path-style, so this becomes true there — and note that it affects the SIGNED URLs the
	 * SDK builds, not `publicBaseUrl`, which is composed by hand.
	 */
	forcePathStyle: boolean;
	/**
	 * Whether a presigned upload should hand the client an `x-amz-acl` header to echo.
	 *
	 * 🚨 **On R2 echoing it is fatal, not merely useless — verified against a live bucket
	 * on 2026-08-11.** A presigned PUT carrying the header returns `403
	 * SignatureDoesNotMatch`; the identical PUT without it returns 200. The presigner
	 * hoists `x-amz-acl` into the query string, so a client that also sends it as a header
	 * changes the canonical request out from under the signature. Note the asymmetry that
	 * makes this easy to mis-predict: a **direct** `PutObject` with `ACL` set succeeds on
	 * R2, because there the SDK signs what it sends. Only the presigned path breaks, and
	 * every creator upload takes the presigned path.
	 *
	 * So this is derived from the bucket split rather than the vendor, because that is the
	 * rule it actually is: **one bucket means the per-object ACL is the only thing carrying
	 * access, so it must be echoed; two buckets mean the bucket carries it and the header is
	 * redundant.** Spaces is the one-bucket case and is unchanged; R2 is the two-bucket case
	 * and must stay silent. Deriving it also means there is no third variable to set
	 * correctly, and no vendor hostname to string-match.
	 *
	 * Do not "restore" the header for symmetry with `upload()`. It is load-bearing there and
	 * fatal here, and the two are not the same operation.
	 */
	sendObjectAcl: boolean;
}

/** Read a variable under its current name, then its legacy one. */
function env(source: Record<string, string | undefined>, name: string, legacy: string): string {
	return (source[`STORAGE_${name}`] ?? source[legacy] ?? "").trim();
}

/**
 * Resolve the storage configuration.
 *
 * Every default reproduces the DigitalOcean Spaces behaviour that preceded this file, so an
 * environment that sets nothing new behaves **identically** — which is the property that
 * makes introducing this a no-op rather than a change.
 */
export function resolveStorageConfig(
	source: Record<string, string | undefined> = process.env,
): StorageConfig {
	// ⚠️ `nyc3` is a DigitalOcean region and is the right default only for Spaces, where it
	// also composes the endpoint and the public URL below. **R2 rejects it.** R2 ignores
	// region for placement but still validates the name (`wnam|enam|weur|eeur|apac|oc|auto`),
	// so an R2 deployment must set `STORAGE_REGION=auto` or every call fails — direct ones
	// with `InvalidRegionName`, and presigned ones as `SignatureDoesNotMatch`, because SigV4
	// folds the region into the credential scope and the mismatch surfaces as a bad signature
	// rather than as a bad region. That second symptom is the one that wastes an afternoon.
	const region = env(source, "REGION", "SPACES_REGION") || "nyc3";
	const bucket = env(source, "BUCKET", "SPACES_BUCKET");
	// Same bucket unless told otherwise — see the field docs for why that is the safe default.
	const publicBucket = env(source, "PUBLIC_BUCKET", "") || bucket;

	// Defaults to the Spaces endpoint for the region, exactly as before.
	const endpoint = env(source, "ENDPOINT", "") || `https://${region}.digitaloceanspaces.com`;

	// Defaults to the Spaces virtual-hosted bucket URL, exactly as before. A deployment
	// that fronts storage with a CDN sets this to that hostname and nothing else changes.
	// Built from the PUBLIC bucket, since that is what it addresses. Identical to the old
	// hard-coded string while the two buckets are the same.
	const publicBaseUrl =
		env(source, "PUBLIC_BASE_URL", "") ||
		`https://${publicBucket}.${region}.digitaloceanspaces.com`;

	return {
		region,
		bucket,
		publicBucket,
		endpoint,
		// Trim: a stray newline/space pasted into a dashboard secret silently corrupts the
		// SigV4 HMAC and yields a baffling SignatureDoesNotMatch.
		accessKeyId: env(source, "KEY", "SPACES_KEY"),
		secretAccessKey: env(source, "SECRET", "SPACES_SECRET"),
		publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
		forcePathStyle: (source.STORAGE_FORCE_PATH_STYLE ?? "").trim() === "true",
		// One bucket → the ACL is the only thing carrying access. Two → the bucket is.
		sendObjectAcl: publicBucket === bucket,
	};
}

/**
 * The public URL for a key.
 *
 * Deliberately a bare concatenation, byte-identical to what `s3.ts` did before this file
 * existed, because the point of this change is to be a no-op. Do not add encoding here as a
 * drive-by: it would be an improvement, and it would also be a silent behaviour change to
 * every URL the application hands out and every URL already written to the database.
 *
 * ⚠️ **Known pre-existing gap, found while writing this and left alone on purpose.** Keys
 * end in a user-supplied extension (`filename.split(".").pop()` in the media-upload presign
 * route), so a key *can* contain characters that need encoding. For ordinary keys the round
 * trip through `urlToKey` is exact, because `new URL()` percent-encodes the pathname and
 * `decodeURIComponent` undoes it. For a key containing a literal `%` it is lossy — the key
 * `a%20b` comes back as `a b`. `storage-url-roundtrip.test.ts` pins both behaviours so the
 * limitation is visible rather than discovered. Fixing it means encoding here *and*
 * migrating stored URLs, which is its own piece of work.
 */
export function publicUrlFor(config: Pick<StorageConfig, "publicBaseUrl">, key: string): string {
	return `${config.publicBaseUrl}/${key}`;
}
