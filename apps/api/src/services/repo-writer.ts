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
 * ⚠️ **Some reasons an account gets no writer are a job's business and some are not.**
 * {@link isOrdinary} separates them, for what a sync job logs and retries rather than for what a
 * person is told.
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
 * Whether a missing writer is nothing for a sync job to report or retry.
 *
 * ⭐ **The point of saying it once is that logging is where this gets quietly inverted.** An
 * identity held elsewhere with no grant cannot publish and is refused and warned about where the
 * creator will see it — `publishingPermissionRefusal`, and the banner reading `publishingStateFor`
 * — so a job meeting one has nothing to add, and a sweep that logged every such account would
 * train whoever reads its output to skim. The reasons that matter would then go past unread too.
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
