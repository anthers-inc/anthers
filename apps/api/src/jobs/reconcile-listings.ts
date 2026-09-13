// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Find rows whose record on the network disagrees with the row, and queue a sync for each.
 *
 * Covers Works, posts and projects — everything Anthers publishes on a creator's behalf whose
 * row is the truth and whose record is derived from it.
 *
 * 🚨 **The per-event enqueues are the latency; this is the guarantee.** Every path that can
 * change publishability asks for a sync as it goes, and each of those can still be lost: both
 * enqueue helpers swallow a failure on purpose — a creator's release or publish must not fail
 * because a queue blinked — a job can exhaust its retries against a node that was down all
 * night, and a state changed directly in SQL asks for nothing at all. Without a sweep, every one
 * of those leaves a record advertising something that is no longer listed, and nothing ever
 * notices.
 *
 * ⚠️ **A row DELETED outright is the one thing this cannot catch**, because the row it would
 * compare against is exactly what has gone. That is `remove-atproto-record`'s job, enqueued
 * before the delete, and it is why that queue has the most generous retry budget of the three.
 *
 * ⚠️ **It looks for DISAGREEMENT rather than recency**, so it is cheap and self-limiting: a
 * Work whose listing is already correct is never touched, and a sweep that finds nothing does
 * one query. It enqueues rather than syncing inline, so the reconciling and the writing share
 * one code path and one set of retries.
 *
 * ⭐ **The two halves are not symmetrical and the ordering says so.** A record that should not
 * exist is a live disclosure — something withdrawn, taken down, quarantined, or rated Adult,
 * still being advertised — and it is found first. A record that is merely missing is a listing
 * nobody has, which is a smaller problem and can wait behind it.
 */
import { db } from "@anthers/db";
import {
	comments,
	follows,
	hostedAccounts,
	posts,
	projects,
	reviews,
	users,
	votes,
	works,
} from "@anthers/db/schema";
import { and, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import {
	COMMENT_COLLECTION,
	FOLLOW_COLLECTION,
	POST_COLLECTION,
	PROJECT_COLLECTION,
	REVIEW_COLLECTION,
	VOTE_COLLECTION,
} from "../services/atproto-record-plan.js";
import { isLexiconPublished } from "../services/published-lexicons.js";
import { queueRecordSync, type RecordSyncKind } from "../services/record-sync.js";

type Enqueue = (kind: RecordSyncKind, id: number) => Promise<void>;

import { queueWorkListingSync } from "../services/work-listing.js";

/** How many rows one sweep will queue, per kind. A ceiling, so a first run cannot flood. */
const SWEEP_LIMIT = 500;

/** Where the sweep sends what it finds. Injectable so a suite can see what it asked for. */
export interface SweepSinks {
	enqueueWork?: (workId: number) => Promise<void>;
	enqueueRecord?: (kind: RecordSyncKind, id: number) => Promise<void>;
}

export async function reconcileListings(sinks: SweepSinks = {}): Promise<void> {
	const enqueueWork = sinks.enqueueWork ?? queueWorkListingSync;
	const enqueueRecord = sinks.enqueueRecord ?? queueRecordSync;

	// ── Records that should not exist ────────────────────────────────────
	//
	// Deliberately expressed as "has a URI and is not plainly publishable" rather than as the
	// negation of `unpublishableReason`, because that function is TypeScript and this is SQL:
	// keeping them in step is impossible, so this is the loose net and the job re-checks
	// properly. Over-selecting costs a read per Work; under-selecting leaves a disclosure up.
	const stale = await db
		.select({ id: works.id })
		.from(works)
		.where(
			and(
				isNotNull(works.atprotoUri),
				sql`(
					${works.visibility} <> 'released'
					OR ${works.takedownStatus} <> 'active'
					OR ${works.quarantineStatus} = 'quarantined'
					OR ${works.maturity} NOT IN ('general', 'mature')
					OR ${works.releasedAt} IS NULL
					OR ${works.creatorId} IS NULL
				)`,
			),
		)
		.limit(SWEEP_LIMIT);

	for (const row of stale) await enqueueWork(row.id);

	// ── Records that should exist and do not ─────────────────────────────
	//
	// Joined against `hosted_accounts` so this asks only about creators Anthers can actually
	// write for. Without it every released Work by every creator without a handle would be
	// selected on every sweep, for ever, to be skipped each time.
	const remaining = SWEEP_LIMIT - stale.length;
	const missing =
		remaining <= 0
			? []
			: await db
					.select({ id: works.id })
					.from(works)
					.innerJoin(hostedAccounts, eq(hostedAccounts.userId, works.creatorId))
					.where(
						and(
							isNull(works.atprotoUri),
							eq(works.visibility, "released"),
							eq(works.takedownStatus, "active"),
							eq(works.quarantineStatus, "none"),
							isNotNull(works.releasedAt),
							sql`${works.maturity} IN ('general', 'mature')`,
						),
					)
					.limit(remaining);

	for (const row of missing) await enqueueWork(row.id);

	const creator = await reconcileCreatorRecords(enqueueRecord);
	const reader = await reconcileReaderRecords(enqueueRecord);

	const toCorrect = stale.length + creator.stale;
	const toPublish = missing.length + creator.missing + reader.missing;
	if (toCorrect > 0 || toPublish > 0) {
		console.log(
			`[reconcile-listings] queued ${toCorrect} to remove or correct, ${toPublish} to publish`,
		);
	}
}

/**
 * The same sweep over a creator's posts and projects.
 *
 * ⭐ **In this job rather than a cron of its own, deliberately.** A second schedule would be a
 * second thing to notice had stopped running, and these disagree with their rows for exactly the
 * reasons Work listings do — a swallowed enqueue, an exhausted retry, a row changed in SQL. One
 * sweep, one cron, one thing to watch.
 *
 * ⚠️ **Each kind gets its own budget rather than sharing one.** A backlog of Works must not
 * starve the posts, and the ceiling is there to stop a first run flooding the queue rather than
 * to bound the total.
 */
async function reconcileCreatorRecords(
	enqueueRecord: Enqueue,
): Promise<{ stale: number; missing: number }> {
	// ── Records that should not exist ────────────────────────────────────
	//
	// The same loose net as above, and loose for the same reason: the real test is TypeScript and
	// this is SQL, so keeping them in step is impossible and the job re-checks properly.
	//
	// 🚨 `is_published = false AND atproto_uri IS NOT NULL` is the shape that matters — a creator
	// who retracted a post, whose `published_at` stayed stamped behind them.
	//
	// ⚠️ A post with no creator is deliberately NOT in the net. Its record is kept rather than
	// removed, so selecting it would enqueue a sync that does nothing, every night, for ever.
	const stalePosts = await db
		.select({ id: posts.id })
		.from(posts)
		.where(
			and(
				isNotNull(posts.atprotoUri),
				isNotNull(posts.creatorId),
				sql`(${posts.isPublished} = false OR ${posts.publishedAt} IS NULL)`,
			),
		)
		.limit(SWEEP_LIMIT);
	for (const row of stalePosts) await enqueueRecord("post", row.id);

	const staleProjects = await db
		.select({ id: projects.id })
		.from(projects)
		.where(and(isNotNull(projects.atprotoUri), eq(projects.isPublished, false)))
		.limit(SWEEP_LIMIT);
	for (const row of staleProjects) await enqueueRecord("project", row.id);

	// ── Records that should exist and do not ─────────────────────────────
	//
	// ⚠️ Joined against `hosted_accounts` for the reason the Works half gives: without it every
	// published post by every creator without a handle would be selected on every sweep, for
	// ever, to be skipped each time. The cost is that a creator who granted permission over an
	// identity hosted ELSEWHERE is not swept — their records are covered by the per-event
	// enqueues only, which is the same gap the Works sweep has and should be closed with it.
	//
	// ⚠️ And skipped outright while a kind's schema is unpublished, since every one of those syncs
	// would plan `lexicon_unpublished` and write nothing. The half above still runs: removal is
	// never withheld.
	const missingPosts = !isLexiconPublished(POST_COLLECTION)
		? []
		: await db
				.select({ id: posts.id })
				.from(posts)
				.innerJoin(hostedAccounts, eq(hostedAccounts.userId, posts.creatorId))
				.where(
					and(isNull(posts.atprotoUri), eq(posts.isPublished, true), isNotNull(posts.publishedAt)),
				)
				.limit(SWEEP_LIMIT);
	for (const row of missingPosts) await enqueueRecord("post", row.id);

	const missingProjects = !isLexiconPublished(PROJECT_COLLECTION)
		? []
		: await db
				.select({ id: projects.id })
				.from(projects)
				.innerJoin(hostedAccounts, eq(hostedAccounts.userId, projects.creatorId))
				.where(and(isNull(projects.atprotoUri), eq(projects.isPublished, true)))
				.limit(SWEEP_LIMIT);
	for (const row of missingProjects) await enqueueRecord("project", row.id);

	return {
		stale: stalePosts.length + staleProjects.length,
		missing: missingPosts.length + missingProjects.length,
	};
}

/**
 * The half of the sweep that catches a reader's interactions up with their subjects.
 *
 * 🚨 **This is what makes a comment's record appear once the thing it is about is listed.** A
 * record names its subject by address, so a comment on a post with no record yet writes nothing,
 * and nothing fans out from the post gaining one — a busy thread would turn a single first sync
 * into a burst against every commenter's server. Instead this finds the rows that could now be
 * written and asks for each, a sweep's worth at a time.
 *
 * ⚠️ **There is no "should not exist" half, and that is the design rather than an omission.** A
 * reader's record comes down only when the reader takes it back — unvoting, unfollowing, editing
 * their words away — and each of those enqueues its own removal as it happens. A hidden comment,
 * or one whose subject has gone, keeps its record; a net for them would find only rows the
 * planner is going to leave alone.
 *
 * ⚠️ **Hosted accounts only, with the same gap the Works half states**, and each kind is skipped
 * while its schema is unpublished.
 */
async function reconcileReaderRecords(enqueueRecord: Enqueue): Promise<{ missing: number }> {
	const subjectHasRecord = (type: SQL, id: SQL) => sql`(
		(${type} = 'work' AND EXISTS (SELECT 1 FROM works s WHERE s.id = ${id} AND s.atproto_uri IS NOT NULL))
		OR (${type} = 'post' AND EXISTS (SELECT 1 FROM posts s WHERE s.id = ${id} AND s.atproto_uri IS NOT NULL))
		OR (${type} = 'comment' AND EXISTS (SELECT 1 FROM comments s WHERE s.id = ${id} AND s.atproto_uri IS NOT NULL))
	)`;

	const missingComments = !isLexiconPublished(COMMENT_COLLECTION)
		? []
		: await db
				.select({ id: comments.id })
				.from(comments)
				.innerJoin(hostedAccounts, eq(hostedAccounts.userId, comments.userId))
				.where(
					and(
						isNull(comments.atprotoUri),
						eq(comments.moderationStatus, "visible"),
						subjectHasRecord(sql`${comments.subjectType}`, sql`${comments.subjectId}`),
					),
				)
				.limit(SWEEP_LIMIT);
	for (const row of missingComments) await enqueueRecord("comment", row.id);

	const missingReviews = !isLexiconPublished(REVIEW_COLLECTION)
		? []
		: await db
				.select({ id: reviews.id })
				.from(reviews)
				.innerJoin(hostedAccounts, eq(hostedAccounts.userId, reviews.userId))
				.innerJoin(works, eq(works.id, reviews.workId))
				.where(
					and(
						isNull(reviews.atprotoUri),
						eq(reviews.moderationStatus, "visible"),
						isNotNull(works.atprotoUri),
					),
				)
				.limit(SWEEP_LIMIT);
	for (const row of missingReviews) await enqueueRecord("review", row.id);

	const missingVotes = !isLexiconPublished(VOTE_COLLECTION)
		? []
		: await db
				.select({ id: votes.id })
				.from(votes)
				.innerJoin(hostedAccounts, eq(hostedAccounts.userId, votes.userId))
				.where(
					and(
						isNull(votes.atprotoUri),
						subjectHasRecord(sql`${votes.subjectType}`, sql`${votes.subjectId}`),
					),
				)
				.limit(SWEEP_LIMIT);
	for (const row of missingVotes) await enqueueRecord("vote", row.id);

	const missingFollows = !isLexiconPublished(FOLLOW_COLLECTION)
		? []
		: await db
				.select({ id: follows.id })
				.from(follows)
				.innerJoin(hostedAccounts, eq(hostedAccounts.userId, follows.followerId))
				.innerJoin(users, eq(users.id, follows.creatorId))
				.where(and(isNull(follows.atprotoUri), isNotNull(users.atprotoDid)))
				.limit(SWEEP_LIMIT);
	for (const row of missingFollows) await enqueueRecord("follow", row.id);

	return {
		missing:
			missingComments.length + missingReviews.length + missingVotes.length + missingFollows.length,
	};
}
