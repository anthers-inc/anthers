// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation — the one place that files a report, hides a subject, restores it,
 * and assembles the operator's queue.
 *
 * Routes here are deliberately thin: the report endpoint is user-facing and the
 * hide/restore endpoints are admin-gated, so the logic lives in one module both
 * can call rather than being duplicated on either side of the gate. That also
 * makes the whole feature testable without a browser, the same way
 * `resolveAccessSync` is.
 *
 * The invariant this module exists to hold: **hiding is an UPDATE, never a
 * DELETE.** Nothing here removes a comment or a rating row. `hideSubject` flips
 * `moderation_status` and appends to `moderation_actions`; `restoreSubject`
 * flips it back and appends again. The content, its author, and its timestamps
 * are all still there afterwards — which is why an appeal, a creator-side tool,
 * or a labeler that disagrees with us can be built later as a feature instead of
 * a migration. If you are adding a moderation action and reach for `db.delete`,
 * that is the bug.
 *
 * Subjects are polymorphic (`comment` | `rating`), so `SUBJECTS` is the single
 * table mapping a subject type to its Drizzle table. Adding a third moderatable
 * kind means one entry there, not a new branch in every query.
 */

import { db } from "@anthers/db/client";
import {
	comments,
	moderationActions,
	moderationReports,
	posts,
	ratings,
	users,
	works,
} from "@anthers/db/schema";
import {
	isModeratableContent,
	MODERATION_NOTE_MAX,
	type ModerationActionType,
	type ModerationActorRole,
	type ModerationSubjectType,
	REPORT_DETAILS_MAX,
} from "@anthers/shared/moderation";
import { and, count, desc, eq, exists, inArray, max, or, sql } from "drizzle-orm";

/**
 * Subject type → the table it lives in. The only place the mapping is written down.
 *
 * `user` is deliberately absent. The two entries here are *content* tables sharing a
 * shape — an `id`, an author, and a `moderation_status` — and everything keyed off
 * this map (hide, restore, the browse filters) assumes all three columns. A `users`
 * row has none of them in that sense: it has no author but is one, and it carries no
 * moderation status because suspending an account is not built. Adding it here to
 * make the map look complete is what would produce a hide path that half-works.
 */
const CONTENT_SUBJECTS = {
	comment: comments,
	rating: ratings,
} as const;

type ContentSubjectType = keyof typeof CONTENT_SUBJECTS;

export interface ModerationSubjectRow {
	id: number;
	/**
	 * The author, for content. For a `user` subject this is the subject itself.
	 *
	 * Null on a **tombstoned** row — the author deleted their account and the comment
	 * or review stayed so the thread around it still reads. Moderation still applies to
	 * it: the words are still there, and hiding them is still the operator's call.
	 */
	userId: number | null;
	/** Always `"visible"` for a `user` subject — accounts carry no moderation status. */
	moderationStatus: string;
}

/**
 * Load a subject row, or null if it doesn't exist. Every write path resolves first.
 *
 * The `user` branch exists so a person report can be validated the same way a comment
 * report is — a report naming an account that isn't there would sit in the queue with
 * nothing to render, exactly the orphan case `subjectStillExists` cleans up after.
 */
export async function findSubject(
	subjectType: ModerationSubjectType,
	subjectId: number,
): Promise<ModerationSubjectRow | null> {
	if (subjectType === "user") {
		const [row] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, subjectId))
			.limit(1);
		return row ? { id: row.id, userId: row.id, moderationStatus: "visible" } : null;
	}

	const table = CONTENT_SUBJECTS[subjectType as ContentSubjectType];
	const [row] = await db
		.select({
			id: table.id,
			userId: table.userId,
			moderationStatus: table.moderationStatus,
		})
		.from(table)
		.where(eq(table.id, subjectId))
		.limit(1);
	return row ?? null;
}

/**
 * File a report. Idempotent per (reporter, subject): a second report of the same
 * item by the same person updates their reason rather than adding a queue entry,
 * so one user can't inflate the count the queue sorts by.
 *
 * Self-reporting is allowed on purpose FOR CONTENT. Neither a comment nor a rating
 * can be deleted by anyone today — not even its author — so a report is currently the
 * only way an author can ask for their own words to come down. It is refused for a
 * `user` subject, where it means nothing: the route rejects that case before getting
 * here, since "report yourself" has no reading that helps anyone.
 */
export async function fileReport(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	reporterId: number;
	reason: string;
	details?: string;
}): Promise<{ reportId: number }> {
	const details = (input.details ?? "").trim().slice(0, REPORT_DETAILS_MAX);
	const [row] = await db
		.insert(moderationReports)
		.values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			reporterId: input.reporterId,
			reason: input.reason,
			details,
		})
		.onConflictDoUpdate({
			target: [
				moderationReports.reporterId,
				moderationReports.subjectType,
				moderationReports.subjectId,
			],
			// Re-reporting reopens: an operator dismissed the earlier reason, not
			// every future one, and the reporter is telling us something changed.
			set: { reason: input.reason, details, status: "open", resolvedAt: null, resolvedBy: null },
		})
		.returning({ id: moderationReports.id });
	return { reportId: row.id };
}

/**
 * Hide a subject and record why. Returns null if the subject doesn't exist, and
 * `"not_moderatable"` for a subject type that cannot be hidden at all.
 *
 * That second outcome is what a **person** report gets. Hiding an account is
 * suspension, and suspension has to answer what becomes of the person's Works, their
 * buyers' purchases, the Seeds pointed at them and any payout mid-flight — none of
 * which is decided. So a person report reaches the queue and an operator dismisses it
 * or acts out of band; the account action is stated as missing rather than stubbed
 * into something that half-works.
 *
 * Both writes are one transaction: a hidden row with no record of who hid it is
 * exactly the state this feature exists to prevent. Open reports against the
 * subject are resolved in the same transaction — acting on the content is the
 * answer to the report, and leaving them open would make the queue re-serve work
 * that's already done.
 */
export async function hideSubject(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	actorId: number;
	actorRole?: ModerationActorRole;
	reason: string;
	note?: string;
}): Promise<{ status: "hidden" } | "not_moderatable" | null> {
	if (!isModeratableContent(input.subjectType)) return "not_moderatable";

	const subject = await findSubject(input.subjectType, input.subjectId);
	if (!subject) return null;

	const table = CONTENT_SUBJECTS[input.subjectType as ContentSubjectType];
	const note = (input.note ?? "").trim().slice(0, MODERATION_NOTE_MAX);

	await db.transaction(async (tx) => {
		await tx.update(table).set({ moderationStatus: "hidden" }).where(eq(table.id, input.subjectId));

		await tx.insert(moderationActions).values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			action: "hide" satisfies ModerationActionType,
			actorId: input.actorId,
			actorRole: input.actorRole ?? "operator",
			reason: input.reason,
			note,
		});

		await tx
			.update(moderationReports)
			.set({ status: "resolved", resolvedAt: new Date(), resolvedBy: input.actorId })
			.where(
				and(
					eq(moderationReports.subjectType, input.subjectType),
					eq(moderationReports.subjectId, input.subjectId),
					eq(moderationReports.status, "open"),
				),
			);
	});

	return { status: "hidden" };
}

/**
 * Put a hidden subject back. A reversal is a NEW `restore` row, never an edit or
 * deletion of the `hide` row that preceded it — the log reads as the sequence of
 * decisions actually taken, including the ones we changed our minds about.
 *
 * Restoring does NOT reopen the reports the hide resolved. The operator has seen
 * them and decided twice; re-queuing the same item would be the queue arguing
 * with the person reading it.
 */
export async function restoreSubject(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	actorId: number;
	actorRole?: ModerationActorRole;
	note?: string;
}): Promise<{ status: "visible" } | "not_moderatable" | null> {
	// Symmetric with `hideSubject`: nothing that can't be hidden can be restored, and
	// saying so here means the pair can't drift into a state where one accepts a
	// subject type the other rejects.
	if (!isModeratableContent(input.subjectType)) return "not_moderatable";

	const subject = await findSubject(input.subjectType, input.subjectId);
	if (!subject) return null;

	const table = CONTENT_SUBJECTS[input.subjectType as ContentSubjectType];
	const note = (input.note ?? "").trim().slice(0, MODERATION_NOTE_MAX);

	await db.transaction(async (tx) => {
		await tx
			.update(table)
			.set({ moderationStatus: "visible" })
			.where(eq(table.id, input.subjectId));

		await tx.insert(moderationActions).values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			action: "restore" satisfies ModerationActionType,
			actorId: input.actorId,
			actorRole: input.actorRole ?? "operator",
			reason: "",
			note,
		});
	});

	return { status: "visible" };
}

/** Dismiss a subject's open reports without touching the content. */
export async function dismissReports(input: {
	subjectType: ModerationSubjectType;
	subjectId: number;
	actorId: number;
}): Promise<{ dismissed: number }> {
	const dismissed = await db
		.update(moderationReports)
		.set({ status: "dismissed", resolvedAt: new Date(), resolvedBy: input.actorId })
		.where(
			and(
				eq(moderationReports.subjectType, input.subjectType),
				eq(moderationReports.subjectId, input.subjectId),
				eq(moderationReports.status, "open"),
			),
		)
		.returning({ id: moderationReports.id });
	return { dismissed: dismissed.length };
}

// ── The operator queue ──────────────────────────────────────────────────────

/** What the console renders for one moderatable item. */
export interface QueueItem {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** The comment text, or a review's score and words — whatever the operator has to judge. */
	excerpt: string;
	score: number | null;
	moderationStatus: string;
	createdAt: string;
	author: { id: number; username: string } | null;
	/**
	 * Where the item lives, so an operator can go read it in context.
	 *
	 * `kind` exists because that is no longer always a post: comments hang off a Post or a
	 * Work, and reviews only off a Work. Calling this `post` and quietly filling it with a
	 * Work's slug would send the operator to a 404. A reported *person* carries a
	 * `profile` context pointing at their own profile — the report is about a pattern, so
	 * the place to go look is everything they've said.
	 */
	context: { kind: "post" | "work" | "profile"; slug: string; title: string } | null;
	/**
	 * Whether an operator can hide this from the console at all. False for a person —
	 * see `hideSubject`. The console needs to know before it renders a button that
	 * would only ever return 400.
	 */
	moderatable: boolean;
	openReports: number;
	totalReports: number;
	reasons: string[];
	details: string[];
	lastAction: {
		action: string;
		reason: string;
		note: string;
		createdAt: string;
		actor: string | null;
	} | null;
}

export type QueueFilter = "reported" | "comments" | "ratings" | "people" | "hidden";

const QUEUE_LIMIT = 100;

/**
 * Assemble the operator's list.
 *
 * `reported` — the queue proper: anything with an open report, most-reported first.
 * `comments` / `ratings` — recent activity, so an operator can act on something
 *   nobody reported. This mattered more than it looks when a rating was a bare
 *   1–5 score: nothing rendered it, so nobody could *see* one to report it, and
 *   browse was the only way it was reachable at all. Reviews now carry text and
 *   a report control, so the queue is fed properly — browse stays because acting
 *   before anyone complains is still worth being able to do.
 * `people` — reported accounts only. Unlike the two above, this is NOT a browse over
 *   recent rows: "every account, newest first" is a user directory, not a moderation
 *   surface, and reading one under a moderation header invites acting on someone
 *   nobody complained about.
 * `hidden` — what we've already taken down, which is how a restore gets found. It
 *   cannot contain a person: an account has no hidden state to be in.
 */
export async function loadQueue(filter: QueueFilter): Promise<QueueItem[]> {
	const subjectTypes: ModerationSubjectType[] =
		filter === "comments" ? ["comment"] : filter === "ratings" ? ["rating"] : ["comment", "rating"];

	// 1. Pick the (type, id) pairs this filter is about.
	let keys: { subjectType: ModerationSubjectType; subjectId: number }[];

	if (filter === "reported") {
		// Orphans are excluded HERE, in SQL, rather than after hydration below.
		//
		// Reports are polymorphic with no FK on the subject, so deleting a post cascades
		// its comments away and strands their reports. Hydration already drops those — but
		// it runs *after* this `LIMIT`, so a stranded report still consumed a slot and then
		// disappeared. With enough of them the queue returns almost nothing while
		// `summary.openReports` insists there is work, and *which* live items survive comes
		// down to how Postgres happens to break ties among equal report counts. Observed on
		// a dev database carrying 114 reported subjects of which 113 were orphaned: the one
		// real entry made the page only sometimes, which is what made `moderation.test.ts`
		// flaky rather than any timing.
		//
		// Ordering also gains a tie-break. Report counts are mostly 1, so `count DESC` alone
		// left the order — and therefore the contents of the page — unspecified. Newest
		// first among equals: an operator refreshing the queue should not see it reshuffle.
		// `subjectStillExists` is the predicate `moderationSummary` already uses, reused
		// rather than restated so the queue and its own headline count cannot disagree.
		const rows = await db
			.select({
				subjectType: moderationReports.subjectType,
				subjectId: moderationReports.subjectId,
				n: count(moderationReports.id),
				newest: max(moderationReports.createdAt),
			})
			.from(moderationReports)
			.where(and(eq(moderationReports.status, "open"), subjectStillExists))
			.groupBy(moderationReports.subjectType, moderationReports.subjectId)
			.orderBy(desc(count(moderationReports.id)), desc(max(moderationReports.createdAt)))
			.limit(QUEUE_LIMIT);
		keys = rows.map((r) => ({
			subjectType: r.subjectType as ModerationSubjectType,
			subjectId: r.subjectId,
		}));
	} else if (filter === "people") {
		// Reported accounts only — see the note on the filter. Same orphan predicate and
		// same tie-break as `reported`, restricted to the one subject type.
		const rows = await db
			.select({
				subjectId: moderationReports.subjectId,
				n: count(moderationReports.id),
				newest: max(moderationReports.createdAt),
			})
			.from(moderationReports)
			.where(
				and(
					eq(moderationReports.status, "open"),
					eq(moderationReports.subjectType, "user"),
					subjectStillExists,
				),
			)
			.groupBy(moderationReports.subjectId)
			.orderBy(desc(count(moderationReports.id)), desc(max(moderationReports.createdAt)))
			.limit(QUEUE_LIMIT);
		keys = rows.map((r) => ({ subjectType: "user" as const, subjectId: r.subjectId }));
	} else {
		keys = [];
		for (const subjectType of subjectTypes as ContentSubjectType[]) {
			const table = CONTENT_SUBJECTS[subjectType];
			const rows = await db
				.select({ id: table.id })
				.from(table)
				.where(filter === "hidden" ? eq(table.moderationStatus, "hidden") : undefined)
				.orderBy(desc(table.createdAt))
				.limit(QUEUE_LIMIT);
			keys.push(...rows.map((r) => ({ subjectType, subjectId: r.id })));
		}
	}

	if (keys.length === 0) return [];

	// 2. Hydrate each subject type in one query, then stitch. The branches differ only
	//    in the column carrying the thing an operator has to judge — a comment's text,
	//    a rating's score, a person's profile — so the row they produce is shared.
	const items = new Map<string, QueueItem>();
	const key = (t: string, id: number) => `${t}:${id}`;

	const commentIds = keys.filter((k) => k.subjectType === "comment").map((k) => k.subjectId);
	const ratingIds = keys.filter((k) => k.subjectType === "rating").map((k) => k.subjectId);
	const userIds = keys.filter((k) => k.subjectType === "user").map((k) => k.subjectId);

	type QueueContext = QueueItem["context"];

	/**
	 * Resolve `(kind, id)` pairs to the slug and title an operator can navigate to.
	 *
	 * Batched by kind rather than joined per row, because a comment's subject is
	 * polymorphic — there is no single table to LEFT JOIN against, which is the price the
	 * moderation tables already pay for their own polymorphism.
	 */
	async function loadContexts(
		refs: { kind: "post" | "work"; id: number }[],
	): Promise<Map<string, QueueContext>> {
		const out = new Map<string, QueueContext>();
		const postIds = [...new Set(refs.filter((r) => r.kind === "post").map((r) => r.id))];
		const workIds = [...new Set(refs.filter((r) => r.kind === "work").map((r) => r.id))];
		if (postIds.length > 0) {
			const rows = await db
				.select({ id: posts.id, slug: posts.slug, title: posts.title })
				.from(posts)
				.where(inArray(posts.id, postIds));
			for (const r of rows) {
				out.set(`post:${r.id}`, { kind: "post", slug: r.slug, title: r.title ?? "" });
			}
		}
		if (workIds.length > 0) {
			const rows = await db
				.select({ id: works.id, slug: works.slug, title: works.title })
				.from(works)
				.where(inArray(works.id, workIds));
			for (const r of rows) {
				out.set(`work:${r.id}`, { kind: "work", slug: r.slug, title: r.title ?? "" });
			}
		}
		return out;
	}

	function base(
		subjectType: ModerationSubjectType,
		r: {
			id: number;
			userId: number | null;
			username: string | null;
			moderationStatus: string;
			createdAt: Date;
		},
		context: QueueContext,
	): Omit<QueueItem, "excerpt" | "score"> {
		return {
			subjectType,
			subjectId: r.id,
			moderationStatus: r.moderationStatus,
			createdAt: r.createdAt.toISOString(),
			author: r.username && r.userId != null ? { id: r.userId, username: r.username } : null,
			context,
			moderatable: isModeratableContent(subjectType),
			openReports: 0,
			totalReports: 0,
			reasons: [],
			details: [],
			lastAction: null,
		};
	}

	if (commentIds.length > 0) {
		const rows = await db
			.select({
				id: comments.id,
				userId: comments.userId,
				username: users.username,
				subjectType: comments.subjectType,
				subjectId: comments.subjectId,
				moderationStatus: comments.moderationStatus,
				createdAt: comments.createdAt,
				body: comments.body,
			})
			.from(comments)
			.leftJoin(users, eq(comments.userId, users.id))
			.where(inArray(comments.id, commentIds));
		const contexts = await loadContexts(
			rows.map((r) => ({ kind: r.subjectType === "work" ? "work" : "post", id: r.subjectId })),
		);
		for (const r of rows) {
			items.set(key("comment", r.id), {
				...base("comment", r, contexts.get(`${r.subjectType}:${r.subjectId}`) ?? null),
				excerpt: r.body,
				score: null,
			});
		}
	}

	if (ratingIds.length > 0) {
		const rows = await db
			.select({
				id: ratings.id,
				userId: ratings.userId,
				username: users.username,
				workId: ratings.workId,
				moderationStatus: ratings.moderationStatus,
				createdAt: ratings.createdAt,
				score: ratings.score,
				body: ratings.body,
			})
			.from(ratings)
			.leftJoin(users, eq(ratings.userId, users.id))
			.where(inArray(ratings.id, ratingIds));
		const contexts = await loadContexts(
			rows
				.filter((r) => r.workId != null)
				.map((r) => ({ kind: "work" as const, id: r.workId as number })),
		);
		for (const r of rows) {
			items.set(key("rating", r.id), {
				...base("rating", r, r.workId != null ? (contexts.get(`work:${r.workId}`) ?? null) : null),
				// Score first so the operator sees the verdict, then the words that
				// justify it — the words are the part there's actually a call to make on.
				// `body` is empty on rows predating the write-time text requirement.
				excerpt: r.body ? `${r.score}/5 — ${r.body}` : `${r.score}/5`,
				score: r.score,
			});
		}
	}

	// A reported person. The subject IS the author here, which is why `base` takes the
	// user row twice — a person's report is about them, not about something of theirs.
	//
	// The excerpt is the profile the operator would land on: display name and bio, the
	// only text an account carries. It is deliberately thin, and it is meant to be: a
	// person report is judged from the reporter's `details` plus the profile it points
	// at, which is exactly why `details` is required for this subject type.
	if (userIds.length > 0) {
		const rows = await db
			.select({
				id: users.id,
				username: users.username,
				displayName: users.displayName,
				bio: users.bio,
				createdAt: users.createdAt,
			})
			.from(users)
			.where(inArray(users.id, userIds));
		for (const r of rows) {
			const label = r.displayName ? `${r.displayName} (@${r.username})` : `@${r.username}`;
			items.set(key("user", r.id), {
				...base(
					"user",
					{
						id: r.id,
						userId: r.id,
						username: r.username,
						moderationStatus: "visible",
						createdAt: r.createdAt,
					},
					{ kind: "profile", slug: r.username, title: label },
				),
				excerpt: r.bio ? `${label} — ${r.bio}` : label,
				score: null,
			});
		}
	}

	if (items.size === 0) return [];

	// 3. Attach report counts + reasons for everything on the list (not just the
	//    reported filter — an operator browsing recent comments should still see
	//    that one of them has three standing reports).
	//
	//    Both this query and the next filter on subject id ALONE, which over-fetches:
	//    comment #5 and rating #5 are different subjects with the same id. The
	//    `items.get(key(type, id))` lookup is what disambiguates them — a row whose
	//    (type, id) pair isn't on the list finds no item and is dropped. Filtering on
	//    the pairs in SQL would mean a row-constructor IN clause for a handful of
	//    surplus rows on a page-sized list.
	const reportRows = await db
		.select({
			subjectType: moderationReports.subjectType,
			subjectId: moderationReports.subjectId,
			status: moderationReports.status,
			reason: moderationReports.reason,
			details: moderationReports.details,
		})
		.from(moderationReports)
		.where(
			inArray(
				moderationReports.subjectId,
				[...items.values()].map((i) => i.subjectId),
			),
		);

	for (const r of reportRows) {
		const item = items.get(key(r.subjectType, r.subjectId));
		if (!item) continue;
		item.totalReports += 1;
		if (r.status === "open") item.openReports += 1;
		if (!item.reasons.includes(r.reason)) item.reasons.push(r.reason);
		if (r.details) item.details.push(r.details);
	}

	// 4. Attach the most recent decision, so a hidden item shows who hid it and why.
	const actionRows = await db
		.select({
			subjectType: moderationActions.subjectType,
			subjectId: moderationActions.subjectId,
			action: moderationActions.action,
			reason: moderationActions.reason,
			note: moderationActions.note,
			createdAt: moderationActions.createdAt,
			actor: users.username,
		})
		.from(moderationActions)
		.leftJoin(users, eq(moderationActions.actorId, users.id))
		.where(
			inArray(
				moderationActions.subjectId,
				[...items.values()].map((i) => i.subjectId),
			),
		)
		.orderBy(desc(moderationActions.createdAt));

	for (const a of actionRows) {
		const item = items.get(key(a.subjectType, a.subjectId));
		// Rows arrive newest-first, so the first one we see for a subject is the latest.
		if (!item || item.lastAction) continue;
		item.lastAction = {
			action: a.action,
			reason: a.reason,
			note: a.note,
			createdAt: a.createdAt.toISOString(),
			actor: a.actor,
		};
	}

	const list = [...items.values()];
	if (filter === "reported") {
		list.sort((a, b) => b.openReports - a.openReports || b.createdAt.localeCompare(a.createdAt));
	} else {
		list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	return list.slice(0, QUEUE_LIMIT);
}

/**
 * A report whose subject still exists.
 *
 * Reports are polymorphic, so there is no foreign key holding them to their
 * subject, and every path that removes content leaves reports behind: deleting a
 * post cascades its comments and ratings away, deleting an account cascades that
 * user's, and the gauntlet fixture clears comments between runs. Those orphans
 * can never appear in the queue — `loadQueue` hydrates from the content tables,
 * so a report naming a row that isn't there finds nothing to render and is
 * dropped.
 *
 * The counts have to agree with that, or the console shows "3 open reports" over
 * an empty queue and the operator has no way to clear it. Filtering on the read
 * side rather than deleting reports at each cascade point is the version that
 * can't be forgotten by the next thing that deletes content — and it keeps the
 * reports themselves, which are records, rather than quietly erasing them.
 *
 * The `user` branch matters more than the other two, not less: `users` is the row
 * everything else cascades FROM, so a deleted account strands not only its own
 * reports but every report about it. Both `users` FKs on the report are `set null`
 * for the actor and reporter side — deliberately, so the record outlives the account
 * — and the *subject* side has no FK at all, so this predicate is the only thing
 * standing between a deleted account and a permanently unclearable queue entry.
 */
const subjectStillExists = or(
	and(
		eq(moderationReports.subjectType, "comment"),
		exists(
			db.select({ one: sql`1` }).from(comments).where(eq(comments.id, moderationReports.subjectId)),
		),
	),
	and(
		eq(moderationReports.subjectType, "rating"),
		exists(
			db.select({ one: sql`1` }).from(ratings).where(eq(ratings.id, moderationReports.subjectId)),
		),
	),
	and(
		eq(moderationReports.subjectType, "user"),
		exists(db.select({ one: sql`1` }).from(users).where(eq(users.id, moderationReports.subjectId))),
	),
);

/**
 * Headline counts for the console: open reports, and what's currently hidden.
 *
 * `reportedPeople` is counted separately from `openReports` rather than being
 * inferred from it, because it is the one bucket with no in-app remedy — an operator
 * seeing it needs to know it is there precisely because clearing it means acting
 * somewhere other than this console.
 */
export async function moderationSummary(): Promise<{
	openReports: number;
	reportedSubjects: number;
	reportedPeople: number;
	hiddenComments: number;
	hiddenRatings: number;
}> {
	const [open] = await db
		.select({
			reports: count(moderationReports.id),
			subjects: sql<number>`count(DISTINCT (${moderationReports.subjectType}, ${moderationReports.subjectId}))::int`,
			people: sql<number>`count(DISTINCT ${moderationReports.subjectId}) FILTER (WHERE ${moderationReports.subjectType} = 'user')::int`,
		})
		.from(moderationReports)
		.where(and(eq(moderationReports.status, "open"), subjectStillExists));

	const [hiddenC] = await db
		.select({ n: count(comments.id) })
		.from(comments)
		.where(eq(comments.moderationStatus, "hidden"));
	const [hiddenR] = await db
		.select({ n: count(ratings.id) })
		.from(ratings)
		.where(eq(ratings.moderationStatus, "hidden"));

	return {
		openReports: Number(open?.reports ?? 0),
		reportedSubjects: Number(open?.subjects ?? 0),
		reportedPeople: Number(open?.people ?? 0),
		hiddenComments: Number(hiddenC?.n ?? 0),
		hiddenRatings: Number(hiddenR?.n ?? 0),
	};
}
