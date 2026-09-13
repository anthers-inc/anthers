// SPDX-License-Identifier: Apache-2.0
/**
 * Reviews — a verdict cannot be left without words.
 *
 * The rule is enforced at the write boundary, so the assertions that matter are
 * that a verdict-only submission is REJECTED and that the text survives the round
 * trip into the public list. Everything else here guards the edges that were
 * easy to get wrong when `body` was bolted onto an existing upsert:
 *
 *   - The conflict branch has to set BOTH columns. Setting only `verdict` on an
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
import { reviews } from "@anthers/db/schema";
import { REVIEW_MAX, REVIEW_MIN } from "@anthers/shared/content";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

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
	recommendedPercent: number | null;
	recommended: number;
	count: number;
	userVerdict: string | null;
	userReview: string | null;
	reviews: { id: number; verdict: string; body: string; username: string }[];
}

const readReviews = async (cookie?: string): Promise<ReviewList> => {
	const res = await req(`/api/content/works/${workId}/reviews`, {
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
	await enablePayouts(creatorName);
	viewerA = await signUp(viewerAName);
	await enablePayouts(viewerAName);
	_viewerB = await signUp(viewerBName);
	await enablePayouts(viewerBName);

	const itemRes = await post("/api/content/works", creator, {
		type: "game",
		title: `Review fixture ${id}`,
		// Declared on create so the release below is not refused for a reason this suite
		// is not about — release is gated on a declared content rating.
		maturity: "general",
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

describe("A verdict cannot be left without words", () => {
	it("rejects a verdict with no body at all", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "recommended",
		});
		expect(res.status).toBe(400);
	});

	it("rejects a body that is only whitespace", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "recommended",
			body: "        ",
		});
		expect(res.status).toBe(400);
	});

	it("rejects a body under the minimum", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "recommended",
			body: "x".repeat(REVIEW_MIN - 1),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a body over the maximum", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "recommended",
			body: "x".repeat(REVIEW_MAX + 1),
		});
		expect(res.status).toBe(400);
	});

	it("still rejects a verdict that is not one of ours", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "meh",
			body: "a perfectly reasonable body",
		});
		expect(res.status).toBe(400);
	});

	it("accepts a verdict with words, and publishes both", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "recommended",
			body: "  the pacing is the thing — nothing overstays  ",
		});
		expect(res.status).toBe(201);

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.reviews).toHaveLength(1);
		// Trimmed on the way in, so leading/trailing space never reaches a reader.
		expect(list.reviews[0].body).toBe("the pacing is the thing — nothing overstays");
		expect(list.reviews[0].verdict).toBe("recommended");
		expect(list.reviews[0].username).toBe(viewerAName);
	});
});

describe("Editing a review", () => {
	it("updates the verdict AND the text, not just the verdict", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "not-recommended",
			body: "came back to it and it did not hold up",
		});
		expect(res.status).toBe(201);

		const list = await readReviews();
		// Still one review — an edit, not a second row.
		expect(list.count).toBe(1);
		expect(list.reviews[0].verdict).toBe("not-recommended");
		expect(list.reviews[0].body).toBe("came back to it and it did not hold up");
	});

	it("shows the author their own verdict and words so the form can pre-fill", async () => {
		const list = await readReviews(viewerA);
		expect(list.userVerdict).toBe("not-recommended");
		expect(list.userReview).toBe("came back to it and it did not hold up");
	});

	it("still cannot resurrect a hidden review", async () => {
		const [row] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(
				and(
					eq(reviews.workId, workId),
					eq(reviews.userId, sql`(SELECT id FROM users WHERE username = ${viewerAName})`),
				),
			)
			.limit(1);
		await db.update(reviews).set({ moderationStatus: "hidden" }).where(eq(reviews.id, row.id));

		const res = await post(`/api/content/works/${workId}/reviews`, viewerA, {
			verdict: "recommended",
			body: "actually I have changed my mind again",
		});
		expect(res.status).toBe(201);

		const [after] = await db.select().from(reviews).where(eq(reviews.id, row.id));
		expect(after.verdict).toBe("recommended");
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
		await db.insert(reviews).values({ userId: viewer.id, workId, verdict: "recommended" });

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.recommendedPercent).toBe(100);
		expect(list.reviews).toHaveLength(1);
		// Null in the column, "" over the wire — the client renders the verdict alone
		// rather than an empty quote.
		expect(list.reviews[0].body).toBe("");
		expect(list.reviews[0].verdict).toBe("recommended");
	});
});
