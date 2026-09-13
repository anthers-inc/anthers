// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the nightly reconciling sweep asks to have synced.
 *
 * 🚨 **Its reader half is raw SQL, which nothing else checks.** A misspelled column or a subject
 * type left out of the `EXISTS` clauses typechecks, lints and passes every other suite, and then
 * finds nothing every night — which reads exactly like a network where every record is already
 * in place. So this runs the real queries against the real database and asserts on what they
 * selected, one seeded row per rule.
 *
 * ⚠️ **Assertions are about this suite's own rows only.** The sweep runs over the whole database,
 * so the collected set is filtered to the ids seeded here rather than compared exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { inArray } from "drizzle-orm";
import { reconcileListings } from "../jobs/reconcile-listings.js";
import { setPublishedLexiconsForTesting } from "../services/published-lexicons.js";
import type { RecordSyncKind } from "../services/record-sync.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork, testPublicId } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `rl${Date.now().toString(36)}`;
const DID = `did:plc:${RUN}creator`;

const made = {
	users: [] as number[],
	works: [] as number[],
	comments: [] as number[],
	votes: [] as number[],
	reviews: [] as number[],
	follows: [] as number[],
	posts: [] as number[],
	projects: [] as number[],
};

/** The rows each rule is about, by name, so a failure says which rule broke. */
const ids: Record<string, number> = {};

async function user(tag: string, values: Partial<typeof users.$inferInsert> = {}) {
	const [row] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
			...values,
		})
		.returning();
	made.users.push(row.id);
	return row;
}

beforeAll(async () => {
	const reader = await user("reader");
	await db.insert(hostedAccounts).values({
		did: `did:plc:${RUN}reader`,
		userId: reader.id,
		handle: `${RUN}reader.test`,
		sealedPassword: "not-opened-by-this-suite",
	});
	const plain = await user("plain");
	const creator = await user("creator", { isCreator: true, atprotoDid: DID });

	const listed = await insertWork({ creatorId: creator.id, type: "game" });
	const unlisted = await insertWork({ creatorId: creator.id, type: "game" });
	made.works.push(listed.id, unlisted.id);
	await db
		.update(works)
		.set({ atprotoUri: `at://${DID}/org.anthers.work/${RUN}` })
		.where(inArray(works.id, [listed.id]));

	const comment = async (name: string, values: Partial<typeof comments.$inferInsert>) => {
		const [row] = await db
			.insert(comments)
			.values({
				userId: reader.id,
				subjectType: "work",
				subjectId: listed.id,
				body: "Worth the time.",
				...values,
			})
			.returning();
		made.comments.push(row.id);
		ids[name] = row.id;
	};
	await comment("waitingComment", {});
	await comment("hiddenComment", { moderationStatus: "hidden" });
	await comment("unhostedComment", { userId: plain.id });
	await comment("subjectUnlistedComment", { subjectId: unlisted.id });
	await comment("alreadyWrittenComment", {
		atprotoUri: `at://did:plc:${RUN}reader/org.anthers.comment/x`,
	});

	const [vote] = await db
		.insert(votes)
		.values({ userId: reader.id, subjectType: "work", subjectId: listed.id, direction: "up" })
		.returning();
	const [voteOnUnlisted] = await db
		.insert(votes)
		.values({ userId: reader.id, subjectType: "work", subjectId: unlisted.id, direction: "up" })
		.returning();
	made.votes.push(vote.id, voteOnUnlisted.id);
	ids.waitingVote = vote.id;
	ids.subjectUnlistedVote = voteOnUnlisted.id;

	const [review] = await db
		.insert(reviews)
		.values({ userId: reader.id, workId: listed.id, verdict: "recommended", body: "Yes." })
		.returning();
	made.reviews.push(review.id);
	ids.waitingReview = review.id;

	const [follow] = await db
		.insert(follows)
		.values({ followerId: reader.id, creatorId: creator.id })
		.returning();
	const [followNoIdentity] = await db
		.insert(follows)
		.values({ followerId: reader.id, creatorId: plain.id })
		.returning();
	made.follows.push(follow.id, followNoIdentity.id);
	ids.waitingFollow = follow.id;
	ids.noIdentityFollow = followNoIdentity.id;

	const post = async (name: string, values: Partial<typeof posts.$inferInsert>) => {
		const [row] = await db
			.insert(posts)
			.values({
				creatorId: creator.id,
				publicId: testPublicId(),
				slug: `${RUN}-${name}`,
				isPublished: false,
				publishedAt: new Date(),
				atprotoUri: `at://${DID}/org.anthers.post/${name}`,
				...values,
			})
			.returning();
		made.posts.push(row.id);
		ids[name] = row.id;
	};
	await post("retractedPost", {});
	await post("tombstonedPost", { creatorId: null });

	const [draftProject] = await db
		.insert(projects)
		.values({
			creatorId: creator.id,
			slug: `${RUN}-draft`,
			title: "A Draft",
			isPublished: false,
			atprotoUri: `at://${DID}/org.anthers.project/${RUN}`,
		})
		.returning();
	made.projects.push(draftProject.id);
	ids.draftProject = draftProject.id;
});

afterAll(async () => {
	setPublishedLexiconsForTesting(undefined);
	// Explicit, because none of these cascade from the account: each is `set null` so a closed
	// account leaves its contributions standing, which is exactly what would leave them behind.
	if (made.comments.length) await db.delete(comments).where(inArray(comments.id, made.comments));
	if (made.votes.length) await db.delete(votes).where(inArray(votes.id, made.votes));
	if (made.reviews.length) await db.delete(reviews).where(inArray(reviews.id, made.reviews));
	if (made.follows.length) await db.delete(follows).where(inArray(follows.id, made.follows));
	if (made.posts.length) await db.delete(posts).where(inArray(posts.id, made.posts));
	if (made.projects.length) await db.delete(projects).where(inArray(projects.id, made.projects));
	if (made.works.length) await db.delete(works).where(inArray(works.id, made.works));
	await db.delete(hostedAccounts).where(inArray(hostedAccounts.userId, made.users));
	if (made.users.length) await db.delete(users).where(inArray(users.id, made.users));
});

/** Run the sweep and collect what it asked for, as `kind:id`. */
async function sweep(): Promise<Set<string>> {
	const asked = new Set<string>();
	await reconcileListings({
		enqueueWork: async () => {},
		enqueueRecord: async (kind: RecordSyncKind, id: number) => {
			asked.add(`${kind}:${id}`);
		},
	});
	return asked;
}

describe("with every schema published", () => {
	let asked: Set<string>;
	beforeAll(async () => {
		setPublishedLexiconsForTesting([
			"org.anthers.work",
			"org.anthers.post",
			"org.anthers.project",
			"org.anthers.comment",
			"org.anthers.review",
			"org.anthers.vote",
			"org.anthers.follow",
		]);
		asked = await sweep();
	});

	// 🚨 The rule the reader half exists for: an interaction waiting on its subject's record is
	// found once the subject has one.
	it("finds a reader's comment, vote, review and follow once their subjects can be named", () => {
		expect(asked).toContain(`comment:${ids.waitingComment}`);
		expect(asked).toContain(`vote:${ids.waitingVote}`);
		expect(asked).toContain(`review:${ids.waitingReview}`);
		expect(asked).toContain(`follow:${ids.waitingFollow}`);
	});

	it("leaves alone what the planner would only leave alone", () => {
		// Hidden: its record, if any, stays where its author put it, and none is newly written.
		expect(asked).not.toContain(`comment:${ids.hiddenComment}`);
		// Subject not yet listed: nothing to name.
		expect(asked).not.toContain(`comment:${ids.subjectUnlistedComment}`);
		expect(asked).not.toContain(`vote:${ids.subjectUnlistedVote}`);
		// Followed account has no identity: nothing to name either.
		expect(asked).not.toContain(`follow:${ids.noIdentityFollow}`);
		// Already written: not missing.
		expect(asked).not.toContain(`comment:${ids.alreadyWrittenComment}`);
		// Not hosted here: the stated gap, asserted so that closing it is a deliberate change.
		expect(asked).not.toContain(`comment:${ids.unhostedComment}`);
	});

	it("finds a retracted post and a draft project that still have records", () => {
		expect(asked).toContain(`post:${ids.retractedPost}`);
		expect(asked).toContain(`project:${ids.draftProject}`);
	});

	// ⚠️ A closed account's records are kept, so selecting its posts would enqueue a sync that does
	// nothing, every night, for ever.
	it("does not keep asking about a closed account's post", () => {
		expect(asked).not.toContain(`post:${ids.tombstonedPost}`);
	});
});

describe("with the real set of published schemas", () => {
	let asked: Set<string>;
	beforeAll(async () => {
		setPublishedLexiconsForTesting(undefined);
		asked = await sweep();
	});

	// Every one of these would plan `lexicon_unpublished`, so asking is pure cost.
	it("asks for nothing to be written under a draft schema", () => {
		for (const name of ["waitingComment", "waitingVote", "waitingReview", "waitingFollow"]) {
			const kind = name.replace("waiting", "").toLowerCase();
			expect(asked).not.toContain(`${kind}:${ids[name]}`);
		}
	});

	// 🚨 Removal is never withheld, so the half that finds records to take down still runs.
	it("still finds records that should come down", () => {
		expect(asked).toContain(`post:${ids.retractedPost}`);
		expect(asked).toContain(`project:${ids.draftProject}`);
	});
});
