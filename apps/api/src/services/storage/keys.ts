// SPDX-License-Identifier: Apache-2.0
/**
 * What a stored media reference names, and whether it names something the account writing it
 * uploaded.
 *
 * 🚨 **A file reference a client sends is a claim, and every column holding one is a door.**
 * Until 2026-09-16 nothing checked that the key or URL a request wrote into a Work, an asset, an
 * avatar or a header belonged to the account writing it, and each of those columns is read by
 * something that acts on the object it names:
 *
 * - **Delivery** signs a Work's source and its assets for the Work's owner, so an account that
 *   named another creator's private original as its own asset could download it.
 * - **Release** lists the Work under the writer's name, so another creator's file could be
 *   republished and earn the Time Pool for somebody who never made it.
 * - **Deletion** sweeps every key a Work or an account names (`media-purge.ts`), so naming a
 *   victim's original and then deleting your own Work destroyed the victim's file.
 *
 * Every key the upload routes mint sits under `creators/{id}/`, so ownership is a prefix. The
 * write routes refuse a reference outside the writer's prefix with {@link isOwnStorageRef}, and
 * the purge refuses to delete outside the owner's, so neither half depends on the other.
 */

import { storage } from "./index.js";

/**
 * Normalize a stored URL or key to a storage key. Stored media columns hold whichever
 * the backend produced at write time — a `cdn.anthers.org` URL under S3, a `/content/…`
 * path under local — so every sweep goes through here rather than assuming one shape.
 *
 * ⚠️ **It reads the pathname of any URL, whatever its host**, so it answers "which key would
 * this be if it were ours" and never "is this ours". {@link isOwnStorageRef} is the question
 * that has to be asked before a client-supplied reference is trusted.
 */
export function urlToKey(urlOrKey: string): string {
	let path = urlOrKey;
	if (/^(https?:)?\/\//.test(urlOrKey)) {
		try {
			path = decodeURIComponent(new URL(urlOrKey).pathname);
		} catch {
			path = urlOrKey;
		}
	}
	path = path.replace(/^\/+/, "");
	if (path.startsWith("content/")) path = path.slice("content/".length);
	return path;
}

/** The prefix every object an account uploads is stored under, with its trailing slash. */
export function creatorKeyPrefix(userId: number): string {
	return `creators/${userId}/`;
}

/**
 * Whether a key sits under this account's prefix and cannot climb out of it.
 *
 * ⚠️ **A `..` segment passes a prefix test and escapes it on the local backend**, which joins the
 * key onto a directory, so `creators/5/../7/…` is refused rather than normalized.
 */
export function isKeyUnder(key: string, userId: number): boolean {
	if (!key.startsWith(creatorKeyPrefix(userId))) return false;
	if (key.includes("\\")) return false;
	return !key.split("/").some((segment) => segment === ".." || segment === ".");
}

/**
 * Whether a reference a client sent names an object this account uploaded. The empty string is
 * allowed, because clearing a thumbnail or an avatar is an ordinary edit.
 *
 * A reference is accepted in exactly the two shapes the upload routes hand back: the bare key,
 * or the URL `storage.getUrl` builds for it. Comparing against the URL this deployment would
 * build refuses another host's URL whose path happens to look like one of our keys, which a
 * parse of the path alone cannot tell apart.
 *
 * ⚠️ Fails closed on a key containing a literal `%`, which `urlToKey` decodes lossily (see
 * `storage/config.ts`). The upload routes mint keys from a UUID and the uploaded file's
 * extension, so only an extension carrying a `%` can meet it.
 */
export async function isOwnStorageRef(value: string, userId: number): Promise<boolean> {
	if (value === "") return true;
	const key = urlToKey(value);
	if (!isKeyUnder(key, userId)) return false;
	if (value === key) return true;
	try {
		return (await storage.getUrl(key)) === value;
	} catch {
		// `getUrl` refuses an unservable key, such as one in the quarantine prefix.
		return false;
	}
}

/** The refusal every write route returns for a reference that is not the writer's upload. */
export const FOREIGN_FILE_REFUSAL = {
	error: "That file isn't one of your uploads. Upload it again and use the new copy.",
	code: "foreign_file",
} as const;
