// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * StorageService interface — abstracts file storage for local dev and S3/Spaces production.
 *
 * All route handlers and jobs interact with this interface only.
 * Toggled via STORAGE_BACKEND env var: "local" (default) or "s3".
 */

export interface StorageService {
	/**
	 * Upload a file. Returns the storage key.
	 *
	 * @param acl - "public" ONLY for display chrome the viewer is meant to see before
	 * they have access (covers, avatars, thumbnails). Everything that is, or could
	 * become, a gated deliverable is "private" and reaches viewers through an
	 * access-checked endpoint that signs per request. **Omitting this gives you
	 * "private"** — the default fails closed deliberately, so forgetting it locks an
	 * object rather than publishing one.
	 */
	upload(
		key: string,
		body: Buffer | Uint8Array,
		contentType: string,
		acl?: "public" | "private",
	): Promise<string>;

	/**
	 * Download a file to a local temp path (for ffmpeg, sharp, etc.).
	 * Caller is responsible for cleaning up the temp file.
	 */
	downloadToTemp(key: string): Promise<string>;

	/**
	 * Read a small object straight into memory. Null when it doesn't exist.
	 *
	 * For things a request handler needs the *contents* of — HLS playlists, above all —
	 * rather than a URL to hand a client. The alternative, `fetch(await getUrl(key))`,
	 * is wrong in both backends for different reasons: in local mode it makes the API
	 * issue an HTTP request **to itself** from inside a request handler, which is a
	 * connection-reset waiting to happen under constrained concurrency (it was, in CI);
	 * in S3 mode it signs a URL and pays a full round-trip to fetch bytes the SDK could
	 * have handed over directly. Meant for small objects — never a media segment.
	 */
	read(key: string): Promise<Uint8Array | null>;

	/**
	 * Read a byte range out of an object. Null when the object doesn't exist.
	 *
	 * This is the large-object counterpart to `read`, and it exists because that method's
	 * "small objects only" restriction is real rather than stylistic: the P2P seeder serves
	 * 256 KiB chunks out of assets that can be gigabytes, and `read`-ing the whole file to
	 * hand back a slice of it puts the entire asset in the API's heap. The api component is
	 * a 512 MB instance, so that is an OOM of the whole hub, triggered by one download.
	 *
	 * `offset` is the first byte to return and `length` is how many bytes are wanted; a
	 * range running past the end of the object yields the bytes that exist rather than an
	 * error, so the caller does not have to special-case the final chunk. A zero `length`
	 * yields an empty array without touching storage, because S3 has no way to express a
	 * zero-length range and would read to the end of the object instead.
	 */
	readRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;

	/**
	 * The size of an object in bytes, without fetching it. Null when it doesn't exist.
	 *
	 * Storage is the authority on how big a stored object is — `assets.file_size` is a
	 * database column that can disagree with it, and the P2P manifest's chunk boundaries
	 * have to match the bytes a peer will actually receive or every hash check fails.
	 */
	size(key: string): Promise<number | null>;

	/**
	 * Get a URL for a file.
	 * - Public files: bare URL (no signing).
	 * - Private files with `signed: true`: time-limited signed URL.
	 */
	getUrl(key: string, opts?: { signed?: boolean; expiresIn?: number }): Promise<string>;

	/**
	 * Get a presigned PUT URL for direct browser-to-storage uploads, plus the headers
	 * the client MUST send with it. In local mode this returns the direct upload
	 * endpoint URL and no headers.
	 *
	 * Returns headers rather than expecting the caller to know them because the ACL
	 * only takes effect if it travels as a request *header*: the SDK also hoists it
	 * into the presigned query string, and Spaces silently ignores it there (verified
	 * against the live bucket — an object signed `public-read` in the query came back
	 * owner-only). A server that sets the ACL without the client echoing it reviews as
	 * correct and does nothing, so the header list is part of the server's answer.
	 *
	 * @param acl - Same allowlist semantics as `upload`. NOTE this is *intent*, not
	 * enforcement: a presigned URL signs only `host`, so the uploading client can send
	 * any `x-amz-acl` it likes and Spaces honours it over the one we signed (also
	 * verified live). A creator can therefore publish their own upload at a stable
	 * public URL, which is a metering hole rather than a content leak — it serves bytes
	 * outside the access-checked, bandwidth-accounted path. Closing that needs a bucket
	 * policy denying non-private ACLs under the presigned prefixes; it is not something
	 * this layer can do.
	 */
	getPresignedUploadUrl(
		key: string,
		contentType: string,
		acl: "public" | "private",
		expiresIn?: number,
	): Promise<{ url: string; headers: Record<string, string> }>;

	/** Delete a file. */
	delete(key: string): Promise<void>;

	/** Delete every file under a key prefix (e.g. an HLS output directory). Idempotent. */
	deletePrefix(prefix: string): Promise<void>;

	/** Check whether a file exists. */
	exists(key: string): Promise<boolean>;
}
