// SPDX-License-Identifier: Apache-2.0
/**
 * A reader's comments, votes, reviews and follows, written into a repository Anthers hosts,
 * against a real server.
 *
 * `atproto-record-plan.test.ts` proves the decisions and `record-sync.test.ts` proves the
 * ordering, both without a network. This proves what only a server can: that a reader's comment
 * ends up in **the reader's** repository naming the post's record by its real address, that a
 * hidden comment's record is still readable afterwards, and that withdrawing a vote takes the
 * record off the network rather than merely forgetting where it was.
 *
 * 🚨 **Hiding is the case worth reading twice.** The planner used to delete a hidden comment's
 * record, and its suite asserted that as the point. Against a fake repository the difference
 * between the two rulings is one word in a plan object; here it is whether somebody's words are
 * still in their own repository after a moderator acted on Anthers.
 *
 * 🚨 **It refuses to run unless `ATPROTO_TEST_PDS` names a server**, for the reason every suite
 * that writes records gives: a record is world-readable the moment it lands.
 *
 *   make pds-up && make pds-test
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import {
	comments,
	follows,
	hostedAccounts,
	posts,
	reviews,
	users,
	votes,
	works,
} from "@anthers/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import {
	COMMENT_COLLECTION,
	FOLLOW_COLLECTION,
	REVIEW_COLLECTION,
	VOTE_COLLECTION,
} from "../services/atproto-record-plan.js";
import { removeAtprotoRecord } from "../services/atproto-record-removal.js";
import { syncPostRecord } from "../services/creator-record-listing.js";
import { setPublishedLexiconsForTesting } from "../services/published-lexicons.js";
import {
	syncCommentRecord,
	syncFollowRecord,
	syncReviewRecord,
	syncVoteRecord,
} from "../services/reader-record-listing.js";
import { syncWorkListing } from "../services/work-listing.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork, testPublicId } from "./work-fixtures";

const SERVICE = process.env.ATPROTO_TEST_PDS;

purgeAccountsCreatedHere();

const RUN = `rr${Date.now().toString(36)}`;
const STAMP = Date.now().toString(36);

const before = { url: process.env.HOSTED_PDS_URL, key: process.env.HOSTED_ACCOUNT_KEY };

const made = { comments: [] as number[], votes: [] as number[], reviews: [] as number[] };

beforeAll(() => {
	if (!SERVICE) return;
	process.env.HOSTED_PDS_URL = SERVICE;
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
	// ⚠️ None of these schemas is published beyond the Work's, so the gate would rightly write
	// nothing. A throwaway server is the one place a draft schema's records may land.
	setPublishedLexiconsForTesting([
		"org.anthers.work",
		"org.anthers.post",
		COMMENT_COLLECTION,
		REVIEW_COLLECTION,
		VOTE_COLLECTION,
		FOLLOW_COLLECTION,
	]);
});

afterAll(async () => {
	if (before.url === undefined) delete process.env.HOSTED_PDS_URL;
	else process.env.HOSTED_PDS_URL = before.url;
	if (before.key === undefined) delete process.env.HOSTED_ACCOUNT_KEY;
	else process.env.HOSTED_ACCOUNT_KEY = before.key;
	setPublishedLexiconsForTesting(undefined);
	if (made.comments.length) await db.delete(comments).where(inArray(comments.id, made.comments));
	if (made.votes.length) await db.delete(votes).where(inArray(votes.id, made.votes));
	if (made.reviews.length) await db.delete(reviews).where(inArray(reviews.id, made.reviews));
	await db.delete(posts).where(like(posts.slug, `${RUN}%`));
	await db.delete(works).where(like(works.slug, `${RUN}%`));
	await db.delete(hostedAccounts).where(like(hostedAccounts.handle, `%${STAMP}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

interface Account {
	id: number;
	did: string;
}

/** A real account on the server, sealed into `hosted_accounts` the way signup does it. */
async function hostedAccount(tag: string): Promise<Account> {
	const handle = `${tag}-${STAMP}.test`;
	const password = `probe-${crypto.randomUUID()}`;
	const res = await fetch(`${SERVICE}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle, email: `${handle}@example.invalid`, password }),
	});
	expect(res.ok).toBe(true);
	const { did } = (await res.json()) as { did: string };

	const [user] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
			isCreator: tag === "creator",
			atprotoDid: did,
			atprotoHandle: handle,
		})
		.returning();
	const { seal } = await import("../services/secret-box.js");
	await db
		.insert(hostedAccounts)
		.values({ did, userId: user.id, handle, sealedPassword: seal(password) });
	return { id: user.id, did };
}

/** The record at an address, or null once it has gone. */
async function readRecord(uri: string | null): Promise<Record<string, unknown> | null> {
	if (!uri) return null;
	const [, , repo, collection, rkey] = uri.split("/");
	const res = await fetch(
		`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`,
	);
	if (!res.ok) return null;
	return ((await res.json()) as { value: Record<string, unknown> }).value;
}

let creator: Account;
let reader: Account;
let postId = 0;
let postUri = "";

describe.skipIf(!SERVICE)("a reader's records in a repository Anthers hosts", () => {
	it("sets up a creator and a reader, each with an identity on the server", async () => {
		creator = await hostedAccount("creator");
		reader = await hostedAccount("reader");
	}, 60_000);

	// 🚨 The compounding condition, end to end. A comment on a post with no record has nothing to
	// name; once the post is listed, the same sync writes it.
	it("waits for the post to have a record, then writes the comment into the READER's repository", async () => {
		const [post] = await db
			.insert(posts)
			.values({
				creatorId: creator.id,
				publicId: testPublicId(),
				slug: `${RUN}-post`,
				isPublished: true,
				publishedAt: new Date(),
			})
			.returning();
		postId = post.id;

		const [comment] = await db
			.insert(comments)
			.values({
				userId: reader.id,
				subjectType: "post",
				subjectId: postId,
				body: "Worth the time.",
			})
			.returning();
		made.comments.push(comment.id);

		expect(await syncCommentRecord(comment.id)).toMatchObject({
			status: "synced",
			plan: { action: "none", reason: "subject_unpublished" },
		});

		expect((await syncPostRecord(postId)).status).toBe("synced");
		const [listed] = await db
			.select({ uri: posts.atprotoUri })
			.from(posts)
			.where(eq(posts.id, postId));
		postUri = listed.uri as string;

		expect(await syncCommentRecord(comment.id)).toMatchObject({
			status: "synced",
			plan: { action: "create" },
		});
		const [row] = await db
			.select({ uri: comments.atprotoUri })
			.from(comments)
			.where(eq(comments.id, comment.id));

		// In the reader's repository, not the creator's and not Anthers'.
		expect(row.uri).toStartWith(`at://${reader.did}/${COMMENT_COLLECTION}/`);
		const record = await readRecord(row.uri);
		expect(record?.subject).toEqual({ uri: postUri });
		expect(record?.text).toBe("Worth the time.");
	}, 60_000);

	// 🚨 The ruling the planner used to get backwards.
	it("leaves a hidden comment's record exactly where its author put it", async () => {
		const id = made.comments[0];
		const [was] = await db
			.select({ uri: comments.atprotoUri })
			.from(comments)
			.where(eq(comments.id, id));

		await db.update(comments).set({ moderationStatus: "hidden" }).where(eq(comments.id, id));
		expect(await syncCommentRecord(id)).toMatchObject({
			status: "synced",
			plan: { action: "keep", reason: "hidden" },
		});

		const [after] = await db
			.select({ uri: comments.atprotoUri })
			.from(comments)
			.where(eq(comments.id, id));
		expect(after.uri).toBe(was.uri);
		expect(await readRecord(was.uri)).not.toBeNull();
	}, 60_000);

	it("writes a vote, flips it in place, and takes it down when the vote is withdrawn", async () => {
		const [vote] = await db
			.insert(votes)
			.values({ userId: reader.id, subjectType: "post", subjectId: postId, direction: "up" })
			.returning();
		made.votes.push(vote.id);

		await syncVoteRecord(vote.id);
		const [cast] = await db
			.select({ uri: votes.atprotoUri })
			.from(votes)
			.where(eq(votes.id, vote.id));
		expect((await readRecord(cast.uri))?.direction).toBe("up");

		await db.update(votes).set({ direction: "down" }).where(eq(votes.id, vote.id));
		await syncVoteRecord(vote.id);
		const [flipped] = await db
			.select({ uri: votes.atprotoUri })
			.from(votes)
			.where(eq(votes.id, vote.id));
		// ⚠️ The same address: a flip that added a second record would let both count.
		expect(flipped.uri).toBe(cast.uri);
		expect((await readRecord(flipped.uri))?.direction).toBe("down");

		// What `DELETE /votes` does: the row goes, and the address it held travels with the removal.
		await db.delete(votes).where(eq(votes.id, vote.id));
		expect(
			await removeAtprotoRecord({
				ownerId: reader.id,
				collection: VOTE_COLLECTION,
				uri: cast.uri as string,
			}),
		).toEqual({ status: "removed" });
		expect(await readRecord(cast.uri)).toBeNull();
	}, 60_000);

	it("writes a review of a listed Work, with its verdict and its words", async () => {
		const work = await insertWork({ creatorId: creator.id, type: "game", slug: `${RUN}-work` });
		expect((await syncWorkListing(work.id)).status).toBe("synced");

		const [review] = await db
			.insert(reviews)
			.values({
				userId: reader.id,
				workId: work.id,
				verdict: "recommended",
				body: "Carries itself.",
			})
			.returning();
		made.reviews.push(review.id);

		expect((await syncReviewRecord(review.id)).status).toBe("synced");
		const [row] = await db
			.select({ uri: reviews.atprotoUri })
			.from(reviews)
			.where(eq(reviews.id, review.id));
		const record = await readRecord(row.uri);
		expect(record?.verdict).toBe("recommended");
		expect(record?.text).toBe("Carries itself.");
	}, 60_000);

	// The one record that names a person rather than a record.
	it("writes a follow naming the creator's identity, and takes it down on unfollow", async () => {
		const [follow] = await db
			.insert(follows)
			.values({ followerId: reader.id, creatorId: creator.id })
			.returning();

		expect((await syncFollowRecord(follow.id)).status).toBe("synced");
		const [row] = await db
			.select({ uri: follows.atprotoUri })
			.from(follows)
			.where(eq(follows.id, follow.id));
		expect(row.uri).toStartWith(`at://${reader.did}/${FOLLOW_COLLECTION}/`);
		expect((await readRecord(row.uri))?.subject).toBe(creator.did);

		await db.delete(follows).where(eq(follows.id, follow.id));
		await removeAtprotoRecord({
			ownerId: reader.id,
			collection: FOLLOW_COLLECTION,
			uri: row.uri as string,
		});
		expect(await readRecord(row.uri)).toBeNull();
	}, 60_000);

	// 🚨 Other people's records survive the thing they were about.
	it("leaves the reader's comment standing when the post it named goes back to a draft", async () => {
		await db.update(posts).set({ isPublished: false }).where(eq(posts.id, postId));
		await syncPostRecord(postId);
		expect(await readRecord(postUri)).toBeNull();

		const id = made.comments[0];
		await db.update(comments).set({ moderationStatus: "visible" }).where(eq(comments.id, id));
		expect(await syncCommentRecord(id)).toMatchObject({
			status: "synced",
			plan: { action: "keep", reason: "subject_unpublished" },
		});
		const [row] = await db
			.select({ uri: comments.atprotoUri })
			.from(comments)
			.where(eq(comments.id, id));
		expect(await readRecord(row.uri)).not.toBeNull();
	}, 60_000);
});
