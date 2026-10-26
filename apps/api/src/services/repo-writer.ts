// SPDX-License-Identifier: Apache-2.0
/**
 * Choosing which repository writer an account's records go through.
 *
 * There are two, because there are two ways Anthers can come to hold the right to write into
 * somebody's repository. It can host the identity, in which case it issued the credential itself
 * (`hosted-repo-writer.ts`); or the person can have granted it a permission over an identity
 * (`oauth-repo-writer.ts`), which now includes a hosted one, because a hosted identity signs in
 * through its own authorization server like any other. This module is the one place that knows
 * both exist, so everything above it goes on talking to a single {@link RepoWriter}.
 *
 * 🚨 **A recorded grant is tried first, and once recorded it is the authority.** An identity on
 * another server is written through the grant its holder gave; a hosted identity can also hold a
 * grant if it authorized through OAuth, and that grant outranks the session. A narrowed or revoked
 * grant is NOT routed around by the hub's own session, because that would make the withdrawal
 * cosmetic — the person would see a permission they had taken back keep working.
 *
 * ⭐ **The hub's session is the first-party client's credential.** Anthers hosts the identity, so
 * it is the client of its own PDS, and the session it opened when it created the account (or the
 * one a login replaced) is what every writer uses. That is the shape the official Bluesky client
 * has, not a transition state, and the session route is not going away.
 *
 * ⚠️ **Some reasons an account gets no writer are a job's business and some are not.**
 * {@link isOrdinary} separates them, for what a sync job logs and retries rather than for what a
 * person is told.
 */
import { hasRecordedGrant } from "./atproto-client.js";
import type { RepoWriter } from "./atproto-repo.js";
import { hostedWriterFor, type NoWriterReason } from "./hosted-repo-writer.js";
import { type NoOauthWriterReason, oauthWriterFor } from "./oauth-repo-writer.js";

/** Why an account's records cannot be written right now, from either route. */
export type NoAccountWriterReason = Exclude<NoWriterReason, "not_hosted"> | NoOauthWriterReason;

export type AccountWriterResult =
	| { writer: RepoWriter }
	| { writer: null; reason: NoAccountWriterReason };

/**
 * Whether a missing writer is nothing for a sync job to report or retry.
 *
 * ⭐ **The point of saying it once is that logging is where this gets quietly inverted.** An
 * identity with no grant cannot publish and is refused and warned about where the person will see
 * it — `publishingPermissionRefusal`, and the banner reading `publishingStateFor` — so a job
 * meeting one has nothing to add, and a sweep that logged every such account would train whoever
 * reads its output to skim. The reasons that matter would then go past unread too.
 *
 * ⚠️ **`no_identity` left this set when the last account without an identity did** — every
 * account holds one, so the writer can never answer it. It stays in the reason union for the
 * typecheck, and a job meeting one now logs it, because it would mean an account invariant broke.
 */
export function isOrdinary(reason: NoAccountWriterReason): boolean {
	return reason === "not_granted";
}

/**
 * Open a writer onto the repository this account's records belong in, whichever it is.
 *
 * An account rather than a creator, because a user's comments, reviews, votes and follows go
 * into the user's own repository exactly as a creator's listings go into theirs.
 *
 * 🚨 **`collections` is required and names everything the caller is about to write.** A grant is
 * per collection, so a writer opened without saying what it is for would be judged against the
 * wrong grant. See `oauthWriterFor`.
 *
 * ⚠️ **The two routes can never disagree about which repository is meant**: an account holds at
 * most one `atproto_did`, so a hosted identity and a linked one are the same identity when both
 * are present.
 */
export async function writerForAccount(
	userId: number,
	opts: { collections: readonly string[]; fetchImpl?: typeof fetch },
): Promise<AccountWriterResult> {
	// The person's grant first. For an identity hosted elsewhere this is the only route; for a
	// hosted one it is the route once they have signed in, which the login door now does.
	const oauth = await oauthWriterFor(userId, opts.collections);
	if (oauth.writer) return oauth;

	// No identity at all is an invariant break, not a missing permission, and the other route
	// cannot help.
	if (oauth.reason === "no_identity") return oauth;

	// 🚨 **A recorded authorization is an answer, even when the answer is no.** A narrowed grant,
	// a revoked one, or an authorization server that cannot be reached at the moment is the
	// person's grant talking, and the hub's session must not talk over it.
	if (await hasRecordedGrant(userId)) return oauth;

	// No recorded grant: a hosted identity holds the session Anthers opened when it created the
	// account, which is the first-party client's credential.
	const hosted = await hostedWriterFor(userId, { fetchImpl: opts.fetchImpl });
	if (hosted.writer) return hosted;
	if (hosted.reason !== "not_hosted") return { writer: null, reason: hosted.reason };

	// A brought identity with no grant: the OAuth refusal is the answer.
	return oauth;
}
