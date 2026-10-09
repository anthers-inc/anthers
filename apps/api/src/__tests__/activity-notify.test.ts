// SPDX-License-Identifier: Apache-2.0
/**
 * Activity emitters, through the routes a user actually uses — the notification a reply,
 * a comment, a review and a follow leaves behind.
 *
 * 🚨 **The assertion target is the ROW, not the mail.** Delivery under the test runner is
 * a logged no-op (`sendEmail` refuses); what these tests claim is that the right person's
 * `notifications` row exists with the right `kind`, `linkPath` and `dedupeKey`, and — the
 * part only a blocked pair can disprove — that the wrong pair produces none.
 *
 * ⭐ **Every block case here walks the write boundary, not the emitter alone.** The reply
 * notification's block check is `replyRefusal`'s 404; the follow's is its route's; so the
 * blocked-pair assertions drive the ROUTES a blocked user would actually drive, because
 * a guard proven only on the emitter never sees the caller that matters (the rule the
 * fixture-hygiene incident paid for: ask what reads the row, and here ask who wrote it).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, follows, notifications, posts, userPreferences } from "@anthers/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import app from "../index";
import { blockUser } from "../services/blocks.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, testPublicId } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

const id = () => crypto.randomUUID().slice(0, 8);

interface Account {
	cookie: string;
	userId: number;
	handle: string;
}

const people: Record<"author" | "commenter" | "reviewer" | "follower" | "blocked", Account> =
	{} as never;

let postSlug = "";
let postPublicId = 0;
let parentCommentId = 0;
let workId = 0;

async function lastNotification(userId: number, kind: string) {
	const [row] = await db
		.select()
		.from(notifications)
		.where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)))
		.orderBy(notifications.id);
	return row ?? null;
}

beforeAll(async () => {
	for (const name of ["author", "commenter", "reviewer", "follower", "blocked"] as const) {
		const account = await createAccount(`act_${name}_${RUN}`);
		people[name] = {
			cookie: account.cookie,
			userId: account.userId,
			handle: account.handle,
		};
	}
	postSlug = `act-notify-${RUN}`;
	postPublicId = testPublicId();
	await db.insert(posts).values({
		creatorId: people.author.userId,
		publicId: postPublicId,
		slug: postSlug,
		title: `Activity notify ${RUN}`,
	});

	const work = await insertWork({
		creatorId: people.author.userId,
		type: "game",
		title: `Activity work ${RUN}`,
		// Everyone-access, so the reviewer can reach the Work — reviewing is gated on
		// consuming, and an unpurchased released Work answers "access required".
		access: [{ threshold: 0, allow: true, price: "0" }],
	});
	workId = work.id;
}, DB_SETUP_TIMEOUT);

describe("emitters", () => {
	it("a comment on your post notifies you with the post for its link", async () => {
		const res = await req(`/api/content/posts/${postSlug}/comments`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.commenter.cookie,
			},
			body: JSON.stringify({ body: `note ${RUN}` }),
		});
		expect(res.status).toBe(201);
		const row = await lastNotification(people.author.userId, "post_comment");
		expect(row).not.toBeNull();
		expect(row?.linkPath).toBe(`/posts/${postSlug}-${postPublicId}#comments`);
	});

	it("a reply notifies the parent's author with an anchor on the parent comment", async () => {
		// The comment from the previous test, by its body.
		const [written] = await db
			.select({ id: comments.id })
			.from(comments)
			.where(like(comments.body, `note ${RUN}%`))
			.limit(1);
		parentCommentId = written.id;

		const res = await req(`/api/content/posts/${postSlug}/comments`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.reviewer.cookie,
			},
			body: JSON.stringify({ body: `answer ${RUN}`, replyTo: parentCommentId }),
		});
		expect(res.status).toBe(201);

		const row = await lastNotification(people.commenter.userId, "comment_reply");
		expect(row).not.toBeNull();
		expect(row?.linkPath).toContain(`#comment-${parentCommentId}`);
	});

	it("your own reply to your own comment notifies nobody", async () => {
		const before = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(eq(notifications.kind, "comment_reply"));
		const res = await req(`/api/content/posts/${postSlug}/comments`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.commenter.cookie,
			},
			body: JSON.stringify({ body: `self ${RUN}`, replyTo: parentCommentId }),
		});
		expect(res.status).toBe(201);
		const after = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(eq(notifications.kind, "comment_reply"));
		expect(after.length).toBe(before.length);
	});

	it("a NEW review notifies the creator; its edit does not notify again", async () => {
		const res = await req(`/api/content/works/${workId}/reviews`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.reviewer.cookie,
			},
			body: JSON.stringify({ verdict: "recommended", body: `worth it ${RUN}` }),
		});
		expect(res.status).toBe(201);
		const row = await lastNotification(people.author.userId, "work_review");
		expect(row).not.toBeNull();
		expect(row?.linkPath).toContain("#reviews");

		// The edit lands on the conflict branch — the same verdict, new words — and the
		// count of review notifications for this creator must not move.
		const before = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(
				and(eq(notifications.kind, "work_review"), eq(notifications.userId, people.author.userId)),
			);
		const edit = await req(`/api/content/works/${workId}/reviews`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.reviewer.cookie,
			},
			body: JSON.stringify({ verdict: "not-recommended", body: `changed my mind ${RUN}` }),
		});
		expect(edit.status).toBe(201);
		const after = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(
				and(eq(notifications.kind, "work_review"), eq(notifications.userId, people.author.userId)),
			);
		expect(after.length).toBe(before.length);
	});

	it("a follow notifies the person followed; a repeat does not", async () => {
		const follow = await req(`/api/accounts/users/${people.author.handle}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: people.follower.cookie },
		});
		expect(follow.status).toBe(201);
		const row = await lastNotification(people.author.userId, "new_follower");
		expect(row).not.toBeNull();

		const before = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(
				and(eq(notifications.kind, "new_follower"), eq(notifications.userId, people.author.userId)),
			);
		await req(`/api/accounts/users/${people.author.handle}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: people.follower.cookie },
		});
		const after = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(
				and(eq(notifications.kind, "new_follower"), eq(notifications.userId, people.author.userId)),
			);
		expect(after.length).toBe(before.length);
	});

	it("🚨 a blocked pair produces no notification, by every door a pair can meet through", async () => {
		// Block in one direction; enforcement is symmetric, so either would do.
		await blockUser(people.author.userId, people.blocked.userId);

		// The reply door — the pair's only meeting inside a thread. A fresh top-level
		// comment is NOT refused by a block (blocks do not filter posts), so the door to
		// assert is the reply to the blocked author's own comment: refused 404 before a
		// notification could exist, exactly the boundary replyRefusal documents.
		const written = await req(`/api/content/posts/${postSlug}/comments`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: people.author.cookie },
			body: JSON.stringify({ body: `author says ${RUN}` }),
		});
		expect(written.status).toBe(201);
		const authored = ((await written.json()) as { comment: { id: number } }).comment.id;
		const reply = await req(`/api/content/posts/${postSlug}/comments`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.blocked.cookie,
			},
			body: JSON.stringify({ body: `no ${RUN}`, replyTo: authored }),
		});
		expect(reply.status).toBe(404);

		// The follow door.
		const follow = await req(`/api/accounts/users/${people.author.handle}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: people.blocked.cookie },
		});
		expect(follow.status).toBe(404);

		// And the rows: nothing of the blocked person's writing notified anybody.
		const rows = await db
			.select()
			.from(notifications)
			.where(like(notifications.dedupeKey, `%${people.blocked.userId}%`));
		expect(rows).toEqual([]);
	});

	it("the delivery map silences the mail half without touching the row", async () => {
		await db
			.insert(userPreferences)
			.values({
				userId: people.author.userId,
				notificationDelivery: { conversation: "app" },
			})
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { notificationDelivery: { conversation: "app" } },
			});
		const before = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(eq(notifications.kind, "post_comment"));
		const res = await req(`/api/content/posts/${postSlug}/comments`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: people.reviewer.cookie,
			},
			body: JSON.stringify({ body: `quiet mail ${RUN}` }),
		});
		expect(res.status).toBe(201);
		const after = await db
			.select({ n: notifications.id })
			.from(notifications)
			.where(eq(notifications.kind, "post_comment"));
		// The row still lands — app-only is not an opt-out of being told.
		expect(after.length).toBeGreaterThan(before.length);
	});

	it("the unread endpoint answers the caller's own count and nothing else", async () => {
		const res = await req("/api/accounts/me/notifications/unread", {
			headers: { Cookie: people.author.cookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { unread: number };
		// The same number the list read reports — the two endpoints are one count from one
		// service, and a drift here would be the bell saying something the page's own
		// header contradicts.
		const listed = await req("/api/accounts/me/notifications", {
			headers: { Cookie: people.author.cookie },
		});
		const listedBody = (await listed.json()) as { unread: number };
		expect(body.unread).toBe(listedBody.unread);
		expect(body.unread).toBeGreaterThan(0);
	});
});

// ── Cleanup: everything these tests wrote, on success or failure ────────────────
import { afterAll } from "bun:test";

afterAll(async () => {
	// The comment rows (the route's writes and the suite's direct reads), then the post,
	// then the notifications those emits wrote, then the follows.
	const made = await db
		.select({ id: comments.id })
		.from(comments)
		.where(like(comments.body, `%${RUN}%`));
	if (made.length > 0)
		await db.delete(comments).where(
			inArray(
				comments.id,
				made.map((m) => m.id),
			),
		);
	await db.delete(comments).where(eq(comments.id, parentCommentId));
	await db.delete(posts).where(eq(posts.slug, postSlug));
	// Reviews cascade off the Work (insertWork's fixture does not own cleanup for works
	// the suite did not create — this one did).
	const notifs = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(like(notifications.dedupeKey, `%:${RUN}%`));
	if (notifs.length > 0)
		await db.delete(notifications).where(
			inArray(
				notifications.id,
				notifs.map((n) => n.id),
			),
		);
	// Follows keyed off this run's pairs.
	await db
		.delete(follows)
		.where(
			and(
				eq(follows.followerId, people.follower.userId),
				eq(follows.creatorId, people.author.userId),
			),
		);
	await db
		.delete(follows)
		.where(
			and(
				eq(follows.followerId, people.blocked.userId),
				eq(follows.creatorId, people.author.userId),
			),
		);
	void id;
});
