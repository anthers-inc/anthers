// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deciding what should happen to a reader's record, and carrying it out against a repository.
 *
 * This is `atproto-repo.ts` for everything that is not a Work listing. The shape is the same —
 * a pure planner with its own tests, then a sync that performs the plan over the
 * {@link RepoWriter} seam — and it is deliberately ONE generic pair rather than four copies.
 * Comments, reviews, votes and follows differ only in which mapper they call and which
 * collection they land in; four planners would be four places for the delete branch to drift
 * apart, and the delete branch is the one that matters.
 *
 * 🚨 **These records are canonical and the row is an index, which inverts what a failure
 * means.** A Work's listing going wrong leaves the Work intact, because the row is the truth.
 * Here the record IS the truth, so a row whose record never got written is a row that claims
 * something the network cannot confirm — which is why every refusal is reported with a reason
 * rather than swallowed, and why `atproto-reader-records.ts` enumerates them.
 *
 * ⚠️ **The delete branch is still the one to read twice.** A comment that is hidden, a review
 * that is anonymized, a vote whose account has gone: each must have its record REMOVED rather
 * than merely skipped once one exists. Skipping leaves an assertion on the network that
 * Anthers has stopped standing behind, and a record is public the moment it lands.
 */
import {
	commentRecord,
	followRecord,
	type LexiconValidator,
	reviewRecord,
	voteRecord,
} from "@anthers/shared/lexicons";
import {
	type CommentRecord,
	commentToRecord,
	type FollowRecord,
	followToRecord,
	type PublishableComment,
	type PublishableFollow,
	type PublishableReview,
	type PublishableVote,
	type ReviewRecord,
	reviewToRecord,
	type UnpublishableReaderReason,
	unpublishableCommentReason,
	unpublishableFollowReason,
	unpublishableReviewReason,
	unpublishableVoteReason,
	type VoteRecord,
	voteToRecord,
} from "./atproto-reader-records.js";
import { type RepoWriter, rkeyFromAtUri } from "./atproto-repo.js";

export const COMMENT_COLLECTION = "org.anthers.comment";
export const REVIEW_COLLECTION = "org.anthers.review";
export const VOTE_COLLECTION = "org.anthers.vote";
export const FOLLOW_COLLECTION = "org.anthers.follow";

/**
 * One record type, described by everything the planner needs to know about it.
 *
 * ⚠️ `Input` bundles the row with whatever the mapper needs beside it — a subject's address, or
 * the followed account's identifier. Those are looked up by the caller rather than here,
 * because this module touches no database for the same reason `atproto-repo.ts` touches no
 * network client: the decision has to be checkable in isolation.
 */
export interface RecordKind<Input, R extends object> {
	readonly collection: string;
	reasonFor(input: Input): UnpublishableReaderReason | null;
	toRecord(input: Input): R | null;
	readonly validator: LexiconValidator;
}

/** What should happen to one record, decided without touching the network. */
export type RecordPlan<R> =
	| { action: "create"; record: R }
	| { action: "replace"; rkey: string; record: R }
	| { action: "delete"; rkey: string; reason: UnpublishableReaderReason }
	| { action: "none"; reason: UnpublishableReaderReason }
	| { action: "invalid"; problem: string };

/**
 * Decide what to do with one record, given whatever record it already has.
 *
 * 🚨 **"Unpublishable" is two different outcomes depending on whether a record exists**, and
 * conflating them is the bug this shape prevents. With no record, there is nothing to do.
 * With one, it has to come down.
 *
 * ⚠️ **The record is validated against its own Lexicon before anything is sent.** The generated
 * validator is the same schema a consumer would check against, so a malformed record is caught
 * while it is still local — the one moment catching it is free.
 */
export function planRecord<Input, R extends object>(
	kind: RecordKind<Input, R>,
	input: Input,
	existingUri: string | null,
): RecordPlan<R> {
	const rkey = existingUri ? rkeyFromAtUri(existingUri, kind.collection) : null;

	// An unreadable stored URI is refused rather than read as "no record". Treating it as
	// absent would write a second record and orphan the first, and a duplicate public record
	// is far harder to clean up than a row somebody has to look at.
	if (existingUri && rkey === null) {
		return { action: "invalid", problem: `unreadable atproto_uri: ${existingUri}` };
	}

	const reason = kind.reasonFor(input);
	if (reason !== null) {
		return rkey ? { action: "delete", rkey, reason } : { action: "none", reason };
	}

	const record = kind.toRecord(input);
	// Unreachable while the reason function is the only thing that makes a mapper return null,
	// and checked rather than asserted so the two staying in step is enforced instead of
	// assumed.
	if (!record) return { action: "invalid", problem: "mapper produced no record" };

	const parsed = kind.validator.safeParse(record);
	if (!parsed.success) {
		return { action: "invalid", problem: `record fails its own Lexicon: ${parsed.error}` };
	}

	return rkey ? { action: "replace", rkey, record } : { action: "create", record };
}

/** What a sync did, and the value the row's `atproto_uri` should now hold. */
export interface RecordOutcome<R> {
	plan: RecordPlan<R>;
	/** The record's address, or null when the row has no record any more. */
	uri: string | null;
}

/**
 * Carry out {@link planRecord} against a repository.
 *
 * Returns the URI the caller should store rather than writing it, because the row and the
 * record have different owners — this module owns the record, and the row belongs to whatever
 * service created it.
 */
export async function syncRecord<Input, R extends object>(
	writer: RepoWriter,
	kind: RecordKind<Input, R>,
	input: Input,
	existingUri: string | null,
): Promise<RecordOutcome<R>> {
	const plan = planRecord(kind, input, existingUri);

	switch (plan.action) {
		case "create": {
			const ref = await writer.createRecord(kind.collection, plan.record);
			return { plan, uri: ref.uri };
		}
		case "replace": {
			const ref = await writer.putRecord(kind.collection, plan.rkey, plan.record);
			return { plan, uri: ref.uri };
		}
		case "delete": {
			await writer.deleteRecord(kind.collection, plan.rkey);
			return { plan, uri: null };
		}
		case "none":
			return { plan, uri: null };
		case "invalid":
			// Deliberately leaves the stored URI alone. The two things that produce `invalid`
			// are a URI nobody can parse and a record that fails its own schema, and neither is
			// improved by this function also forgetting where the record was.
			return { plan, uri: existingUri };
	}
}

// ── The four kinds ───────────────────────────────────────────────────────────────────────
//
// ⚠️ Each bundles its row with whatever the mapper needs beside it. The subject's address and
// the followed account's identifier are looked up by the caller, so that planning stays a
// pure function of what it is given.

export interface CommentInput {
	comment: PublishableComment;
	subjectUri: string | null;
}

export const COMMENT_KIND: RecordKind<CommentInput, CommentRecord> = {
	collection: COMMENT_COLLECTION,
	reasonFor: ({ comment, subjectUri }) => unpublishableCommentReason(comment, subjectUri),
	toRecord: ({ comment, subjectUri }) => commentToRecord(comment, subjectUri),
	validator: commentRecord,
};

export interface ReviewInput {
	review: PublishableReview;
	subjectUri: string | null;
}

export const REVIEW_KIND: RecordKind<ReviewInput, ReviewRecord> = {
	collection: REVIEW_COLLECTION,
	reasonFor: ({ review, subjectUri }) => unpublishableReviewReason(review, subjectUri),
	toRecord: ({ review, subjectUri }) => reviewToRecord(review, subjectUri),
	validator: reviewRecord,
};

export interface VoteInput {
	vote: PublishableVote;
	subjectUri: string | null;
}

export const VOTE_KIND: RecordKind<VoteInput, VoteRecord> = {
	collection: VOTE_COLLECTION,
	reasonFor: ({ vote, subjectUri }) => unpublishableVoteReason(vote, subjectUri),
	toRecord: ({ vote, subjectUri }) => voteToRecord(vote, subjectUri),
	validator: voteRecord,
};

export interface FollowInput {
	follow: PublishableFollow;
	/** The followed account's identifier — theirs rather than the follower's. */
	creatorDid: string | null;
}

export const FOLLOW_KIND: RecordKind<FollowInput, FollowRecord> = {
	collection: FOLLOW_COLLECTION,
	reasonFor: ({ follow, creatorDid }) => unpublishableFollowReason(follow, creatorDid),
	toRecord: ({ follow, creatorDid }) => followToRecord(follow, creatorDid),
	validator: followRecord,
};
