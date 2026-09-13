// SPDX-License-Identifier: Apache-2.0
/**
 * Mapping a reader's rows onto the records they own — comments, reviews, votes and follows.
 *
 * These are pure functions and write nothing. They exist ahead of any writer for the same
 * reason `atproto-records.ts` does: a Lexicon nobody has mapped real rows onto is a guess,
 * and publishing one is a public commitment that is expensive to correct. What a mapper
 * catches that reasoning does not is a required field there is no column to fill.
 *
 * 🚨 **These records are CANONICAL in the reader's repository and the row is an index**,
 * which is the opposite arrangement from a Work's listing. A Work's row carries price, gate,
 * delivery key and takedown state that can never be public, so the repository cannot hold
 * the whole of it; a comment, a review, a vote and a follow have no such field. The wiki's
 * *Federation → Where the Data Is Canonical* is the rule and the exception.
 *
 * ⚠️ **Every mapper refuses rather than throws.** "This one has no record" is an ordinary
 * outcome of walking a reader's history, not an error — the same shape `unpublishableReason`
 * uses for Works.
 */
import { isReviewVerdict } from "@anthers/shared/content";
import { isVoteDirection } from "@anthers/shared/votes";

/**
 * Why a reader's row has no record.
 *
 * ⚠️ **`no_author` is the tombstone case and it is common rather than exceptional.** Comments
 * and reviews keep their row with a null author when an account is deleted, so that a thread
 * other people took part in stays readable. There is no repository left to write into, and
 * writing one into somebody else's would be a lie about who said it.
 *
 * 🚨 **`subject_unpublished` is the compounding condition.** A record names its subject by
 * address, so an interaction can only be published once the thing it is about has a record of
 * its own. That depends on the SUBJECT's creator rather than on the reader acting here, which
 * is why it is reported as a distinct reason: a reader whose interactions stop publishing has
 * done nothing, and the fix is not theirs to make.
 */
export type UnpublishableReaderReason =
	| "no_author"
	| "hidden"
	| "empty_text"
	| "bad_verdict"
	| "bad_direction"
	| "subject_unpublished"
	| "subject_has_no_identity";

/** A subject named by the address of its own record. */
export interface RecordSubject {
	uri: string;
}

// ── Comment ──────────────────────────────────────────────────────────────────────────────

/** The comment columns a record is derived from. Deliberately narrow. */
export interface PublishableComment {
	userId: number | null;
	body: string;
	moderationStatus: string;
}

export interface CommentRecord {
	$type: "org.anthers.comment";
	subject: RecordSubject;
	text: string;
}

/**
 * Whether a comment may be written to its author's repository.
 *
 * 🚨 **A hidden comment gets no record, and that is NOT the same as deleting one that
 * already exists.** Moderation lives in the view: a record already on the network stays
 * where its author put it and Anthers declines to show it, because Anthers cannot unsay
 * somebody else's words and does not claim to. What this refuses is the separate act of
 * *newly publishing* material an operator has removed from view — a backfill that ignored
 * `moderationStatus` would push hidden comments onto a network with no moderation at all.
 */
export function unpublishableCommentReason(
	comment: PublishableComment,
	subjectUri: string | null,
): UnpublishableReaderReason | null {
	if (comment.userId === null) return "no_author";
	if (comment.moderationStatus !== "visible") return "hidden";
	if (!comment.body.trim()) return "empty_text";
	if (!subjectUri) return "subject_unpublished";
	return null;
}

export function commentToRecord(
	comment: PublishableComment,
	subjectUri: string | null,
): CommentRecord | null {
	if (unpublishableCommentReason(comment, subjectUri) !== null) return null;
	// Re-derived rather than asserted, for the reason `workToRecord` gives: a non-null
	// assertion is a lie waiting to become true if the two ever drift apart.
	if (!subjectUri) return null;
	return {
		$type: "org.anthers.comment",
		subject: { uri: subjectUri },
		text: comment.body,
	};
}

// ── Review ───────────────────────────────────────────────────────────────────────────────

/** The review columns a record is derived from. */
export interface PublishableReview {
	userId: number | null;
	verdict: string;
	body: string | null;
	moderationStatus: string;
}

export interface ReviewRecord {
	$type: "org.anthers.review";
	subject: RecordSubject;
	verdict: "recommended" | "not-recommended";
	text?: string;
}

/**
 * Whether a review may be written to its author's repository.
 *
 * ⚠️ **An absent body is NOT a refusal, although Anthers requires one when somebody writes a
 * review.** Rows predating that rule exist and still render, and the Lexicon makes `text`
 * optional precisely so a policy that may change is enforced where reviews are written rather
 * than frozen into a schema that cannot be. Refusing here would make those rows unpublishable
 * forever over a rule they were never held to.
 */
export function unpublishableReviewReason(
	review: PublishableReview,
	subjectUri: string | null,
): UnpublishableReaderReason | null {
	if (review.userId === null) return "no_author";
	if (review.moderationStatus !== "visible") return "hidden";
	if (!isReviewVerdict(review.verdict)) return "bad_verdict";
	if (!subjectUri) return "subject_unpublished";
	return null;
}

export function reviewToRecord(
	review: PublishableReview,
	subjectUri: string | null,
): ReviewRecord | null {
	if (unpublishableReviewReason(review, subjectUri) !== null) return null;
	if (!subjectUri) return null;

	if (!isReviewVerdict(review.verdict)) return null;

	const record: ReviewRecord = {
		$type: "org.anthers.review",
		subject: { uri: subjectUri },
		// 🚨 **A verdict, never a score.** The published set and what the validator accepts
		// are the same constant, so the API and the network cannot come to disagree about
		// what a review may say.
		verdict: review.verdict,
	};
	// An empty string is not a value: writing `text: ""` says the reviewer wrote an empty
	// review, where absence says they wrote none.
	if (review.body?.trim()) record.text = review.body;
	return record;
}

// ── Vote ─────────────────────────────────────────────────────────────────────────────────

/** The vote columns a record is derived from. */
export interface PublishableVote {
	userId: number | null;
	direction: string;
}

export interface VoteRecord {
	$type: "org.anthers.vote";
	subject: RecordSubject;
	direction: "up" | "down";
}

/**
 * Whether a vote may be written to its voter's repository.
 *
 * ⚠️ **A vote from a departed account has no record and still counts.** `votes.user_id` is
 * `set null` so that deleting an account does not move every score that person ever touched,
 * which means the row legitimately outlives the repository — the tally is Anthers' arithmetic
 * about its own page, where the record is an assertion by somebody who is no longer there to
 * make it.
 */
export function unpublishableVoteReason(
	vote: PublishableVote,
	subjectUri: string | null,
): UnpublishableReaderReason | null {
	if (vote.userId === null) return "no_author";
	if (!isVoteDirection(vote.direction)) return "bad_direction";
	if (!subjectUri) return "subject_unpublished";
	return null;
}

export function voteToRecord(vote: PublishableVote, subjectUri: string | null): VoteRecord | null {
	if (unpublishableVoteReason(vote, subjectUri) !== null) return null;
	if (!subjectUri || !isVoteDirection(vote.direction)) return null;
	return {
		$type: "org.anthers.vote",
		subject: { uri: subjectUri },
		direction: vote.direction,
	};
}

// ── Follow ───────────────────────────────────────────────────────────────────────────────

/** What a follow needs: who is followed, as an identifier the network can resolve. */
export interface PublishableFollow {
	followerId: number | null;
}

export interface FollowRecord {
	$type: "org.anthers.follow";
	subject: string;
}

/**
 * Whether a follow may be written to the follower's repository.
 *
 * 🚨 **The subject is the followed account's identifier, so THEY need one too**, which is a
 * different condition from every other record here — the others name a record Anthers
 * published and this one names a person Anthers did not create. `subject_has_no_identity` is
 * reported separately for that reason: it is the followed creator's gap rather than the
 * follower's, and nothing the follower does will close it.
 *
 * ⚠️ **This is `org.anthers.follow` and never `app.bsky.graph.follow`.** Following a creator
 * for their releases is a different act from an edge in a microblog's social graph, a reader
 * may reasonably want one without the other, and a permission set cannot address another
 * namespace in any case. Mirroring a follow onto that network is something a person chooses.
 */
export function unpublishableFollowReason(
	follow: PublishableFollow,
	creatorDid: string | null,
): UnpublishableReaderReason | null {
	if (follow.followerId === null) return "no_author";
	if (!creatorDid?.trim()) return "subject_has_no_identity";
	return null;
}

export function followToRecord(
	follow: PublishableFollow,
	creatorDid: string | null,
): FollowRecord | null {
	if (unpublishableFollowReason(follow, creatorDid) !== null) return null;
	if (!creatorDid) return null;
	return { $type: "org.anthers.follow", subject: creatorDid };
}
