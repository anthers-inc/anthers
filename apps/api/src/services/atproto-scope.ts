// SPDX-License-Identifier: Apache-2.0
/**
 * Reading an AT Protocol OAuth scope string, so Anthers can tell what it was actually granted.
 *
 * An authorization server is free to hand back something other than what was asked for, so
 * "we requested permission to write" and "we hold permission to write" are different claims
 * and only the second one is worth acting on. This module answers the second from the scope
 * string the token carries.
 *
 * ⚠️ **This is a user, never the authority.** The repository itself decides whether a write
 * is allowed, and it decides at the moment of the write. What this buys is knowing *before*
 * the round trip — so the Studio can say whether publishing is on, and so a job can skip
 * quietly instead of provoking a refusal it already expects. A disagreement between this and
 * the server is resolved in the server's favor, which is why every caller still handles a
 * refusal it did not predict.
 *
 * 🚨 **The absence of `action` means every action, not none.** Proposal 0011 gives `action` a
 * default of all three, so the permission covering the most is the one that names the fewest
 * parameters — `repo:org.anthers.work` grants create, update *and* delete. Reading an absent
 * parameter as an empty set is the one mistake here that fails *open* in the direction of
 * thinking we hold less than we do, and it is why the default is written out below rather
 * than left implicit.
 *
 * ⚠️ **A granted scope does not come back in the spelling it was asked for.** The same
 * proposal's formatter omits any parameter equal to its default, so asking for
 * `repo:org.anthers.work?action=create&action=update&action=delete` is answered with a bare
 * `repo:org.anthers.work`. Comparing the two as strings would report that a grant was refused
 * at the exact moment it was granted in full, which is why nothing here compares strings.
 *
 * The grammar is proposal 0011's: `prefix[:positional][?params]`, parameters url-encoded and
 * repeatable. See https://github.com/bluesky-social/proposals/blob/main/0011-auth-scopes/.
 */

import { isValidDid, isValidNsid, isValidRecordKey } from "@atproto/syntax";

/** What a `repo:` permission can allow. These three are the whole vocabulary. */
export const REPO_ACTIONS = ["create", "update", "delete"] as const;

export type RepoAction = (typeof REPO_ACTIONS)[number];

/** The collection parameter that means "every collection". */
const ANY_COLLECTION = "*";

/** One `repo:` permission, as read out of a scope string. */
export interface RepoPermission {
	/** The collections it covers, or `["*"]` for all of them. */
	collections: readonly string[];
	/** The actions it allows. Never empty. */
	actions: readonly RepoAction[];
}

function isRepoAction(value: string): value is RepoAction {
	return (REPO_ACTIONS as readonly string[]).includes(value);
}

/**
 * Split one scope token into the three parts the grammar allows.
 *
 * ⚠️ **A colon after the `?` is part of a parameter, not a positional.** `repo?collection=a:b`
 * has no positional at all, and reading one out of it would invent a collection nobody
 * granted. The ordering test below is the whole of what stops that.
 */
function splitToken(token: string): {
	prefix: string;
	positional?: string;
	params: URLSearchParams;
} {
	const paramIdx = token.indexOf("?");
	const colonIdx = token.indexOf(":");

	const hasPositional = colonIdx !== -1 && (paramIdx === -1 || colonIdx < paramIdx);
	const prefixEnd =
		paramIdx === -1 ? colonIdx : colonIdx === -1 ? paramIdx : Math.min(colonIdx, paramIdx);

	return {
		prefix: prefixEnd === -1 ? token : token.slice(0, prefixEnd),
		positional: hasPositional
			? decodeURIComponent(token.slice(colonIdx + 1, paramIdx === -1 ? undefined : paramIdx))
			: undefined,
		params: new URLSearchParams(paramIdx === -1 ? "" : token.slice(paramIdx + 1)),
	};
}

/**
 * Read one `repo:` token, or return null when it is not one we can honor.
 *
 * 🚨 **Anything unreadable is refused rather than interpreted generously.** An unknown action,
 * a permission naming no collection, and a token giving its collection both positionally and
 * as a parameter are all rejected outright — which is what proposal 0011's own parser does,
 * and which keeps a malformed grant from being read as a broad one.
 */
function readRepoToken(token: string): RepoPermission | null {
	const { prefix, positional, params } = splitToken(token);
	if (prefix !== "repo") return null;

	const named = params.getAll("collection");
	// Positional and named spellings of the same parameter cannot both be used.
	if (positional !== undefined && named.length > 0) return null;

	const collections = positional !== undefined ? [positional] : named;
	if (collections.length === 0) return null;

	// The default is every action, and it is the case that matters most — see the module note.
	const asked = params.getAll("action");
	if (asked.length === 0) return { collections, actions: REPO_ACTIONS };
	if (!asked.every(isRepoAction)) return null;

	return { collections, actions: asked };
}

/** Every `repo:` permission in a scope string, ignoring everything that is not one. */
export function readRepoPermissions(scope: string | null | undefined): RepoPermission[] {
	if (!scope) return [];
	const found: RepoPermission[] = [];
	for (const token of scope.split(/\s+/)) {
		if (!token) continue;
		const permission = readRepoToken(token);
		if (permission) found.push(permission);
	}
	return found;
}

/**
 * Which of the actions asked for this collection are *not* granted.
 *
 * Returned as a list rather than a boolean because the list is what can be said out loud: a
 * grant covering create and update but not delete is a specific problem — listings could be
 * published and never withdrawn — and reporting it as a bare "no" would hide which half is
 * missing from whoever has to fix it.
 */
export function missingRepoActions(
	scope: string | null | undefined,
	collection: string,
	needed: readonly RepoAction[] = REPO_ACTIONS,
): RepoAction[] {
	const permissions = readRepoPermissions(scope);
	return needed.filter(
		(action) =>
			!permissions.some(
				(permission) =>
					permission.actions.includes(action) &&
					(permission.collections.includes(ANY_COLLECTION) ||
						permission.collections.includes(collection)),
			),
	);
}

/** Whether a scope allows creating, replacing and removing records in one collection. */
export function scopeAllowsWriting(scope: string | null | undefined, collection: string): boolean {
	return missingRepoActions(scope, collection).length === 0;
}

/** The collection an `org.anthers.creditAcceptance` record lives in. */
export const CREDIT_ACCEPTANCE_COLLECTION = "org.anthers.creditAcceptance";

/** The actions an acceptance record ever takes. Assent is written once, never edited. */
const CREDIT_ACCEPTANCE_ACTIONS: readonly RepoAction[] = ["create", "delete"];

/**
 * Whether a scope lets Anthers write the records a collection exists for.
 *
 * ⚠️ `creditAcceptance` is the one collection that does not take edits: an acceptance is assent
 * written once, and a change of heart is a withdraw plus a fresh acceptance rather than an update —
 * which is why its permission set grants create and delete and nothing more. Asking for all three
 * here would read every correctly-granted account as unpermissioned. Every other collection is
 * judged by the full three, the same as `scopeAllowsWriting`.
 */
export function scopeCoversCollection(
	scope: string | null | undefined,
	collection: string,
): boolean {
	if (collection === CREDIT_ACCEPTANCE_COLLECTION) {
		return missingRepoActions(scope, collection, CREDIT_ACCEPTANCE_ACTIONS).length === 0;
	}
	return scopeAllowsWriting(scope, collection);
}

/*
 * Spaces add two resource permissions to the same grammar:
 *
 *   space:<type>?authority=<*|self|did>&skey=<*|key>&collection=<nsid|*>&action=<verb>&manage=<verb>
 *   blob:<accept>            (or blob?accept=… for several accept values)
 *
 * The forms and their defaults follow the permissioned-data branch's
 * `@atproto/oauth-scopes`, which is where the protocol defines them. `space:` is
 * deliberately not folded into the `repo:` reader: a space permission names a
 * type, an authority and a space key as well as a collection, and reading it as
 * a repo grant would answer a different question than the one that was asked.
 */

/** What a `space:` permission can allow on a space's records. */
export const SPACE_ACTIONS = ["read_self", "read", "create", "update", "delete"] as const;

export type SpaceAction = (typeof SPACE_ACTIONS)[number];

/** What a `space:` permission can allow on the space itself. */
export const SPACE_MANAGE_OPS = ["create", "update", "delete"] as const;

export type SpaceManageOp = (typeof SPACE_MANAGE_OPS)[number];

/** The actions a `space:` token grants when it names none, matching the protocol default. */
export const SPACE_DEFAULT_ACTIONS: readonly SpaceAction[] = ["read", "create", "update", "delete"];

/** One `space:` permission, as read out of a scope string. */
export interface SpacePermission {
	/** The space type, or `*` for any type. */
	type: string;
	/** The space authority, or `*` for any authority. `self` is the granting user's DID. */
	authority: string;
	/** The space key, or `*` for any key. */
	skey: string;
	/** The collections it may write, or `["*"]` for all of them. Absent means no write targets. */
	collections?: readonly string[];
	/** The record actions it allows. Never empty. */
	actions: readonly SpaceAction[];
	/** The space-management verbs it allows, when the token names any. */
	manage?: readonly SpaceManageOp[];
}

/** One `blob:` permission, as read out of a scope string. */
export interface BlobPermission {
	/** The MIME patterns the grant accepts, such as `image/png` or a global wildcard. */
	accepts: readonly string[];
}

function isSpaceAction(value: string): value is SpaceAction {
	return (SPACE_ACTIONS as readonly string[]).includes(value);
}

function isSpaceManageOp(value: string): value is SpaceManageOp {
	return (SPACE_MANAGE_OPS as readonly string[]).includes(value);
}

/**
 * Read a parameter that may appear at most once.
 *
 * `undefined` means absent, `null` means repeated and therefore unreadable. The
 * distinction is what lets a default apply only when the parameter is genuinely
 * absent, rather than when a malformed token happened to repeat it.
 */
function readSingleParam(params: URLSearchParams, key: string): string | undefined | null {
	const values = params.getAll(key);
	if (values.length === 0) return undefined;
	if (values.length > 1) return null;
	return values[0];
}

/**
 * Read one `space:` token, or return null when it is not one we can honor.
 *
 * 🚨 **Every parameter is checked, and anything unknown is refused.** A token is
 * a grant of authority, so a spelling this reader does not recognize must not
 * fall back to the protocol's broad default. The type, authority, space key and
 * collection validate against the same shapes the protocol uses.
 */
function readSpaceToken(token: string): SpacePermission | null {
	const { prefix, positional, params } = splitToken(token);
	if (prefix !== "space") return null;

	for (const key of params.keys()) {
		if (!["type", "authority", "skey", "collection", "action", "manage"].includes(key)) {
			return null;
		}
	}

	const namedType = readSingleParam(params, "type");
	if (namedType === null) return null;
	if (positional !== undefined && namedType !== undefined) return null;

	const type = positional ?? namedType;
	if (type === undefined) return null;
	if (type !== "*" && !isValidNsid(type)) return null;

	const authority = readSingleParam(params, "authority");
	if (authority === null) return null;
	const authorityValue = authority ?? "self";
	if (authorityValue !== "*" && authorityValue !== "self" && !isValidDid(authorityValue)) {
		return null;
	}

	const skey = readSingleParam(params, "skey");
	if (skey === null) return null;
	const skeyValue = skey ?? "*";
	if (skeyValue !== "*" && !isValidRecordKey(skeyValue)) return null;

	const namedCollections = params.getAll("collection");
	if (
		namedCollections.length > 0 &&
		!namedCollections.every((collection) => collection === "*" || isValidNsid(collection))
	) {
		return null;
	}

	const namedActions = params.getAll("action");
	if (namedActions.length > 0 && !namedActions.every(isSpaceAction)) return null;

	const namedManage = params.getAll("manage");
	if (namedManage.length > 0 && !namedManage.every(isSpaceManageOp)) return null;

	return {
		type,
		authority: authorityValue,
		skey: skeyValue,
		collections:
			namedCollections.length === 0
				? undefined
				: namedCollections.includes("*")
					? ["*"]
					: [...new Set(namedCollections)].sort(),
		actions:
			namedActions.length === 0
				? SPACE_DEFAULT_ACTIONS
				: SPACE_ACTIONS.filter((action) => namedActions.includes(action)),
		manage:
			namedManage.length === 0
				? undefined
				: SPACE_MANAGE_OPS.filter((operation) => namedManage.includes(operation)),
	};
}

/** Every `space:` permission in a scope string, ignoring everything that is not one. */
export function readSpacePermissions(scope: string | null | undefined): SpacePermission[] {
	if (!scope) return [];
	const found: SpacePermission[] = [];
	for (const token of scope.split(/\s+/)) {
		if (!token) continue;
		const permission = readSpaceToken(token);
		if (permission) found.push(permission);
	}
	return found;
}

/** Whether a string has exactly one slash and no spaces, the shape a MIME type needs. */
function hasSingleSlash(value: string): boolean {
	const slash = value.indexOf("/");
	if (slash === -1) return false;
	if (slash === 0 || slash === value.length - 1) return false;
	if (value.includes("/", slash + 1)) return false;
	return !value.includes(" ");
}

function isMimeType(value: string): boolean {
	return hasSingleSlash(value) && !value.includes("*");
}

/**
 * Whether a string is a MIME accept pattern: the global wildcard, a type wildcard,
 * or a concrete type and subtype.
 *
 * This is the protocol's own test, including its refusal of a wildcard in the
 * subtype position on its own, where the wildcard sits on the part that cannot be
 * wildcarded alone.
 */
function isBlobAccept(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value === "*/*") return true;
	if (!hasSingleSlash(value)) return false;
	return !value.includes("*") || value.endsWith("/*");
}

function matchesBlobAccept(accept: string, mime: string): boolean {
	if (accept === "*/*") return true;
	if (accept.endsWith("/*")) return mime.startsWith(accept.slice(0, -1));
	return accept === mime;
}

/**
 * Read one `blob:` token, or return null when it is not one we can honor.
 *
 * The accept value may be positional (`blob:image/png`) or named, once or
 * repeated (`blob?accept=image/png&accept=image/jpeg`). A token spelling it both
 * ways is refused, the same as the protocol's parser refuses it.
 */
function readBlobToken(token: string): BlobPermission | null {
	const { prefix, positional, params } = splitToken(token);
	if (prefix !== "blob") return null;

	for (const key of params.keys()) {
		if (key !== "accept") return null;
	}

	const namedAccepts = params.getAll("accept");
	if (namedAccepts.length > 0 && positional !== undefined) return null;

	const accepts = positional !== undefined ? [positional] : namedAccepts;
	if (accepts.length === 0 || !accepts.every(isBlobAccept)) return null;

	return { accepts: [...new Set(accepts)] };
}

/** Every `blob:` permission in a scope string, ignoring everything that is not one. */
export function readBlobPermissions(scope: string | null | undefined): BlobPermission[] {
	if (!scope) return [];
	const found: BlobPermission[] = [];
	for (const token of scope.split(/\s+/)) {
		if (!token) continue;
		const permission = readBlobToken(token);
		if (permission) found.push(permission);
	}
	return found;
}

/**
 * Whether a scope accepts an upload of one MIME type.
 *
 * Returned as a boolean because the caller's next step is the upload itself; the
 * list of what is missing would not change the answer. A malformed MIME type is
 * refused rather than matched against a wildcard, so a typo cannot become a
 * permission to send anything.
 */
export function scopeAllowsBlob(scope: string | null | undefined, mime: string): boolean {
	const wanted = mime.toLowerCase();
	if (!isMimeType(wanted)) return false;
	return readBlobPermissions(scope).some((permission) =>
		permission.accepts.some((accept) => matchesBlobAccept(accept.toLowerCase(), wanted)),
	);
}
