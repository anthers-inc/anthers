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
 * Every key the upload routes mint sits under one of two prefixes: `creators/{id}/` for
 * account chrome and the objects a creator owns outright, and `works/{workId}/` for a
 * Work's media, which belongs to the Work rather than to the account that uploaded it. The
 * write routes refuse a reference outside the writer's own prefix with {@link isOwnStorageRef}
 * or {@link isOwnWorkStorageRef}, and the purge refuses to delete outside the owner's (or the
 * Work's), so neither half depends on the other.
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

/**
 * The prefix every object belonging to one Work is stored under, with its trailing slash.
 *
 * ⭐ **Work media is Work-scoped, not creator-scoped, and that is what makes shared
 * ownership possible.** Every owner may upload into a Work and every owner may leave it,
 * so a key rooted at one creator's id would have to move bytes whenever that creator
 * left, hand over, or deleted their account — and an account deletion sweeps its own
 * prefix. `works/{workId}/…` belongs to the Work, so those operations move a row and
 * nothing else. Account chrome — avatars, banners, Badge art, post media, inline images —
 * stays under `creators/{id}/`.
 *
 * The migration from the old shape is `workKeyForMigration`; the two shapes coexist until
 * it has run everywhere.
 */
export function workKeyPrefix(workId: number): string {
	return `works/${workId}/`;
}

/**
 * Whether a key sits under one Work's own prefix and cannot climb out of it.
 *
 * The `..` refusal is the same one `isKeyUnder` carries: the local backend joins a key
 * onto a directory, so a traversal segment passes a prefix test and escapes it.
 */
export function isKeyUnderWork(key: string, workId: number): boolean {
	return isKeyUnderPrefix(key, workKeyPrefix(workId));
}

function isKeyUnderPrefix(key: string, prefix: string): boolean {
	if (!key.startsWith(prefix)) return false;
	if (key.includes("\\")) return false;
	return !key.split("/").some((segment) => segment === ".." || segment === ".");
}

/** The least a Work-media key decision needs from a Work row. */
export interface WorkStorageOwner {
	id: number;
	/** The publisher. Null once the account is gone, which leaves the Work's own prefix. */
	creatorId: number | null;
}

/**
 * Whether a key names this Work's media — under the Work's namespace, or under the
 * publisher's legacy creator prefix.
 *
 * ⚠️ **The legacy half is a migration window, not a second home.** Upload sessions opened
 * before the namespace changed still land under `creators/{publisherId}/`, and a Work's
 * rows written before it are still there until the mover reaches them, so reads must
 * accept both while that is true. Drop the legacy branch once
 * `move-work-media-to-work-keys.ts --check` reports no creator-prefixed Work keys; until
 * then removing it breaks existing Works.
 */
export function isWorkMediaKey(key: string, work: WorkStorageOwner): boolean {
	if (isKeyUnderWork(key, work.id)) return true;
	return work.creatorId != null && isKeyUnder(key, work.creatorId);
}

/**
 * Whether a reference a client sent names an object this Work owns. The empty string is
 * allowed, because clearing a thumbnail or a gallery entry is an ordinary edit.
 *
 * Accepts the bare key or the URL this deployment builds for it, exactly as
 * `isOwnStorageRef` does, so a same-looking key on another host is refused.
 */
export async function isOwnWorkStorageRef(value: string, work: WorkStorageOwner): Promise<boolean> {
	if (value === "") return true;
	const key = urlToKey(value);
	if (!isWorkMediaKey(key, work)) return false;
	if (value === key) return true;
	try {
		return (await storage.getUrl(key)) === value;
	} catch {
		// `getUrl` refuses an unservable key, such as one in the quarantine prefix.
		return false;
	}
}

const LEGACY_CREATOR_KEY = /^creators\/\d+\/(.+)$/;

/**
 * The key one Work-media object moves to, or null when the key is not a Work-media key
 * that can be moved.
 *
 * A legacy key is `creators/{creatorId}/…`; the new one is the same remainder under the
 * Work's prefix, so the mapping is a pure string rewrite and needs no per-media-type
 * table. A key already under the Work's prefix maps to itself, which is what makes the
 * migration script idempotent.
 */
export function workKeyForMigration(key: string, workId: number): string | null {
	if (isKeyUnderWork(key, workId)) return key;
	const match = LEGACY_CREATOR_KEY.exec(key);
	if (!match) return null;
	if (key.includes("\\")) return null;
	if (key.split("/").some((segment) => segment === ".." || segment === ".")) return null;
	return `${workKeyPrefix(workId)}${match[1]}`;
}
