// SPDX-License-Identifier: Apache-2.0
/**
 * Sign one of a Work's own objects, or refuse it.
 *
 * 🚨 **A delivery route signs a key the database names, and the database can name a
 * stranger's object.** The write-time check (`isOwnWorkStorageRef`) is the first half; a
 * row written before that check existed, or by a path that forgot it, still has to be
 * refused at the read. Every delivery signer goes through this rather than calling
 * `storage.getUrl` directly, so the ownership question has one answer.
 *
 * The Work's namespace is the owner now, with the publisher's legacy creator prefix
 * accepted until the migration has run — see `isWorkMediaKey`.
 */

import { storage } from "./index.js";
import { isWorkMediaKey, urlToKey, type WorkStorageOwner } from "./keys.js";
import type { StorageService } from "./types.js";

export async function signWorkObject(
	ref: string,
	work: WorkStorageOwner,
	opts?: Parameters<StorageService["getUrl"]>[1],
): Promise<string | null> {
	const key = urlToKey(ref);
	if (!key || !isWorkMediaKey(key, work)) return null;
	return storage.getUrl(key, opts);
}
