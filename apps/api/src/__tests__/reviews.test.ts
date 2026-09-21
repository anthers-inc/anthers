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
import { reviews, users, votes } from "@anthers/db/schema";
import { REVIEW_MAX, REVIEW_MIN } from "@anthers/shared/content";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { handleOf } from "./handles.js";
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
	return (await createAccount(username)).cookie;
}

interface ReviewList {
	recommendedPercent: number | null;
	recommended: number;
	count: number;
	recent: {
		window: string;
		recommendedPercent: number | null;
		recommended: number;
		count: number;
	};
	userVerdict: string | null;
	userReview: string | null;
	reviews: {
		id: number;
		verdict: string;
		body: string;
		handle: string;
		score: number;
		viewerVote: "up" | "down" | null;
	}[];
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
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${viewerAName}@example.com`}`, sql`${`${viewerBName}@example.com`}`], sql`, `)})`,
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
		// Rated on create so the release below is not refused for a reason this suite
		// is not about — release is gated on every row of the rating being answered.
		maturityRows: rowsRatedAs("general"),
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
		expect(list.reviews[0].handle).toBe(await handleOf(viewerAName));
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
					eq(
						reviews.userId,
						sql`(SELECT id FROM users WHERE email = ${`${viewerAName}@example.com`})`,
					),
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
			sql`SELECT id FROM users WHERE email = ${`${viewerBName}@example.com`}`,
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

describe("Helpfulness — reviews sort by it and are never weighted by it", () => {
	it("carries a floored net and the viewer's own vote on every review", async () => {
		// The viewerB review from the block above is the subject. Three fresh readers
		// vote on it: two up and one down lands it at 1, which the REVIEWER sees
		// decomposed and everybody else sees as one number.
		const reviewId = (await readReviews()).reviews[0].id;
		expect(reviewId, "the legacy review id").toBeGreaterThan(0);
		const voterNames = ["h_a", "h_b", "h_c"].map((n) => `rv_${n}_${id}`);
		const cookies: string[] = [];
		for (const name of voterNames) cookies.push(await signUp(name));

		const vote = async (cookie: string, direction: "up" | "down") =>
			req("/api/content/votes", {
				method: "PUT",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
				body: JSON.stringify({ subjectType: "review", subjectId: reviewId, direction }),
			});
		expect((await vote(cookies[0], "up")).status).toBe(200);
		expect((await vote(cookies[1], "up")).status).toBe(200);
		expect((await vote(cookies[2], "down")).status).toBe(200);

		const anonymous = await readReviews();
		const entry = anonymous.reviews.find((r) => r.id === reviewId)!;
		// Two up and one down is a net of 1. This review predates the author auto-upvote (the
		// row was inserted directly above), so nothing else is in the tally.
		expect(entry.score).toBe(1);
		expect(entry.viewerVote).toBeNull();
		expect(entry).not.toHaveProperty("up");
		expect(entry).not.toHaveProperty("down");

		// A voter sees their own; the aggregate is untouched — 100% recommended from one
		// review however many votes the review draws.
		const asVoter = await readReviews(cookies[2]);
		expect(asVoter.reviews[0].viewerVote).toBe("down");
		expect(asVoter.recommendedPercent).toBe(100);
		expect(asVoter.count).toBe(1);

		// The reviewer sees the figures behind it, as a commenter does on their own.
		const own = await req(`/api/content/votes?subjectType=review&subjectId=${reviewId}`, {
			headers: { Cookie: _viewerB },
		});
		expect(own.status).toBe(200);
		const ownJson = await own.json();
		expect(ownJson).toHaveProperty("up");
		expect(ownJson).toHaveProperty("down");
		// And nobody else does.
		const other = await req(`/api/content/votes?subjectType=review&subjectId=${reviewId}`, {
			headers: { Cookie: cookies[0] },
		});
		expect(await other.json()).not.toHaveProperty("up");
	});

	it("refuses a vote on a hidden review, which would be voting on something no reader can see", async () => {
		// viewerA's review was hidden in the editing block above and is still there.
		const [hidden] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(and(eq(reviews.workId, workId), eq(reviews.moderationStatus, "hidden")))
			.limit(1);
		const cookie = await signUp(`rv_hidden_${id}`);
		const res = await req("/api/content/votes", {
			method: "PUT",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ subjectType: "review", subjectId: hidden.id, direction: "up" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("The reviewer's own upvote", () => {
	// Reddit's rule, settled 2026-09-21: posting something says the author thinks it is
	// worth reading, so a new review starts at 1 and a 0 always means a reader said no.
	it("starts a new review at 1, cast by its author", async () => {
		const cookie = await signUp(`rv_auto_${id}`);
		const res = await post(`/api/content/works/${workId}/reviews`, cookie, {
			verdict: "not-recommended",
			body: "the tutorial lies about the second boss",
		});
		expect(res.status).toBe(201);
		const reviewId = (await res.json()).review.id as number;

		const list = await readReviews();
		const entry = list.reviews.find((r) => r.id === reviewId)!;
		expect(entry.score).toBe(1);
		const asAuthor = await readReviews(cookie);
		expect(asAuthor.reviews.find((r) => r.id === reviewId)!.viewerVote).toBe("up");
	});

	it("does not resurrect a withdrawn vote when the review is edited", async () => {
		const cookie = await signUp(`rv_edit_${id}`);
		const res = await post(`/api/content/works/${workId}/reviews`, cookie, {
			verdict: "recommended",
			body: "short and it knows when to end",
		});
		const reviewId = (await res.json()).review.id as number;

		// The author takes their vote back — a deliberate nothing rather than a down.
		const gone = await req("/api/content/votes", {
			method: "DELETE",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ subjectType: "review", subjectId: reviewId }),
		});
		expect(gone.status).toBe(200);

		// Editing must not put it back — the upsert's author-upvote is insert-only.
		const edit = await post(`/api/content/works/${workId}/reviews`, cookie, {
			verdict: "recommended",
			body: "still true after the patch",
		});
		expect(edit.status).toBe(201);
		const [row] = await db
			.select({ id: votes.id })
			.from(votes)
			.where(and(eq(votes.subjectType, "review"), eq(votes.subjectId, reviewId)));
		expect(row, "no vote row after a withdrawn-vote edit").toBeUndefined();
		const list = await readReviews();
		expect(list.reviews.find((r) => r.id === reviewId)!.score).toBe(0);
	});
});

describe("The Recent share", () => {
	// A reader-selectable window beside All Time (Parker, 2026-09-13): the same proportion
	// over only the reviews inside it, or null rather than 0 when the window is empty.
	it("computes over the chosen window and nowhere else", async () => {
		// viewerB's review above is "recommended" and is the only one we move. Everything
		// else on this Work was written this run and is recent by construction.
		const [bRow] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.innerJoin(users, eq(reviews.userId, users.id))
			.where(
				and(eq(reviews.workId, workId), eq(users.atprotoHandle, await handleOf(viewerBName))),
			)
			.limit(1);
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // outside the month
		await db.update(reviews).set({ createdAt: old }).where(eq(reviews.id, bRow.id));

		const readWindow = async (window: string) => {
			const res = await req(`/api/content/works/${workId}/reviews?window=${window}`);
			expect(res.status).toBe(200);
			return (await res.json()).recent as {
				window: string;
				recommendedPercent: number | null;
				recommended: number;
				count: number;
			};
		};

		// All Time unchanged — the move is a window matter, not a count matter: the
		// visible set is viewerB (recommended) plus this block's two (1 of 2 recommended).
		const all = await readReviews();
		expect(all.count).toBe(3);
		expect(all.recommendedPercent).toBe(67);

		// Over the month, only the two fresh rows count: 1 of 2 = 50%.
		const month = await readWindow("month");
		expect(month.window).toBe("month");
		expect(month.count).toBe(2);
		expect(month.recommendedPercent).toBe(50);

		// Over the year the moved row is back inside: 2 of 3 = 67%.
		const year = await readWindow("year");
		expect(year.count).toBe(3);
		expect(year.recommendedPercent).toBe(67);

		// The default when no window is asked for is the month.
		const defaultRes = await req(`/api/content/works/${workId}/reviews`);
		expect((await defaultRes.json()).recent.window).toBe("month");

		// And an unknown window is a bad request rather than a silent guess.
		expect((await req(`/api/content/works/${workId}/reviews?window=decade`)).status).toBe(400);

		// Put the row back so nothing after this suite reads a backdated fixture.
		await db.update(reviews).set({ createdAt: new Date() }).where(eq(reviews.id, bRow.id));
	});
});
