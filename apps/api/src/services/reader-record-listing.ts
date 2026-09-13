// SPDX-License-Identifier: Apache-2.0
/**
 * Keeping a reader's comments, reviews, votes and follows in step with the records they own.
 *
 * This module reads the rows, looks up what each record needs beside its row, and remembers
 * where the records went; `record-sync.ts` does the planning and writing every kind shares. It is
 * the only writer of `atproto_uri` on `comments`, `reviews`, `votes` and `follows`.
 *
 * 🚨 **These records are canonical in the reader's repository, and that decides what may take
 * one down.** Only the reader's own act does — unvoting, unfollowing, editing their words away.
 * A moderator hiding a comment leaves its record where its author put it, and a subject that
 * disappears leaves every record about it standing. See `readerRemoves` in
 * `atproto-record-plan.ts`, and the wiki's *User Records in the Atmosphere*.
 *
 * ⚠️ **An interaction publishes only once its subject has a record of its own**, because a
 * record names its subject by address. That depends on the subject's creator rather than on the
 * reader, so the sync that finds `subject_unpublished` writes nothing and the reconciling sweep
 * comes back for it once the subject is listed. Nothing here fans out from a subject gaining a
 * record to every interaction waiting on it: a busy thread would turn one post's first sync into
 * a burst against every commenter's server.
 */
import { db } from "@anthers/db";
import { comments, follows, posts, reviews, users, votes, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type {
	CommentRecord,
	FollowRecord,
	ReviewRecord,
	UnpublishableReaderReason,
	VoteRecord,
} from "./atproto-reader-records.js";
import { COMMENT_KIND, FOLLOW_KIND, REVIEW_KIND, VOTE_KIND } from "./atproto-record-plan.js";
import { type RecordSyncResult, syncOwnedRecord } from "./record-sync.js";

/** What syncing one reader record did. */
export type ReaderRecordSyncResult<R> = RecordSyncResult<R, UnpublishableReaderReason>;

type Opts = { fetchImpl?: typeof fetch };

/**
 * The address of the record a comment, a review or a vote is about, or null when it has none.
 *
 * ⚠️ **An unrecognized subject type answers null rather than throwing**, which plans as
 * `subject_unpublished`: a kind of subject this build does not know how to address is one it
 * cannot name, and naming nothing is the correct thing to publish about it.
 */
export async function subjectRecordUri(
	subjectType: string,
	subjectId: number,
): Promise<string | null> {
	switch (subjectType) {
		case "work": {
			const [row] = await db
				.select({ uri: works.atprotoUri })
				.from(works)
				.where(eq(works.id, subjectId))
				.limit(1);
			return row?.uri ?? null;
		}
		case "post": {
			const [row] = await db
				.select({ uri: posts.atprotoUri })
				.from(posts)
				.where(eq(posts.id, subjectId))
				.limit(1);
			return row?.uri ?? null;
		}
		case "comment": {
			const [row] = await db
				.select({ uri: comments.atprotoUri })
				.from(comments)
				.where(eq(comments.id, subjectId))
				.limit(1);
			return row?.uri ?? null;
		}
		default:
			return null;
	}
}

/** Bring one comment's record into line with the comment. */
export async function syncCommentRecord(
	commentId: number,
	opts: Opts = {},
): Promise<ReaderRecordSyncResult<CommentRecord>> {
	const [row] = await db
		.select({
			userId: comments.userId,
			body: comments.body,
			moderationStatus: comments.moderationStatus,
			subjectType: comments.subjectType,
			subjectId: comments.subjectId,
			atprotoUri: comments.atprotoUri,
		})
		.from(comments)
		.where(eq(comments.id, commentId))
		.limit(1);
	if (!row) return { status: "skipped", reason: "no_row" };

	return syncOwnedRecord({
		ownerId: row.userId,
		kind: COMMENT_KIND,
		input: { comment: row, subjectUri: await subjectRecordUri(row.subjectType, row.subjectId) },
		existingUri: row.atprotoUri,
		storeUri: async (uri) => {
			await db.update(comments).set({ atprotoUri: uri }).where(eq(comments.id, commentId));
		},
		fetchImpl: opts.fetchImpl,
	});
}

/** Bring one review's record into line with the review. */
export async function syncReviewRecord(
	reviewId: number,
	opts: Opts = {},
): Promise<ReaderRecordSyncResult<ReviewRecord>> {
	const [row] = await db
		.select({
			userId: reviews.userId,
			workId: reviews.workId,
			verdict: reviews.verdict,
			body: reviews.body,
			moderationStatus: reviews.moderationStatus,
			atprotoUri: reviews.atprotoUri,
		})
		.from(reviews)
		.where(eq(reviews.id, reviewId))
		.limit(1);
	if (!row) return { status: "skipped", reason: "no_row" };

	const subjectUri = row.workId === null ? null : await subjectRecordUri("work", row.workId);
	return syncOwnedRecord({
		ownerId: row.userId,
		kind: REVIEW_KIND,
		input: { review: row, subjectUri },
		existingUri: row.atprotoUri,
		storeUri: async (uri) => {
			await db.update(reviews).set({ atprotoUri: uri }).where(eq(reviews.id, reviewId));
		},
		fetchImpl: opts.fetchImpl,
	});
}

/** Bring one vote's record into line with the vote. */
export async function syncVoteRecord(
	voteId: number,
	opts: Opts = {},
): Promise<ReaderRecordSyncResult<VoteRecord>> {
	const [row] = await db
		.select({
			userId: votes.userId,
			direction: votes.direction,
			subjectType: votes.subjectType,
			subjectId: votes.subjectId,
			atprotoUri: votes.atprotoUri,
		})
		.from(votes)
		.where(eq(votes.id, voteId))
		.limit(1);
	if (!row) return { status: "skipped", reason: "no_row" };

	return syncOwnedRecord({
		ownerId: row.userId,
		kind: VOTE_KIND,
		input: { vote: row, subjectUri: await subjectRecordUri(row.subjectType, row.subjectId) },
		existingUri: row.atprotoUri,
		storeUri: async (uri) => {
			await db.update(votes).set({ atprotoUri: uri }).where(eq(votes.id, voteId));
		},
		fetchImpl: opts.fetchImpl,
	});
}

/**
 * Bring one follow's record into line with the follow.
 *
 * ⚠️ **The subject is the followed account's identifier, read at sync time.** A creator who takes
 * an identity after being followed makes every waiting follow publishable, and the sweep is what
 * notices.
 */
export async function syncFollowRecord(
	followId: number,
	opts: Opts = {},
): Promise<ReaderRecordSyncResult<FollowRecord>> {
	const [row] = await db
		.select({
			followerId: follows.followerId,
			creatorDid: users.atprotoDid,
			atprotoUri: follows.atprotoUri,
		})
		.from(follows)
		.leftJoin(users, eq(users.id, follows.creatorId))
		.where(eq(follows.id, followId))
		.limit(1);
	if (!row) return { status: "skipped", reason: "no_row" };

	return syncOwnedRecord({
		ownerId: row.followerId,
		kind: FOLLOW_KIND,
		input: { follow: { followerId: row.followerId }, creatorDid: row.creatorDid },
		existingUri: row.atprotoUri,
		storeUri: async (uri) => {
			await db.update(follows).set({ atprotoUri: uri }).where(eq(follows.id, followId));
		},
		fetchImpl: opts.fetchImpl,
	});
}
