// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A like, a dislike, and the two rules that make the thread's order accountable.
 *
 * 🚨 **The published score is the ranking key, and that is a claim about two things
 * agreeing.** Parker, 2026-09-04: *"there's nothing ranking stuff that the users can't
 * see."* A test reading only the score would never notice the sort switching to the true
 * net, so the assertions here compare what is sent against what the order came out as.
 *
 * ⚠️ **The raw counts must not be in the response at all.** Publishing one number rather
 * than two is the whole reason a pile-on has no counter to run up, and it is the kind of
 * field that gets added back by a well-meaning "while I'm here".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, reactions, users } from "@anthers/db/schema";
import { COLLAPSE_NET_THRESHOLD } from "@anthers/shared/reactions";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string) {
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
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

function react(cookie: string, subjectId: number, value: 1 | -1) {
	return req("/api/content/reactions", {
		method: "PUT",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ subjectType: "comment", subjectId, value }),
	});
}

function unreact(cookie: string, subjectId: number) {
	return req("/api/content/reactions", {
		method: "DELETE",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ subjectType: "comment", subjectId }),
	});
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `react_${id}`;
/** Enough separate accounts to push a comment past the collapse threshold, and one spare. */
const voterNames = Array.from(
	{ length: -COLLAPSE_NET_THRESHOLD + 1 },
	(_, i) => `react_v${i}_${id}`,
);

describe("reactions", () => {
	let creatorCookie: string;
	let voterCookies: string[];
	let workId: number;
	/** Three comments on one Work: one liked, one untouched, one to be buried. */
	let likedId: number;
	let quietId: number;
	let buriedId: number;

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${sql.join(
				[creatorName, ...voterNames].map((n) => sql`${n}`),
				sql`, `,
			)})`,
		);
		creatorCookie = await signUp(creatorName);
		voterCookies = [];
		for (const name of voterNames) voterCookies.push(await signUp(name));

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName));
		workId = (await insertWork({ creatorId: creator.id, type: "text", title: `Reactions ${id}` }))
			.id;

		const made = await db
			.insert(comments)
			.values(
				["liked", "quiet", "buried"].map((body) => ({
					userId: creator.id,
					subjectType: "work" as const,
					subjectId: workId,
					body,
				})),
			)
			.returning({ id: comments.id, body: comments.body });
		likedId = made.find((m) => m.body === "liked")!.id;
		quietId = made.find((m) => m.body === "quiet")!.id;
		buriedId = made.find((m) => m.body === "buried")!.id;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.delete(reactions).where(inArray(reactions.subjectId, [likedId, quietId, buriedId]));
	});

	async function thread(cookie?: string) {
		const res = await req(`/api/content/works/${workId}/comments`, {
			headers: cookie ? { Cookie: cookie } : {},
		});
		expect(res.status).toBe(200);
		return (await res.json()).comments as {
			id: number;
			score: number;
			collapsed: boolean;
			viewerReaction: 1 | -1 | null;
		}[];
	}

	it("requires a session — there is nobody to hold to one-per-person otherwise", async () => {
		const res = await req("/api/content/reactions", {
			method: "PUT",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ subjectType: "comment", subjectId: likedId, value: 1 }),
		});
		expect(res.status).toBe(401);
	});

	it("refuses anything that is not +1 or -1", async () => {
		for (const value of [0, 2, -5]) {
			const res = await react(creatorCookie, likedId, value as 1);
			expect(res.status, `value ${value}`).toBe(400);
		}
	});

	it("🚨 counts one reaction per person, and changing it replaces rather than adds", async () => {
		await react(voterCookies[0], likedId, 1);
		await react(voterCookies[0], likedId, 1);
		await react(voterCookies[0], likedId, -1);
		const rows = await db
			.select({ value: reactions.value })
			.from(reactions)
			.where(eq(reactions.subjectId, likedId));
		expect(rows).toHaveLength(1);
		expect(rows[0].value).toBe(-1);
		// Back to a like, so the rest of the suite starts from a known state.
		await react(voterCookies[0], likedId, 1);
	});

	it("takes a reaction back, which is not the same as saying the opposite", async () => {
		await react(voterCookies[1], quietId, -1);
		const removed = await unreact(voterCookies[1], quietId);
		expect(removed.status).toBe(200);
		expect((await removed.json()).viewerReaction).toBeNull();
		const [row] = await db
			.select({ id: reactions.id })
			.from(reactions)
			.where(eq(reactions.subjectId, quietId));
		expect(row).toBeUndefined();
	});

	it("404s on a comment that is not there rather than storing a dangling vote", async () => {
		const res = await react(creatorCookie, 2_000_000_000, 1);
		expect(res.status).toBe(404);
	});

	it("🚨 publishes the score and NEVER the raw counts to a reader", async () => {
		// Signed out, and to anybody who did not write the comment. Two numbers is the
		// pile-on scoreboard the single net exists to withhold.
		for (const rows of [await thread(), await thread(voterCookies[0])]) {
			const first = rows[0];
			expect(first).toHaveProperty("score");
			expect(first).not.toHaveProperty("likes");
			expect(first).not.toHaveProperty("dislikes");
		}
	});

	it("⭐ gives an AUTHOR the exact counts on their own comment", async () => {
		// Parker, 2026-09-04: "the creator should have full visibility into exact like
		// values and dislike values, not just the net". The comments here are the creator's.
		const own = (await thread(creatorCookie)).find((c) => c.id === likedId) as unknown as {
			likes: number;
			dislikes: number;
			score: number;
		};
		expect(own.likes).toBeGreaterThan(0);
		expect(own.dislikes).toBe(0);
		expect(own.score).toBe(own.likes - own.dislikes);
	});

	it("🚨 gives the counts to the author through the single-subject read, and to nobody else", async () => {
		const read = async (cookie?: string) => {
			const res = await req(
				`/api/content/reactions?subjectType=comment&subjectId=${likedId}`,
				cookie ? { headers: { Cookie: cookie } } : {},
			);
			expect(res.status).toBe(200);
			return (await res.json()) as { score: number; likes?: number; dislikes?: number };
		};
		expect(await read(creatorCookie)).toHaveProperty("likes");
		// The voter has reacted to it, which is the closest anybody gets to a claim on it.
		expect(await read(voterCookies[0])).not.toHaveProperty("likes");
		expect(await read()).not.toHaveProperty("likes");
	});

	it("shows a viewer their own reaction, and shows nobody else's", async () => {
		const asVoter = await thread(voterCookies[0]);
		expect(asVoter.find((c) => c.id === likedId)!.viewerReaction).toBe(1);
		const anonymous = await thread();
		expect(anonymous.find((c) => c.id === likedId)!.viewerReaction).toBeNull();
	});

	it("🚨 floors the published score at zero, so a pile-on has no counter to run up", async () => {
		for (const cookie of voterCookies) await react(cookie, buriedId, -1);
		const rows = await thread();
		const buried = rows.find((c) => c.id === buriedId)!;
		expect(buried.score).toBe(0);
		expect(buried.collapsed).toBe(true);
	});

	it("🚨 orders the thread by the number it published, and by nothing else", async () => {
		const rows = await thread();
		// Descending by the visible score: the liked comment first, and the two at zero tied
		// on score with recency breaking them. A sort that had switched to the true net would
		// put the buried comment last instead of leaving it tied.
		expect(rows.map((c) => c.score)).toEqual([...rows.map((c) => c.score)].sort((a, b) => b - a));
		expect(rows[0].id).toBe(likedId);
		const zeros = rows.filter((c) => c.score === 0).map((c) => c.id);
		expect(zeros).toContain(buriedId);
		expect(zeros).toContain(quietId);
	});

	it("⭐ collapses a buried comment without hiding it, which is a different thing", async () => {
		// Removal is a state and never reaches a reader; this comment is still in the
		// response, still carries its text, and merely arrives folded.
		const buried = (await thread()).find((c) => c.id === buriedId)!;
		expect(buried.collapsed).toBe(true);
		expect(buried).toHaveProperty("body", "buried");
	});

	it("uncollapses when the likes come back — collapse is a position, not a strike", async () => {
		for (const cookie of voterCookies) await react(cookie, buriedId, 1);
		const buried = (await thread()).find((c) => c.id === buriedId)!;
		expect(buried.collapsed).toBe(false);
		expect(buried.score).toBe(voterCookies.length);
	});
});
