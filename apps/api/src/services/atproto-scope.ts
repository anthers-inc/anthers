// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reading an AT Protocol OAuth scope string, so Anthers can tell what it was actually granted.
 *
 * An authorization server is free to hand back something other than what was asked for, so
 * "we requested permission to write" and "we hold permission to write" are different claims
 * and only the second one is worth acting on. This module answers the second from the scope
 * string the token carries.
 *
 * ⚠️ **This is a reader, never the authority.** The repository itself decides whether a write
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
