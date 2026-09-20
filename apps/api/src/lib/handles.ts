// SPDX-License-Identifier: Apache-2.0
/**
 * Resolving the handle in a `/@handle` address to the account it names.
 *
 * An account's public address is its ATProto handle — there is no second, Anthers-only
 * username, because a handle already names its own namespace and a bare one would be one
 * identity answering to two names. The segment after `/@` is looked up against
 * `users.atprotoHandle`, which is stored and kept true rather than resolved live on every
 * read: the catalog, a comment thread and a supporter list are joins against `users`, and
 * each of them reading a name off the network per row would be the whole of Bluesky's
 * identity resolution without any of the infrastructure that makes that cheap for them.
 *
 * A stored handle goes stale in exactly one way — the person changed it, at their server,
 * under the same DID. When the lookup above resolves to nothing, the stale row is what the
 * miss falls through to: `handle_history` is a cache of the directory that holds the old
 * address for a window after a change, so an old link redirects rather than dying. It is
 * consulted only here and only after the live lookup has failed, because a name somebody
 * new has since taken is theirs — a held redirect must never shadow a live claim, and this
 * ordering is what makes that true without any logic in the history table itself.
 */

import { db } from "@anthers/db";
import { handleHistory, users } from "@anthers/db/schema";
import { and, eq, gt } from "drizzle-orm";

/** The account a handle names right now, or nothing — no history consulted. */
export async function accountByHandle(
	handle: string,
): Promise<typeof users.$inferSelect | undefined> {
	const [account] = await db.select().from(users).where(eq(users.atprotoHandle, handle)).limit(1);
	return account;
}

export interface HandleResolution {
	/** The account the address reaches, when it reaches one. */
	account?: typeof users.$inferSelect;
	/** Where the address should redirect to, when the account moved under a new handle. */
	redirectToHandle?: string;
}

/**
 * Who a `/@handle` address is for.
 *
 * Three answers, matching the address's three honest states: it names somebody now
 * (`account`), it used to and the person is still here under a new name (`redirectToHandle`,
 * the case the history table exists for), or it names nobody (`{}` → the route 404s).
 *
 * The redirect is produced rather than followed so the caller decides what to do with it —
 * a profile page 301s to the new address, while a follow or a block acts on the found
 * account directly, because naming somebody by a name they left is still naming them.
 */
export async function resolveHandle(handle: string): Promise<HandleResolution> {
	const account = await accountByHandle(handle);
	if (account) return { account };

	const [former] = await db
		.select({ handle: users.atprotoHandle })
		.from(handleHistory)
		.innerJoin(users, eq(handleHistory.did, users.atprotoDid))
		.where(and(eq(handleHistory.oldHandle, handle), gt(handleHistory.holdUntil, new Date())))
		.limit(1);
	if (former && former.handle !== handle) return { redirectToHandle: former.handle };
	return {};
}

/**
 * The `creator` field for a content row — the shape the client calls `Creator`.
 *
 * Every account has a handle, so unlike the arrangement this replaced there is no
 * unnameable-author state to guard against at the boundary: the value is built from the
 * row outright. The field stays optional on the client because a *tombstoned* post — the
 * account deleted, the post kept so the discussion under it still reads — still ships
 * without one.
 */
export function embedCreator(row: {
	handle: string;
	displayName: string | null;
	avatar: string | null;
}): { handle: string; displayName: string | null; avatar: string | null } {
	return { handle: row.handle, displayName: row.displayName, avatar: row.avatar };
}
