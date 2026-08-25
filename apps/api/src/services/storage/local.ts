// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local filesystem storage implementation for development.
 *
 * Files are stored under ./content/ relative to the repo root.
 * Served via Hono's serveStatic middleware mounted at /content/*.
 */

import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertServableKey } from "./acl.js";
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
		// Ignored: /content serves everything unsigned in dev. Worth knowing when
		// reasoning about a leak — an ACL mistake is invisible locally and only shows
		// up against S3, which is why the delivery tests assert URLs at the API layer.
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

	async read(key: string): Promise<Uint8Array | null> {
		const file = Bun.file(join(CONTENT_ROOT, key));
		if (!(await file.exists())) return null;
		return new Uint8Array(await file.arrayBuffer());
	}

	async size(key: string): Promise<number | null> {
		const file = Bun.file(join(CONTENT_ROOT, key));
		if (!(await file.exists())) return null;
		return file.size;
	}

	async readRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
		const file = Bun.file(join(CONTENT_ROOT, key));
		if (!(await file.exists())) return null;
		if (length <= 0) return new Uint8Array(0);
		// Bun.file().slice() is lazy — it describes the range and only the sliced bytes are
		// read when it is realized, so this never materializes the whole file.
		return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
	}

	async getUrl(key: string, _opts?: { signed?: boolean; expiresIn?: number }): Promise<string> {
		// 🚨 Refused here as well as in S3, and it matters MORE here: `/content` is served
		// unsigned by the static middleware, so in local mode a quarantined object under
		// CONTENT_ROOT is reachable by anyone who can guess the path. The middleware itself
		// refuses the prefix too (`index.ts`) — this is the half that stops us handing the
		// address out in the first place.
		assertServableKey(key);
		// Local dev — no signing, just return a URL the static middleware serves
		return `${getBaseUrl()}/content/${key}`;
	}

	/** Rename on disk, creating the destination directory. False when the source is absent. */
	async move(fromKey: string, toKey: string): Promise<boolean> {
		if (fromKey === toKey) return true;
		const from = join(CONTENT_ROOT, fromKey);
		const to = join(CONTENT_ROOT, toKey);
		try {
			await access(from);
		} catch {
			return false;
		}
		await mkdir(dirname(to), { recursive: true });
		await rename(from, to);
		return true;
	}

	async getPresignedUploadUrl(
		key: string,
		_contentType: string,
		_acl: "public" | "private",
		_expiresIn?: number,
	): Promise<{ url: string; headers: Record<string, string> }> {
		assertServableKey(key);
		// In local mode, there's no S3 to presign against.
		// Return the direct-upload endpoint URL so the client can POST the file.
		// No headers: the ACL is meaningless here — `/content` serves everything
		// unsigned, which is exactly why an ACL mistake is invisible in local dev.
		return { url: `${getBaseUrl()}/api/content/media-upload/direct`, headers: {} };
	}

	async delete(key: string): Promise<void> {
		try {
			await unlink(join(CONTENT_ROOT, key));
		} catch (err: unknown) {
			// Ignore "file not found" — delete is idempotent
			if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")
				return;
			throw err;
		}
	}

	async deletePrefix(prefix: string): Promise<void> {
		// A prefix maps to a directory on disk; remove it recursively. Idempotent.
		await rm(join(CONTENT_ROOT, prefix), { recursive: true, force: true });
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
