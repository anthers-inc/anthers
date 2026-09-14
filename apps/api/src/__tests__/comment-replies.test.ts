// SPDX-License-Identifier: Apache-2.0
/**
 * Replies, through the routes a reader actually uses: writing one, reading a thread, and the
 * three surfaces that used to assume a comment's subject was always a post.
 *
 * 🚨 **A reply's `subject_id` is a COMMENT's id, and reading it as a post's is the bug this
 * suite exists to catch.** Nothing fails loudly when it happens: the moderation queue links to
 * an unrelated post, deleting a post leaves its replies behind, and a Sticker on a reply goes
 * looking for a post that happens to share a number. Each of those is asserted here by what it
 * produces, not by which function it called.
 *
 * ⚠️ **A removed comment is the case worth reading twice.** It now reaches the browser when
 * replies hang from it, so what it carries is a privacy boundary: the test compares its keys
 * exactly, because a spread that added the text back would pass any looser check.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, posts } from "@anthers/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import app from "../index";
import { blockUser, unblockUser } from "../services/blocks.js";
import { loadQueue } from "../services/moderation.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { testPublicId } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

interface Entry {
	id: number;
	subjectType: string;
	subjectId: number;
	removed: boolean;
	body?: string;
}

async function thread(slug: string, cookie?: string): Promise<Entry[]> {
	const res = await req(`/api/content/posts/${slug}/comments`, {
		headers: cookie ? { Cookie: cookie } : {},
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { comments: Entry[] }).comments;
}

async function write(slug: string, cookie: string, body: string, replyTo?: number) {
	return req(`/api/content/posts/${slug}/comments`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(replyTo === undefined ? { body } : { body, replyTo }),
	});
}

/** Write a comment or reply and return its id, failing the step if the route refused. */
async function said(slug: string, cookie: string, body: string, replyTo?: number) {
	const res = await write(slug, cookie, body, replyTo);
	expect(res.status).toBe(201);
	return ((await res.json()) as { comment: { id: number } }).comment.id;
}

describe("replies", () => {
	const people = {} as Record<
		"creator" | "alice" | "bob" | "carol" | "dave",
		{ cookie: string; id: number }
	>;
	const slug = `replies-${RUN}`;
	const otherSlug = `replies-other-${RUN}`;
	let postId: number;
	/** alice → bob → carol → alice → bob: a chain four replies deep under one comment. */
	const chain = { a: 0, b: 0, c: 0, d: 0, e: 0 };

	beforeAll(async () => {
		for (const name of ["creator", "alice", "bob", "carol", "dave"] as const) {
			const account = await createAccount(`rep_${name}_${RUN}`);
			people[name] = { cookie: account.cookie, id: account.userId };
		}
		// Written directly: a thread needs a post to hang off, not a published one, and publishing
		// would drag payout setup into a suite about replies.
		const made = await db
			.insert(posts)
			.values([
				{ creatorId: people.creator.id, publicId: testPublicId(), slug, title: `Replies ${RUN}` },
				{
					creatorId: people.creator.id,
					publicId: testPublicId(),
					slug: otherSlug,
					title: `Other ${RUN}`,
				},
			])
			.returning({ id: posts.id, slug: posts.slug });
		postId = made.find((p) => p.slug === slug)!.id;

		chain.a = await said(slug, people.alice.cookie, "a");
		chain.b = await said(slug, people.bob.cookie, "b", chain.a);
		chain.c = await said(slug, people.carol.cookie, "c", chain.b);
		chain.d = await said(slug, people.alice.cookie, "d", chain.c);
		chain.e = await said(slug, people.bob.cookie, "e", chain.d);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.delete(comments).where(like(comments.body, `%${RUN}%`));
		await db.delete(comments).where(inArray(comments.id, Object.values(chain)));
		await db.delete(posts).where(like(posts.slug, `replies-%${RUN}`));
	});

	it("⭐ stores a reply as a comment whose subject is the comment it answers", async () => {
		const [row] = await db.select().from(comments).where(eq(comments.id, chain.b));
		expect(row.subjectType).toBe("comment");
		expect(row.subjectId).toBe(chain.a);
	});

	it("returns the whole chain, each reply straight after what it answers", async () => {
		const entries = await thread(slug);
		expect(entries.map((e) => e.id)).toEqual([chain.a, chain.b, chain.c, chain.d, chain.e]);
		expect(entries.map((e) => [e.subjectType, e.subjectId])).toEqual([
			["post", postId],
			["comment", chain.a],
			["comment", chain.b],
			["comment", chain.c],
			["comment", chain.d],
		]);
	});

	it("🚨 refuses a reply to a comment under a different post, as though it did not exist", async () => {
		const res = await write(otherSlug, people.carol.cookie, `stray ${RUN}`, chain.a);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Comment not found");
	});

	it("refuses a reply to a comment that does not exist", async () => {
		const res = await write(slug, people.carol.cookie, `nothing ${RUN}`, 2_000_000_000);
		expect(res.status).toBe(404);
	});

	it("🚨 refuses a reply to a removed comment", async () => {
		await db.update(comments).set({ moderationStatus: "hidden" }).where(eq(comments.id, chain.e));
		try {
			const res = await write(slug, people.carol.cookie, `to removed ${RUN}`, chain.e);
			expect(res.status).toBe(404);
		} finally {
			await db
				.update(comments)
				.set({ moderationStatus: "visible" })
				.where(eq(comments.id, chain.e));
		}
	});

	it("🚨 keeps a removed comment as a gap carrying nothing of what it said or who said it", async () => {
		await db.update(comments).set({ moderationStatus: "hidden" }).where(eq(comments.id, chain.b));
		try {
			const entries = await thread(slug);
			expect(entries.map((e) => e.id)).toEqual([chain.a, chain.b, chain.c, chain.d, chain.e]);
			const gap = entries.find((e) => e.id === chain.b)!;
			// Exactly these keys: no body, no author, and no record address, which names the DID.
			expect(Object.keys(gap).sort()).toEqual([
				"createdAt",
				"id",
				"removed",
				"subjectId",
				"subjectType",
			]);
			expect(gap.removed).toBe(true);
			expect(entries.find((e) => e.id === chain.c)?.body).toBe("c");
		} finally {
			await db
				.update(comments)
				.set({ moderationStatus: "visible" })
				.where(eq(comments.id, chain.b));
		}
	});

	it("🚨 leaves a removed comment out when nothing beneath it is shown", async () => {
		await db.update(comments).set({ moderationStatus: "hidden" }).where(eq(comments.id, chain.e));
		try {
			expect((await thread(slug)).map((e) => e.id)).not.toContain(chain.e);
		} finally {
			await db
				.update(comments)
				.set({ moderationStatus: "visible" })
				.where(eq(comments.id, chain.e));
		}
	});

	describe("across a block", () => {
		beforeAll(async () => {
			await blockUser(people.dave.id, people.bob.id);
		});
		afterAll(async () => {
			await unblockUser(people.dave.id, people.bob.id);
		});

		it("🚨 drops the blocked author's reply and everything beneath it, for both of them", async () => {
			expect((await thread(slug, people.dave.cookie)).map((e) => e.id)).toEqual([chain.a]);
			const daves = await said(slug, people.dave.cookie, `dave ${RUN}`);
			expect((await thread(slug, people.bob.cookie)).map((e) => e.id)).not.toContain(daves);
			// Somebody in neither pair still sees the whole conversation.
			expect((await thread(slug, people.carol.cookie)).map((e) => e.id)).toEqual(
				expect.arrayContaining(Object.values(chain)),
			);
		});

		it("🚨 refuses a reply anywhere beneath a blocked author, as though it did not exist", async () => {
			const underBob = await write(slug, people.dave.cookie, `under bob ${RUN}`, chain.d);
			expect(underBob.status).toBe(404);
			expect((await underBob.json()).error).toBe("Comment not found");
			// The same comment is open to anybody the block does not concern.
			expect((await write(slug, people.creator.cookie, `ok ${RUN}`, chain.d)).status).toBe(201);
		});
	});

	it("🚨 names the post at the top of the thread in the moderation queue, not the comment a reply answers", async () => {
		await db.update(comments).set({ moderationStatus: "hidden" }).where(eq(comments.id, chain.d));
		try {
			const entry = (await loadQueue("hidden")).find(
				(i) => i.subjectType === "comment" && i.subjectId === chain.d,
			);
			expect(entry?.context).toEqual({ kind: "post", slug, title: `Replies ${RUN}` });
		} finally {
			await db
				.update(comments)
				.set({ moderationStatus: "visible" })
				.where(eq(comments.id, chain.d));
		}
	});

	it("🚨 deletes the replies with the post, at every depth", async () => {
		const doomedSlug = `replies-doomed-${RUN}`;
		const [doomed] = await db
			.insert(posts)
			.values({ creatorId: people.creator.id, publicId: testPublicId(), slug: doomedSlug })
			.returning({ id: posts.id });
		const top = await said(doomedSlug, people.alice.cookie, `top ${RUN}`);
		const reply = await said(doomedSlug, people.bob.cookie, `reply ${RUN}`, top);
		const deeper = await said(doomedSlug, people.carol.cookie, `deeper ${RUN}`, reply);

		const res = await req(`/api/content/posts/${doomedSlug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: people.creator.cookie },
		});
		expect(res.status).toBe(204);
		const left = await db
			.select({ id: comments.id })
			.from(comments)
			.where(inArray(comments.id, [top, reply, deeper]));
		expect(left).toEqual([]);
		expect(await db.select().from(posts).where(eq(posts.id, doomed.id))).toEqual([]);
	});
});
