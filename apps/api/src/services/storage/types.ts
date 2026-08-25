// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * StorageService interface — abstracts file storage for local dev and S3-compatible
 * production, which is **Cloudflare R2** (`anthers-media-public` + `anthers-media-private`).
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
	 * This is the large-object counterpart to `read`, and the reason that method's "small
	 * objects only" restriction is real rather than stylistic: `read`-ing a whole file to
	 * hand back a slice of it puts the entire asset in the API's heap, and the api component
	 * is a 512 MB instance — so one ranged request over a multi-gigabyte asset is an OOM of
	 * the whole hub.
	 *
	 * ⚠️ **Nothing calls this today.** Its consumer was the P2P seeder, which served 256 KiB
	 * chunks and was unwound on 2026-08-11 on privacy grounds — downloads are signed URLs
	 * again. The method is kept because a ranged read is the correct primitive the moment
	 * anything streams a large private object through the API rather than past it, but do
	 * not read its presence as evidence that something does.
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
	 * database column written at upload and can disagree with it, so anything that has to
	 * be right about the bytes on disk (a `Content-Length`, a range bound) asks here.
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
	 * Returns headers rather than expecting the caller to know them because whether the
	 * client must echo `x-amz-acl` is a **property of the provider**, and it is fatal in
	 * both directions. On a per-object-ACL provider the header is the only thing that
	 * works — `getSignedUrl` hoists the ACL into the query string, where it is silently
	 * ignored, so a server that sets it without the client echoing it reviews as correct
	 * and does nothing. On R2 the same header makes the upload **fail**: it changes the
	 * canonical request the signature was computed over, so a presigned PUT carrying it
	 * gets `403 SignatureDoesNotMatch`. `S3StorageService.getPresignedUploadUrl` derives
	 * which applies from `config.sendObjectAcl` and carries the full reasoning.
	 *
	 * @param acl - Same allowlist semantics as `upload`. 🚨 On R2 — production today — this
	 * chooses the **bucket**, and that is what makes it enforcement rather than intent.
	 * R2 has no per-object ACLs at all, so `anthers-media-private` has no public door for
	 * an uploading client to prop open, whatever it sends. The hazard this note used to
	 * describe (a creator echoing `public-read` to publish their own upload at a stable
	 * public URL, outside the access-checked path) was real against Spaces and is
	 * structurally absent here: the object lands in whichever bucket the *signature*
	 * names, and the client cannot re-sign.
	 */
	getPresignedUploadUrl(
		key: string,
		contentType: string,
		acl: "public" | "private",
		expiresIn?: number,
	): Promise<{ url: string; headers: Record<string, string> }>;

	/**
	 * Move an object from one key to another, across buckets where the two keys belong to
	 * different ones. Returns false when the source does not exist.
	 *
	 * Copy-then-delete rather than a rename, because that is the only thing S3 offers and
	 * the order matters: a crash after the copy strands a duplicate, while a crash after a
	 * delete-then-copy loses the object. The one caller is `services/quarantine.ts`, whose
	 * whole purpose is that the bytes must not be destroyed.
	 *
	 * 🚨 **A thumbnail moved out of the public bucket is the reason this crosses buckets.**
	 * Display chrome lives in `anthers-media-public` behind `cdn.anthers.org`, which serves
	 * it by key with no access check at all — so for a quarantine, leaving it there would
	 * leave the material world-readable at a stable URL while every gated object was safely
	 * out of reach.
	 */
	move(fromKey: string, toKey: string): Promise<boolean>;

	/** Delete a file. */
	delete(key: string): Promise<void>;

	/** Delete every file under a key prefix (e.g. an HLS output directory). Idempotent. */
	deletePrefix(prefix: string): Promise<void>;

	/** Check whether a file exists. */
	exists(key: string): Promise<boolean>;
}
