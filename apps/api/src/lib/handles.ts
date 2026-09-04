// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one rule about a null `users.username`, in the one place every serializer can
 * reach it.
 *
 * Since the signup ceremony (migration `0032`) an account exists from the moment its
 * emailed code is verified, and claims a handle later, during onboarding. So there is a
 * real window in which a row in `users` has no name — and `username` is the `/@username`
 * profile URL, so a null one is not a cosmetic gap but an account with no public
 * existence at all.
 *
 * 🚨 **The null must not cross into the browser.** `PublicUser.username` and
 * `Creator.username` are both `string` on the client and there are ~180 reads between
 * them, essentially all of them building a link or printing `@name`. Widening those to
 * `string | null` would spread a case that must never reach a reader across every one,
 * and the honest handling at each is identical anyway: an account with no handle is not
 * yet somebody you can visit.
 *
 * So the null is resolved at the API boundary, in exactly two shapes:
 *
 *   • A **profile** — `serializePublicUser` in `routes/accounts.ts` takes only claimed
 *     accounts, and its callers drop or 404 the rest.
 *   • An **embedded creator** on a content row — this file. A row whose author has no
 *     handle serializes with no `creator` at all.
 *
 * That second shape is not a new state for the client: `creator` is already optional and
 * already absent on a **tombstoned** post, where the account was deleted and the post
 * stayed so the discussion under it still reads. Reusing "absent" means every renderer
 * that already copes with a missing author copes with this too, and nothing has to learn
 * a second way for an author to be unnameable.
 */

import type { users } from "@anthers/db/schema";

/** The embedded-creator shape the client calls `Creator`. */
interface EmbeddedCreator {
	username: string;
	displayName: string | null;
	avatar: string | null;
}

/** The columns an embed needs, however the caller happened to select them. */
interface CreatorColumns {
	username: string | null;
	displayName: string | null;
	avatar: string | null;
}

/**
 * Build the `creator` field for a content row, or `undefined` when the author has not
 * claimed a handle.
 *
 * Returning `undefined` rather than a placeholder is deliberate: a placeholder would
 * render as a live link to a profile that 404s, which is worse than showing no author,
 * and it would put a fabricated name in front of a reader. `undefined` drops the key
 * from the JSON entirely, which is precisely what a tombstoned post already sends.
 *
 * In practice this should never fire — publishing requires a creator account, and
 * onboarding claims the handle before anything else — but "it cannot happen because of
 * what another function does" is the reasoning this codebase has been bitten by often
 * enough to stop writing down.
 */
export function embedCreator(row: CreatorColumns): EmbeddedCreator | undefined {
	if (row.username === null) return undefined;
	return { username: row.username, displayName: row.displayName, avatar: row.avatar };
}

/** An account that has finished onboarding — the only kind a public surface renders. */
export type ClaimedUser = typeof users.$inferSelect & { username: string };

/**
 * Whether this account has claimed a handle.
 *
 * A type guard rather than a `where` clause so that narrowing and filtering are the same
 * act. A SQL-side `IS NOT NULL` excludes the same rows, but TypeScript cannot see it, so
 * it would leave every call site still needing an assertion — and the assertion is the
 * thing worth removing.
 */
export function hasHandle(user: typeof users.$inferSelect): user is ClaimedUser {
	return user.username !== null;
}
