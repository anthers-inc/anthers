// SPDX-License-Identifier: Apache-2.0
/**
 * Choosing which repository writer an account's records go through.
 *
 * There are two, because there are two ways Anthers can come to hold the right to write into
 * somebody's repository. It can host the identity, in which case it issued the credential
 * itself (`hosted-repo-writer.ts`); or the creator can have granted it a narrow permission over
 * an identity hosted somewhere else (`oauth-repo-writer.ts`). This module is the one place that
 * knows both exist, so that everything above it goes on talking to a single {@link RepoWriter}.
 *
 * 🚨 **Hosting is tried first and a broken hosted credential is NOT routed around.** An account
 * with a hosted identity that cannot be opened is a fault in Anthers' own hub, and falling
 * through to a second route would write the record anyway and leave nobody with a reason to
 * look at the hub. The fallthrough happens on one condition only — that there is no hosted
 * identity at all — which is a statement about the account rather than about the machinery.
 *
 * ⚠️ **Every reason a creator gets no writer is ordinary except two.** Most accounts have no
 * hosted identity and have granted nothing, and that is the design rather than a gap: nobody is
 * asked for a network permission in order to publish on Anthers. {@link isOrdinary} is what
 * separates the quiet majority from the two states somebody should actually see.
 */
import type { RepoWriter } from "./atproto-repo.js";
import { hostedWriterFor, type NoWriterReason } from "./hosted-repo-writer.js";
import { type NoOauthWriterReason, oauthWriterFor } from "./oauth-repo-writer.js";

/** Why an account's records cannot be written right now, from either route. */
export type NoAccountWriterReason = Exclude<NoWriterReason, "not_hosted"> | NoOauthWriterReason;

export type AccountWriterResult =
	| { writer: RepoWriter }
	| { writer: null; reason: NoAccountWriterReason };

/**
 * Whether a missing writer is the ordinary state of affairs rather than something wrong.
 *
 * ⭐ **The point of saying it once is that logging is where this gets quietly inverted.** Two of
 * these reasons describe the majority of accounts, and a sweep that reported them would train
 * whoever reads its output to skim — at which point the two that matter go past unread as well.
 */
export function isOrdinary(reason: NoAccountWriterReason): boolean {
	return reason === "no_identity" || reason === "not_granted";
}

/**
 * Open a writer onto the repository this account's records belong in, whichever it is.
 *
 * An account rather than a creator, because a reader's comments, reviews, votes and follows go
 * into the reader's own repository exactly as a creator's listings go into theirs.
 *
 * 🚨 **`collections` is required and names everything the caller is about to write.** A hosted
 * identity can write any of them, but a permission granted over an identity held elsewhere is
 * per collection — so a writer opened without saying what it is for would be judged against the
 * wrong grant. See `oauthWriterFor`.
 *
 * ⚠️ **A hosted account never reaches the OAuth route**, and the two can never disagree about
 * which repository is meant: an account holds at most one `atproto_did`, so a hosted identity
 * and a linked one are the same identity when both are present.
 */
export async function writerForAccount(
	userId: number,
	opts: { collections: readonly string[]; fetchImpl?: typeof fetch },
): Promise<AccountWriterResult> {
	const hosted = await hostedWriterFor(userId, { fetchImpl: opts.fetchImpl });
	if (hosted.writer) return hosted;
	if (hosted.reason !== "not_hosted") return { writer: null, reason: hosted.reason };

	return oauthWriterFor(userId, opts.collections);
}
