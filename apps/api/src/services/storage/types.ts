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
	 * @param acl - "public" for covers/avatars/thumbnails, "private" for gated content
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
	 * Get a URL for a file.
	 * - Public files: bare URL (no signing).
	 * - Private files with `signed: true`: time-limited signed URL.
	 */
	getUrl(key: string, opts?: { signed?: boolean; expiresIn?: number }): Promise<string>;

	/**
	 * Get a presigned PUT URL for direct browser-to-storage uploads.
	 * In local mode this returns the direct upload endpoint URL.
	 */
	getPresignedUploadUrl(key: string, contentType: string, expiresIn?: number): Promise<string>;

	/** Delete a file. */
	delete(key: string): Promise<void>;

	/** Check whether a file exists. */
	exists(key: string): Promise<boolean>;
}
