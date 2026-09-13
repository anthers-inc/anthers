// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which record syncs and removals each route asks for.
 *
 * Every other suite about records calls a sync function directly, so a route that forgot its
 * enqueue — or a delete that enqueued its removal without the address — would pass all of them.
 * This one drives the real routes and reads what reached the queue.
 *
 * 🚨 **The removals are the half worth the suite.** A sync that is never asked for is caught by
 * the nightly sweep. A removal that is never asked for is caught by nothing, because the row a
 * sweep would compare against is exactly what the route just deleted — so the address has to be
 * read out of that delete and travel with the job, and only a test at the route can see whether
 * it did.
 *
 * ⚠️ **`queue.send` is replaced for the duration**, so nothing is actually enqueued and no worker
 * is needed. The enqueue helpers import the same queue instance this suite spies on.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, follows, users, votes } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { hideSubject, restoreSubject } from "../services/moderation.js";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const hostName = `rq_host_${id}`;
const abeName = `rq_abe_${id}`;
const beeName = `rq_bee_${id}`;

interface Sent {
	name: string;
	data: Record<string, unknown>;
}
let sent: Sent[] = [];
let sendSpy: ReturnType<typeof spyOn>;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function call(method: string, path: string, cookie: string, body?: unknown) {
	return req(path, {
		method,
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return { cookie: res.headers.get("Set-Cookie")!.split(";")[0], id: row.id };
}

/** What reached one queue since the last reset. */
function to(queueName: string): Record<string, unknown>[] {
	return sent.filter((s) => s.name === queueName).map((s) => s.data);
}

let host: { cookie: string; id: number };
let abe: { cookie: string; id: number };
let bee: { cookie: string; id: number };
let postSlug = "";
let commentId = 0;

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username IN (${hostName}, ${abeName}, ${beeName})`);
	host = await signUp(hostName);
	abe = await signUp(abeName);
	bee = await signUp(beeName);
	await db.execute(sql`UPDATE users SET is_creator = true WHERE username = ${hostName}`);

	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
});

afterAll(() => {
	sendSpy.mockRestore();
});

describe("what each route asks for", () => {
	it("asks for a post's record when a post is published", async () => {
		sent = [];
		const res = await call("POST", "/api/content/posts", host.cookie, {
			title: `Rq post ${id}`,
			workIds: [],
			isPublished: true,
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		postSlug = post.slug;
		expect(to(QUEUES.SYNC_ATPROTO_RECORD)).toContainEqual({ kind: "post", id: post.id });
	});

	it("asks for a comment's record when a comment is posted", async () => {
		sent = [];
		const res = await call("POST", `/api/content/posts/${postSlug}/comments`, abe.cookie, {
			body: `abe was here ${id}`,
		});
		expect(res.status).toBe(201);
		commentId = (await res.json()).comment.id;
		expect(to(QUEUES.SYNC_ATPROTO_RECORD)).toEqual([{ kind: "comment", id: commentId }]);
	});

	it("asks for a comment's record when a moderator hides it and when they restore it", async () => {
		sent = [];
		await hideSubject({
			subjectType: "comment",
			subjectId: commentId,
			actorId: host.id,
			reason: "spam",
		});
		await restoreSubject({ subjectType: "comment", subjectId: commentId, actorId: host.id });
		expect(to(QUEUES.SYNC_ATPROTO_RECORD)).toEqual([
			{ kind: "comment", id: commentId },
			{ kind: "comment", id: commentId },
		]);
		// And never a removal: hiding leaves the record where its author put it.
		expect(to(QUEUES.REMOVE_ATPROTO_RECORD)).toEqual([]);
	});

	it("asks for a vote's record when a vote is cast", async () => {
		sent = [];
		const res = await call("PUT", "/api/content/votes", bee.cookie, {
			subjectType: "comment",
			subjectId: commentId,
			direction: "up",
		});
		expect(res.status).toBe(200);
		const [row] = await db
			.select({ id: votes.id })
			.from(votes)
			.where(and(eq(votes.userId, bee.id), eq(votes.subjectId, commentId)));
		expect(to(QUEUES.SYNC_ATPROTO_RECORD)).toEqual([{ kind: "vote", id: row.id }]);
	});

	// 🚨 The address the removal carries can only have come out of the delete itself.
	it("carries the vote's address into its removal when the vote is withdrawn", async () => {
		const uri = `at://did:plc:${id}bee/org.anthers.vote/3lbkvote`;
		await db
			.update(votes)
			.set({ atprotoUri: uri })
			.where(and(eq(votes.userId, bee.id), eq(votes.subjectId, commentId)));

		sent = [];
		const res = await call("DELETE", "/api/content/votes", bee.cookie, {
			subjectType: "comment",
			subjectId: commentId,
		});
		expect(res.status).toBe(200);
		expect(to(QUEUES.REMOVE_ATPROTO_RECORD)).toEqual([
			{ ownerId: bee.id, collection: "org.anthers.vote", uri },
		]);
	});

	it("asks for a follow's record, and carries its address into the removal on unfollow", async () => {
		sent = [];
		expect((await call("POST", `/api/accounts/users/${hostName}/follow`, abe.cookie)).status).toBe(
			201,
		);
		const [row] = await db
			.select({ id: follows.id })
			.from(follows)
			.where(and(eq(follows.followerId, abe.id), eq(follows.creatorId, host.id)));
		expect(to(QUEUES.SYNC_ATPROTO_RECORD)).toEqual([{ kind: "follow", id: row.id }]);

		const uri = `at://did:plc:${id}abe/org.anthers.follow/3lbkfollow`;
		await db.update(follows).set({ atprotoUri: uri }).where(eq(follows.id, row.id));

		sent = [];
		expect(
			(await call("POST", `/api/accounts/users/${hostName}/unfollow`, abe.cookie)).status,
		).toBe(204);
		expect(to(QUEUES.REMOVE_ATPROTO_RECORD)).toEqual([
			{ ownerId: abe.id, collection: "org.anthers.follow", uri },
		]);
	});

	// 🚨 A block severs both follows and removes only one record: the blocker's own. The blocked
	// person's follow record is theirs, and a block is not something they did.
	it("takes down only the blocker's own follow record when they block somebody", async () => {
		const abeFollowsBee = `at://did:plc:${id}abe/org.anthers.follow/3lbkab`;
		const beeFollowsAbe = `at://did:plc:${id}bee/org.anthers.follow/3lbkba`;
		await db.insert(follows).values([
			{ followerId: abe.id, creatorId: bee.id, atprotoUri: abeFollowsBee },
			{ followerId: bee.id, creatorId: abe.id, atprotoUri: beeFollowsAbe },
		]);

		sent = [];
		expect((await call("POST", `/api/accounts/users/${beeName}/block`, abe.cookie)).status).toBe(
			201,
		);
		expect(to(QUEUES.REMOVE_ATPROTO_RECORD)).toEqual([
			{ ownerId: abe.id, collection: "org.anthers.follow", uri: abeFollowsBee },
		]);

		// Both rows are gone regardless, which is what the block is for.
		const left = await db
			.select({ id: follows.id })
			.from(follows)
			.where(sql`(${follows.followerId} = ${abe.id} AND ${follows.creatorId} = ${bee.id})
				OR (${follows.followerId} = ${bee.id} AND ${follows.creatorId} = ${abe.id})`);
		expect(left).toEqual([]);
		await db.delete(comments).where(eq(comments.id, commentId));
	});
});
