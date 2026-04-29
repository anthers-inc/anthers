/**
 * Local filesystem storage implementation for development.
 *
 * Files are stored under ./content/ relative to the repo root.
 * Served via Hono's serveStatic middleware mounted at /content/*.
 */

import { mkdir, unlink, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { StorageService } from "./types.js";

/** Root directory for local content files (repo root /content/) */
const CONTENT_ROOT = join(import.meta.dir, "../../../../../content");

/** Base URL for serving local files */
function getBaseUrl(): string {
	const port = process.env.PORT ?? "8000";
	return `http://localhost:${port}`;
}

export class LocalStorageService implements StorageService {
	async upload(
		key: string,
		body: Buffer | Uint8Array,
		_contentType: string,
		_acl?: "public" | "private",
	): Promise<string> {
		const filePath = join(CONTENT_ROOT, key);
		await mkdir(dirname(filePath), { recursive: true });
		await Bun.write(filePath, body);
		return key;
	}

	async downloadToTemp(key: string): Promise<string> {
		const sourcePath = join(CONTENT_ROOT, key);
		const ext = key.includes(".") ? `.${key.split(".").pop()}` : "";
		const tempPath = join(tmpdir(), `local_dl_${randomUUID()}${ext}`);
		await copyFile(sourcePath, tempPath);
		return tempPath;
	}

	async getUrl(
		key: string,
		_opts?: { signed?: boolean; expiresIn?: number },
	): Promise<string> {
		// Local dev — no signing, just return a URL the static middleware serves
		return `${getBaseUrl()}/content/${key}`;
	}

	async getPresignedUploadUrl(
		_key: string,
		_contentType: string,
		_expiresIn?: number,
	): Promise<string> {
		// In local mode, there's no S3 to presign against.
		// Return the direct-upload endpoint URL so the client can POST the file.
		return `${getBaseUrl()}/api/content/media-upload/direct`;
	}

	async delete(key: string): Promise<void> {
		try {
			await unlink(join(CONTENT_ROOT, key));
		} catch (err: unknown) {
			// Ignore "file not found" — delete is idempotent
			if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			await access(join(CONTENT_ROOT, key));
			return true;
		} catch {
			return false;
		}
	}

	/** Get the absolute filesystem path for a key (used by serveStatic) */
	getAbsolutePath(key: string): string {
		return join(CONTENT_ROOT, key);
	}

	/** Get the content root directory (for serveStatic configuration) */
	static getContentRoot(): string {
		return CONTENT_ROOT;
	}
}
