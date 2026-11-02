// SPDX-License-Identifier: Apache-2.0
/**
 * Sign one of a Work's own objects, or refuse it.
 *
 * 🚨 **A delivery route signs a key the database names, and the database can name a
 * stranger's object.** The write-time check (`isOwnStorageRef`) is the first half; a row
 * written before that check existed, or by a path that forgot it, still has to be refused
 * at the read. Every delivery signer goes through this rather than calling `storage.getUrl`
 * directly, so the ownership question has one answer.
 */

import { storage } from "./index.js";
import { isKeyUnder, urlToKey } from "./keys.js";
import type { StorageService } from "./types.js";

export async function signOwnWorkObject(
	ref: string,
	creatorId: number | null,
	opts?: Parameters<StorageService["getUrl"]>[1],
): Promise<string | null> {
	if (creatorId == null) return null;
	const key = urlToKey(ref);
	if (!key || !isKeyUnder(key, creatorId)) return null;
	return storage.getUrl(key, opts);
}
