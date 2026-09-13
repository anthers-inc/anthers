// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deciding what should happen to a record, and carrying it out against a repository.
 *
 * This is `atproto-repo.ts` for everything that is not a Work listing — a reader's comments,
 * reviews, votes and follows, and a creator's posts and projects. The shape is the same —
 * a pure planner with its own tests, then a sync that performs the plan over the
 * {@link RepoWriter} seam — and it is deliberately ONE generic pair rather than one per record.
 * They differ only in which mapper they call and which collection they land in; six planners
 * would be six places for the delete branch to drift apart, and the delete branch is the one
 * that matters.
 *
 * 🚨 **These records are canonical and the row is an index, which inverts what a failure
 * means.** A Work's listing going wrong leaves the Work intact, because the row is the truth.
 * Here the record IS the truth, so a row whose record never got written is a row that claims
 * something the network cannot confirm — which is why every refusal is reported with a reason
 * rather than swallowed, and why `atproto-reader-records.ts` enumerates them.
 *
 * 🚨 **Whether a refusal takes an existing record DOWN depends on whose record it is, and each
 * kind says so itself.** A creator's post that goes back to a draft is the creator withdrawing
 * it, so its record comes down. A reader's comment that an operator hides is not the reader
 * withdrawing anything: the record stays where its author put it and Anthers declines to show
 * it, which is the wiki's *User Records in the Atmosphere* ruling and how Bluesky treats the same
 * problem. The same goes for a comment whose subject disappears — other people's records
 * survive the thing they were about. Deleting those would be Anthers editing somebody's own
 * repository over something they did not do. See {@link RecordKind.removes}.
 *
 * ⚠️ **Nothing is created or replaced in a collection whose Lexicon is unpublished**, for the
 * reason `published-lexicons.ts` gives. Removal is never withheld.
 */
import {
	commentRecord,
	followRecord,
	type LexiconValidator,
	postRecord,
	projectRecord,
	reviewRecord,
	voteRecord,
} from "@anthers/shared/lexicons";
import {
	type PostRecord,
	type ProjectRecord,
	type PublishablePost,
	type PublishableProject,
	postToRecord,
	projectToRecord,
	type UnpublishableCreatorReason,
	unpublishablePostReason,
	unpublishableProjectReason,
} from "./atproto-creator-records.js";
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
import { isLexiconPublished } from "./published-lexicons.js";

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
export interface RecordKind<Input, R extends object, Reason extends string> {
	readonly collection: string;
	reasonFor(input: Input): Reason | null;
	/**
	 * Whether this refusal takes down a record that already exists, or leaves it where it is.
	 *
	 * 🚨 **True only when the refusal is the record's OWNER taking it back.** Anything else — a
	 * moderator hiding it, its subject disappearing, a row that has drifted into a value the
	 * schema cannot hold — is a reason not to write it again and never a reason to reach into
	 * somebody's repository and delete what they said.
	 */
	removes(reason: Reason): boolean;
	toRecord(input: Input): R | null;
	readonly validator: LexiconValidator;
}

/** Why a record that would otherwise be written is being held back. */
export type WithheldReason = "lexicon_unpublished";

/** What should happen to one record, decided without touching the network. */
export type RecordPlan<R, Reason extends string> =
	| { action: "create"; record: R }
	| { action: "replace"; rkey: string; record: R }
	| { action: "delete"; rkey: string; reason: Reason }
	/** A record exists and is deliberately left exactly as it is. */
	| { action: "keep"; rkey: string; reason: Reason | WithheldReason }
	| { action: "none"; reason: Reason | WithheldReason }
	| { action: "invalid"; problem: string };

/**
 * Decide what to do with one record, given whatever record it already has.
 *
 * 🚨 **"Unpublishable" is three different outcomes, not two.** With no record there is nothing
 * to do. With one, it comes down only when the kind says this refusal is its owner's — otherwise
 * it is kept, and keeping it means keeping the stored address too, because forgetting where a
 * record is strands it.
 *
 * ⚠️ **The record is validated against its own Lexicon before anything is sent.** The generated
 * validator is the same schema a consumer would check against, so a malformed record is caught
 * while it is still local — the one moment catching it is free. That happens BEFORE the
 * publication gate, so a record that would be malformed is reported as such even while its
 * schema is still a draft.
 */
export function planRecord<Input, R extends object, Reason extends string>(
	kind: RecordKind<Input, R, Reason>,
	input: Input,
	existingUri: string | null,
): RecordPlan<R, Reason> {
	const rkey = existingUri ? rkeyFromAtUri(existingUri, kind.collection) : null;

	// An unreadable stored URI is refused rather than read as "no record". Treating it as
	// absent would write a second record and orphan the first, and a duplicate public record
	// is far harder to clean up than a row somebody has to look at.
	if (existingUri && rkey === null) {
		return { action: "invalid", problem: `unreadable atproto_uri: ${existingUri}` };
	}

	const reason = kind.reasonFor(input);
	if (reason !== null) {
		if (!rkey) return { action: "none", reason };
		return kind.removes(reason)
			? { action: "delete", rkey, reason }
			: { action: "keep", rkey, reason };
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

	// A draft schema writes nothing, and a record that somehow already exists under one is kept
	// rather than forgotten — see `published-lexicons.ts`.
	if (!isLexiconPublished(kind.collection)) {
		return rkey
			? { action: "keep", rkey, reason: "lexicon_unpublished" }
			: { action: "none", reason: "lexicon_unpublished" };
	}

	return rkey ? { action: "replace", rkey, record } : { action: "create", record };
}

/** What a sync did, and the value the row's `atproto_uri` should now hold. */
export interface RecordOutcome<R, Reason extends string> {
	plan: RecordPlan<R, Reason>;
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
export async function syncRecord<Input, R extends object, Reason extends string>(
	writer: RepoWriter,
	kind: RecordKind<Input, R, Reason>,
	input: Input,
	existingUri: string | null,
): Promise<RecordOutcome<R, Reason>> {
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
		case "keep":
			// 🚨 The stored address stays. A record deliberately left on the network is still one
			// Anthers has to be able to find — to rewrite when a comment is restored, or to remove
			// when its author deletes it.
			return { plan, uri: existingUri };
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

/**
 * Which refusals of a reader's record are the reader taking it back.
 *
 * 🚨 **Only `empty_text`, which a reader reaches by editing their own words away.** Every other
 * refusal leaves an existing record exactly where it is:
 *
 * - `hidden` is a moderator's decision, and the record stays where its author put it.
 * - `subject_unpublished` and `subject_has_no_identity` are the SUBJECT going away, and other
 *   people's records survive the thing they were about.
 * - `no_author` is a closed account, whose records go with the account rather than one by one.
 * - `bad_verdict` and `bad_direction` are a row that drifted after a valid record was written,
 *   which is a reason to look at the row and not a reason to delete somebody's statement.
 *
 * A reader deleting the comment, the vote or the follow outright is the other way a record comes
 * down, and it does not pass through here at all — the row is gone, so `remove-atproto-record`
 * carries it.
 */
function readerRemoves(reason: UnpublishableReaderReason): boolean {
	return reason === "empty_text";
}

export interface CommentInput {
	comment: PublishableComment;
	subjectUri: string | null;
}

export const COMMENT_KIND: RecordKind<CommentInput, CommentRecord, UnpublishableReaderReason> = {
	collection: COMMENT_COLLECTION,
	reasonFor: ({ comment, subjectUri }) => unpublishableCommentReason(comment, subjectUri),
	removes: readerRemoves,
	toRecord: ({ comment, subjectUri }) => commentToRecord(comment, subjectUri),
	validator: commentRecord,
};

export interface ReviewInput {
	review: PublishableReview;
	subjectUri: string | null;
}

export const REVIEW_KIND: RecordKind<ReviewInput, ReviewRecord, UnpublishableReaderReason> = {
	collection: REVIEW_COLLECTION,
	reasonFor: ({ review, subjectUri }) => unpublishableReviewReason(review, subjectUri),
	removes: readerRemoves,
	toRecord: ({ review, subjectUri }) => reviewToRecord(review, subjectUri),
	validator: reviewRecord,
};

export interface VoteInput {
	vote: PublishableVote;
	subjectUri: string | null;
}

export const VOTE_KIND: RecordKind<VoteInput, VoteRecord, UnpublishableReaderReason> = {
	collection: VOTE_COLLECTION,
	reasonFor: ({ vote, subjectUri }) => unpublishableVoteReason(vote, subjectUri),
	removes: readerRemoves,
	toRecord: ({ vote, subjectUri }) => voteToRecord(vote, subjectUri),
	validator: voteRecord,
};

export interface FollowInput {
	follow: PublishableFollow;
	/** The followed account's identifier — theirs rather than the follower's. */
	creatorDid: string | null;
}

export const FOLLOW_KIND: RecordKind<FollowInput, FollowRecord, UnpublishableReaderReason> = {
	collection: FOLLOW_COLLECTION,
	reasonFor: ({ follow, creatorDid }) => unpublishableFollowReason(follow, creatorDid),
	removes: readerRemoves,
	toRecord: ({ follow, creatorDid }) => followToRecord(follow, creatorDid),
	validator: followRecord,
};

// ── The creator's two ────────────────────────────────────────────────────────────────────
//
// ⚠️ A Work's listing is NOT here: it predates this module, has its own planner in
// `atproto-repo.ts`, and is the one record whose row is canonical rather than an index. The
// asymmetry is argued in the wiki's *Federation → Where the Data Is Canonical* and is the
// reason the two have not been folded together.

export const POST_COLLECTION = "org.anthers.post";

/**
 * Every refusal of a creator's record is the creator taking it back.
 *
 * A post returned to a draft, a project unpublished or left untitled — each is its creator
 * deciding the thing should not be public, so a record already out there comes down.
 */
function creatorRemoves(_reason: UnpublishableCreatorReason): boolean {
	return true;
}
export const PROJECT_COLLECTION = "org.anthers.project";

export const POST_KIND: RecordKind<PublishablePost, PostRecord, UnpublishableCreatorReason> = {
	collection: POST_COLLECTION,
	reasonFor: (post) => unpublishablePostReason(post),
	removes: creatorRemoves,
	toRecord: (post) => postToRecord(post, { baseUrl: siteBaseUrl() }),
	validator: postRecord,
};

export const PROJECT_KIND: RecordKind<
	PublishableProject,
	ProjectRecord,
	UnpublishableCreatorReason
> = {
	collection: PROJECT_COLLECTION,
	reasonFor: (project) => unpublishableProjectReason(project),
	removes: creatorRemoves,
	toRecord: (project) => projectToRecord(project, { baseUrl: siteBaseUrl() }),
	validator: projectRecord,
};

/**
 * Where the public pages these records point at live.
 *
 * ⚠️ Read at call time rather than captured at import, so a test can set it and so a worker
 * that starts before its environment is fully populated does not bake in the fallback.
 */
function siteBaseUrl(): string {
	return process.env.FRONTEND_URL?.trim() || "https://anthers.org";
}
