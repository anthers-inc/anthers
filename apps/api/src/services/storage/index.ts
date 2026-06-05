// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Storage factory — returns the singleton StorageService based on STORAGE_BACKEND env var.
 *
 * Usage:
 *   import { storage } from "../services/storage/index.js";
 *   await storage.upload(key, buffer, contentType);
 */

export type { StorageService } from "./types.js";

import { LocalStorageService } from "./local.js";
import { S3StorageService } from "./s3.js";
import type { StorageService } from "./types.js";

function createStorage(): StorageService {
	const backend = process.env.STORAGE_BACKEND ?? "local";
	if (backend === "s3") {
		return new S3StorageService();
	}
	return new LocalStorageService();
}

/** Singleton storage instance — use this everywhere */
export const storage = createStorage();

/** Whether we're running in local storage mode */
export const isLocalStorage = (process.env.STORAGE_BACKEND ?? "local") !== "s3";
