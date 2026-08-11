// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which S3-compatible provider the storage service talks to, and how public URLs are built.
 *
 * Split out of `s3.ts` and made **pure** on purpose: this is the only part of the storage
 * layer that has to be right *before* a migration rather than after one, and a function
 * taking an env-shaped object can be tested against every provider's URL shape without
 * credentials, a network, or a bucket.
 *
 * ── Vendor-neutral names, and nothing else ─────────────────────────────────────────
 *
 * The variables were `SPACES_*`, which named DigitalOcean in the configuration as well as
 * in the code. They became `STORAGE_*` with the old names kept as fallbacks, and every
 * default composed a DigitalOcean Spaces URL, so an environment that set nothing new
 * behaved identically — the property that made introducing this file a no-op.
 *
 * **Both are gone as of 2026-08-11, because the thing they protected is gone.** The
 * fallbacks existed because pushing to `release` never applies the committed spec, so a
 * rename could have deployed cleanly and then failed every upload on empty credentials
 * against a *live* Spaces deployment. That deployment has been deleted: Anthers runs on
 * Cloudflare R2 under an Anthers-owned account, and there is no Spaces bucket, cluster or
 * app left to fall back to. Keeping them would leave a configuration path nothing
 * exercises — and one of those defaults (`nyc3`) is the specific value that made every R2
 * call fail, which is a poor thing to leave loaded.
 *
 * So the required variables are now **required**, and `resolveStorageConfig` throws naming
 * the missing ones rather than composing a URL for a vendor we left.
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

/** Read `STORAGE_<name>`, trimmed. */
function env(source: Record<string, string | undefined>, name: string): string {
	return (source[`STORAGE_${name}`] ?? "").trim();
}

/**
 * Every variable that must be present for S3 storage to work at all.
 *
 * There are no defaults for these any more. Each used to have one that composed a
 * DigitalOcean Spaces URL — which was correct while Spaces was what we ran on, and became
 * actively harmful the moment it wasn't: `STORAGE_REGION` defaulting to `nyc3` is precisely
 * what made every R2 call fail, with presigned URLs reporting `SignatureDoesNotMatch`
 * rather than anything about a region.
 *
 * `STORAGE_PUBLIC_BUCKET` is deliberately NOT here. Falling back to the private bucket is a
 * real posture (one bucket, per-object ACLs) rather than a vendor guess, and it is what
 * `sendObjectAcl` keys on.
 */
const REQUIRED = ["ENDPOINT", "REGION", "BUCKET", "PUBLIC_BASE_URL", "KEY", "SECRET"] as const;

/**
 * Resolve the storage configuration.
 *
 * Throws when a required variable is missing, naming all of them at once. That is louder
 * than the alternative and deliberately so: the failure it replaces was a boot that
 * *succeeded* against a half-configured environment and then failed on the first upload,
 * somewhere far from the cause.
 *
 * Only reached when `STORAGE_BACKEND=s3` — `index.ts` builds `LocalStorageService` otherwise
 * — so local dev never has to satisfy any of this.
 */
export function resolveStorageConfig(
	source: Record<string, string | undefined> = process.env,
): StorageConfig {
	const missing = REQUIRED.filter((name) => !env(source, name));
	if (missing.length) {
		throw new Error(
			`Storage is not configured: missing ${missing.map((m) => `STORAGE_${m}`).join(", ")}. ` +
				"See .env.example — every one of these is required and none has a default.",
		);
	}

	const bucket = env(source, "BUCKET");
	// Same bucket unless told otherwise — see the field docs for why that is the safe default.
	const publicBucket = env(source, "PUBLIC_BUCKET") || bucket;

	return {
		region: env(source, "REGION"),
		bucket,
		publicBucket,
		endpoint: env(source, "ENDPOINT"),
		// Trim (in `env`): a stray newline/space pasted into a dashboard secret silently
		// corrupts the SigV4 HMAC and yields a baffling SignatureDoesNotMatch.
		accessKeyId: env(source, "KEY"),
		secretAccessKey: env(source, "SECRET"),
		publicBaseUrl: env(source, "PUBLIC_BASE_URL").replace(/\/+$/, ""),
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
