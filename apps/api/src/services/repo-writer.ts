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
 * 🚨 **The person's grant is tried first, and once recorded it is the authority.** A hosted
 * identity that has signed in through OAuth holds the same kind of grant a brought identity does,
 * and from that moment its grant decides what Anthers may write. A narrowed or revoked grant is
 * NOT routed around by the hub's own session, because that would make the withdrawal cosmetic —
 * the person would see a permission they had taken back keep working.
 *
 * ⏳ **The hub's session is the transition credential for a hosted identity that has never
 * authorized Anthers through OAuth.** It keeps a brand-new account writable between signup and
 * its first sign-in, and it kept existing accounts writable through the change. Once every hosted
 * account holds a grant, the session route and this fallback go.
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

	// Never authorized through OAuth: a hosted identity still holds the session Anthers opened
	// when it created the account. That is the transition credential.
	const hosted = await hostedWriterFor(userId, { fetchImpl: opts.fetchImpl });
	if (hosted.writer) return hosted;
	if (hosted.reason !== "not_hosted") return { writer: null, reason: hosted.reason };

	// A brought identity with no grant: the OAuth refusal is the answer.
	return oauth;
}
