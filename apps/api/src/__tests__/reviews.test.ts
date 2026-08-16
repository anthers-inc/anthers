// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reviews — a score cannot be left without words.
 *
 * The rule is enforced at the write boundary, so the assertions that matter are
 * that a score-only submission is REJECTED and that the text survives the round
 * trip into the public list. Everything else here guards the edges that were
 * easy to get wrong when `body` was bolted onto an existing upsert:
 *
 *   - The conflict branch has to set BOTH columns. Setting only `score` on an
 *     edit would silently keep the old text against a new verdict, which is
 *     worse than either failing or being ignored.
 *   - It must still NOT set `moderationStatus`, or re-reviewing becomes a way to
 *     un-hide your own hidden review. That rule predates this change and is
 *     exactly the sort of thing a hurried edit to the same statement breaks.
 *   - Rows written before text was required have `body IS NULL`, must keep
 *     rendering, and must keep counting toward the average.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { ratings } from "@anthers/db/schema";
import { REVIEW_MAX, REVIEW_MIN } from "@anthers/shared/content";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string, body: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	});
}

async function signUp(username: string): Promise<string> {
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

interface ReviewList {
	average: number | null;
	count: number;
	userRating: number | null;
	userReview: string | null;
	reviews: { id: number; score: number; body: string; username: string }[];
}

const readReviews = async (cookie?: string): Promise<ReviewList> => {
	const res = await req(`/api/content/works/${workId}/ratings`, {
		headers: cookie ? { Cookie: cookie } : undefined,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as ReviewList;
};

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `rv_creator_${id}`;
const viewerAName = `rv_a_${id}`;
const viewerBName = `rv_b_${id}`;
const _FREE = [{ threshold: 0, allow: true, price: "0" }];

let creator: string;
let viewerA: string;
let _viewerB: string;
let workId: number;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerAName}, ${viewerBName})`,
	);
	creator = await signUp(creatorName);
	viewerA = await signUp(viewerAName);
	_viewerB = await signUp(viewerBName);

	const itemRes = await post("/api/content/works", creator, {
		type: "game",
		title: `Review fixture ${id}`,
	});
	expect(itemRes.status).toBe(201);
	workId = (await itemRes.json()).work.id;

	// Released and open to everyone — reviewing requires access, so a locked fixture
	// would make every case below a 403 for a reason that isn't what's under test.
	const release = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator },
		body: JSON.stringify({
			visibility: "released",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(release.status).toBe(200);
}, DB_SETUP_TIMEOUT);

describe("A score cannot be left without words", () => {
	it("rejects a score with no body at all", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, { score: 5 });
		expect(res.status).toBe(400);
	});

	it("rejects a body that is only whitespace", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 5,
			body: "        ",
		});
		expect(res.status).toBe(400);
	});

	it("rejects a body under the minimum", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 5,
			body: "x".repeat(REVIEW_MIN - 1),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a body over the maximum", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 5,
			body: "x".repeat(REVIEW_MAX + 1),
		});
		expect(res.status).toBe(400);
	});

	it("still rejects an out-of-range score", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 6,
			body: "a perfectly reasonable body",
		});
		expect(res.status).toBe(400);
	});

	it("accepts a score with words, and publishes both", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 4,
			body: "  the pacing is the thing — nothing overstays  ",
		});
		expect(res.status).toBe(201);

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.reviews).toHaveLength(1);
		// Trimmed on the way in, so leading/trailing space never reaches a reader.
		expect(list.reviews[0].body).toBe("the pacing is the thing — nothing overstays");
		expect(list.reviews[0].score).toBe(4);
		expect(list.reviews[0].username).toBe(viewerAName);
	});
});

describe("Editing a review", () => {
	it("updates the score AND the text, not just the score", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 2,
			body: "came back to it and it did not hold up",
		});
		expect(res.status).toBe(201);

		const list = await readReviews();
		// Still one review — an edit, not a second row.
		expect(list.count).toBe(1);
		expect(list.reviews[0].score).toBe(2);
		expect(list.reviews[0].body).toBe("came back to it and it did not hold up");
	});

	it("shows the author their own score and words so the form can pre-fill", async () => {
		const list = await readReviews(viewerA);
		expect(list.userRating).toBe(2);
		expect(list.userReview).toBe("came back to it and it did not hold up");
	});

	it("still cannot resurrect a hidden review", async () => {
		const [row] = await db
			.select({ id: ratings.id })
			.from(ratings)
			.where(
				and(
					eq(ratings.workId, workId),
					eq(ratings.userId, sql`(SELECT id FROM users WHERE username = ${viewerAName})`),
				),
			)
			.limit(1);
		await db.update(ratings).set({ moderationStatus: "hidden" }).where(eq(ratings.id, row.id));

		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 5,
			body: "actually I have changed my mind again",
		});
		expect(res.status).toBe(201);

		const [after] = await db.select().from(ratings).where(eq(ratings.id, row.id));
		expect(after.score).toBe(5);
		expect(after.body).toBe("actually I have changed my mind again");
		// The whole point: the edit landed, the row stayed hidden.
		expect(after.moderationStatus).toBe("hidden");

		const list = await readReviews();
		expect(list.count).toBe(0);
		expect(list.reviews).toHaveLength(0);
	});
});

describe("Reviews written before text was required", () => {
	it("still render and still count, with an empty body", async () => {
		// Insert the legacy shape directly — the API can no longer produce it.
		const [viewer] = (await db.execute(
			sql`SELECT id FROM users WHERE username = ${viewerBName}`,
		)) as unknown as { id: number }[];
		await db.insert(ratings).values({ userId: viewer.id, workId, score: 3 });

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.average).toBe(3);
		expect(list.reviews).toHaveLength(1);
		// Null in the column, "" over the wire — the client renders the score alone
		// rather than an empty quote.
		expect(list.reviews[0].body).toBe("");
		expect(list.reviews[0].score).toBe(3);
	});
});
