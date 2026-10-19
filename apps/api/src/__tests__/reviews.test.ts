// SPDX-License-Identifier: Apache-2.0
/**
 * Reviews — a verdict can stand alone.
 *
 * The write boundary accepts a verdict with no text (Parker, 2026-10-19). A textless
 * review counts in the Work's shares and never appears in the list, where only reviews
 * with words belong, so the assertions here cover both halves of that rule. Everything
 * else guards the edges that were easy to get wrong when `body` was bolted onto an
 * existing upsert:
 *
 *   - The conflict branch has to set BOTH columns. Setting only `verdict` on an
 *     edit would silently keep the old text against a new verdict, which is
 *     worse than either failing or being ignored.
 *   - It must still NOT set `moderationStatus`, or re-reviewing becomes a way to
 *     un-hide your own hidden review. That rule predates this change and is
 *     exactly the sort of thing a hurried edit to the same statement breaks.
 *   - A row with no body must count in the aggregate and stay out of the list —
 *     the same read-side rule whether the row was written by the API or predates it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { reviews, users, votes } from "@anthers/db/schema";
import { REVIEW_MAX } from "@anthers/shared/content";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { REVIEW_COLLECTION } from "../services/atproto-record-plan.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { handleOf } from "./handles.js";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { CREATED_CREDIT } from "./work-fixtures.js";

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
		userVote: "up" | "down" | null;
		recordUrl?: string | null;
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
const userAName = `rv_a_${id}`;
const userBName = `rv_b_${id}`;
const _FREE = [{ threshold: 0, allow: true, price: "0" }];

let creator: string;
let userA: string;
let _userB: string;
let workId: number;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${userAName}@example.com`}`, sql`${`${userBName}@example.com`}`], sql`, `)})`,
	);
	creator = await signUp(creatorName);
	await enablePayouts(creatorName);
	userA = await signUp(userAName);
	await enablePayouts(userAName);
	_userB = await signUp(userBName);
	await enablePayouts(userBName);

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
			credits: CREATED_CREDIT,
			access: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(release.status).toBe(200);
}, DB_SETUP_TIMEOUT);

describe("A review can stand on its verdict alone", () => {
	it("accepts a verdict with no body at all, counting it without listing it", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
			verdict: "recommended",
		});
		expect(res.status).toBe(201);

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.recommended).toBe(1);
		expect(list.recommendedPercent).toBe(100);
		// The verdict counts; it has nothing to read, so it is not in the list.
		expect(list.reviews).toHaveLength(0);
	});

	it("treats text that is only whitespace as no text", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
			verdict: "recommended",
			body: "        ",
		});
		expect(res.status).toBe(201);

		const list = await readReviews(userA);
		expect(list.count).toBe(1);
		expect(list.reviews).toHaveLength(0);
		// Stored as absence rather than an empty string, the same shape a record carries.
		expect(list.userReview).toBeNull();
	});

	it("rejects a body over the maximum", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
			verdict: "recommended",
			body: "x".repeat(REVIEW_MAX + 1),
		});
		expect(res.status).toBe(400);
	});

	it("still rejects a verdict that is not one of ours", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
			verdict: "meh",
			body: "a perfectly reasonable body",
		});
		expect(res.status).toBe(400);
	});

	it("accepts a verdict with words, and publishes both", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
			verdict: "recommended",
			body: "  the pacing is the thing — nothing overstays  ",
		});
		expect(res.status).toBe(201);

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.reviews).toHaveLength(1);
		// Trimmed on the way in, so leading/trailing space never reaches a user.
		expect(list.reviews[0].body).toBe("the pacing is the thing — nothing overstays");
		expect(list.reviews[0].verdict).toBe("recommended");
		expect(list.reviews[0].handle).toBe(await handleOf(userAName));
	});
});

describe("Editing a review", () => {
	it("updates the verdict AND the text, not just the verdict", async () => {
		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
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
		const list = await readReviews(userA);
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
						sql`(SELECT id FROM users WHERE email = ${`${userAName}@example.com`})`,
					),
				),
			)
			.limit(1);
		await db.update(reviews).set({ moderationStatus: "hidden" }).where(eq(reviews.id, row.id));

		const res = await post(`/api/content/works/${workId}/reviews`, userA, {
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

describe("A verdict written without text", () => {
	it("counts in the aggregate and stays out of the list", async () => {
		// Insert the textless shape directly — the API writes NULL the same way now, and
		// this proves the READ side does not depend on how the row got there.
		const [user] = (await db.execute(
			sql`SELECT id FROM users WHERE email = ${`${userBName}@example.com`}`,
		)) as unknown as { id: number }[];
		await db.insert(reviews).values({ userId: user.id, workId, verdict: "recommended" });

		const list = await readReviews();
		expect(list.count).toBe(1);
		expect(list.recommendedPercent).toBe(100);
		// Nothing to read, so nothing in the list — the rule this suite exists for.
		expect(list.reviews).toHaveLength(0);
	});
});

describe("Helpfulness — reviews sort by it and are never weighted by it", () => {
	it("carries a floored net and the user's own vote on every review", async () => {
		// A textless review is not listed, so it is not what a reader can vote on. Give
		// this block a written review of its own: three fresh users vote on it — two up
		// and one down lands it at 1 — and the author's own upvote is absent because the
		// row is inserted directly rather than posted through the route.
		const voterNames = ["h_a", "h_b", "h_c"].map((n) => `rv_${n}_${id}`);
		const cookies: string[] = [];
		for (const name of voterNames) cookies.push(await signUp(name));

		const [reviewer] = (await db.execute(
			sql`SELECT id FROM users WHERE email = ${`rv_h_a_${id}@example.com`}`,
		)) as unknown as { id: number }[];
		const [subject] = await db
			.insert(reviews)
			.values({ userId: reviewer.id, workId, verdict: "recommended", body: "worth the hour" })
			.returning({ id: reviews.id });
		const reviewId = subject.id;
		expect(reviewId, "the written review id").toBeGreaterThan(0);

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
		expect(entry.userVote).toBeNull();
		expect(entry).not.toHaveProperty("up");
		expect(entry).not.toHaveProperty("down");

		// A voter sees their own; the aggregate is untouched — 100% recommended from two
		// visible verdicts (this written one and userB's textless one) however many votes
		// the written review draws.
		const asVoter = await readReviews(cookies[2]);
		expect(asVoter.reviews[0].userVote).toBe("down");
		expect(asVoter.recommendedPercent).toBe(100);
		expect(asVoter.count).toBe(2);

		// The reviewer sees the figures behind it — and so does every reader now: the
		// single-subject read serves the counts to whoever can see the thing (Parker,
		// 2026-10-16 — the numbers ride the buttons).
		for (const cookie of [_userB, cookies[0]]) {
			const other = await req(`/api/content/votes?subjectType=review&subjectId=${reviewId}`, {
				headers: { Cookie: cookie },
			});
			expect(other.status).toBe(200);
			const otherJson = await other.json();
			expect(otherJson).toHaveProperty("up");
			expect(otherJson).toHaveProperty("down");
		}
	});

	it("refuses a vote on a hidden review, which would be voting on something no user can see", async () => {
		// userA's review was hidden in the editing block above and is still there.
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
	// worth reading, so a new review starts at 1 and a 0 always means a user said no.
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
		expect(asAuthor.reviews.find((r) => r.id === reviewId)!.userVote).toBe("up");
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
	// A user-selectable window beside All Time (Parker, 2026-09-13): the same proportion
	// over only the reviews inside it, or null rather than 0 when the window is empty.
	it("computes over the chosen window and nowhere else", async () => {
		// userB's review above is "recommended" and is the only one we move. Everything
		// else on this Work was written this run and is recent by construction.
		const [bRow] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.innerJoin(users, eq(reviews.userId, users.id))
			.where(and(eq(reviews.workId, workId), eq(users.atprotoHandle, await handleOf(userBName))))
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

		// All Time unchanged — the move is a window matter, not a count matter. The
		// visible set is userB's textless verdict (recommended), this suite's written
		// review (recommended), and the two from the block above (1 of 2 recommended):
		// 3 of 4 = 75%, and the textless row counts here like any other.
		const all = await readReviews();
		expect(all.count).toBe(4);
		expect(all.recommendedPercent).toBe(75);

		// Over the month, only the three fresh rows count: 2 of 3 = 67%.
		const month = await readWindow("month");
		expect(month.window).toBe("month");
		expect(month.count).toBe(3);
		expect(month.recommendedPercent).toBe(67);

		// Over the year the moved row is back inside: 3 of 4 = 75%.
		const year = await readWindow("year");
		expect(year.count).toBe(4);
		expect(year.recommendedPercent).toBe(75);

		// The default when no window is asked for is the month.
		const defaultRes = await req(`/api/content/works/${workId}/reviews`);
		expect((await defaultRes.json()).recent.window).toBe("month");

		// And an unknown window is a bad request rather than a silent guess.
		expect((await req(`/api/content/works/${workId}/reviews?window=decade`)).status).toBe(400);

		// Put the row back so nothing after this suite reads a backdated fixture.
		await db.update(reviews).set({ createdAt: new Date() }).where(eq(reviews.id, bRow.id));
	});
});

describe("the record link beside a review", () => {
	it("is null while the review has no record — the ordinary case, never an error", async () => {
		const list = await readReviews();
		for (const review of list.reviews) expect(review.recordUrl ?? null).toBeNull();
	});

	it("is the record's own address on Taproot once a record exists, for any reader", async () => {
		// Every review of the fixture Work gets its own address (the column is unique),
		// keyed by the row's id so each entry in the list can be matched to it. The list
		// withholds hidden rows entirely (an earlier describe left one hidden) — a row
		// that does not render carries nothing, which is the shape any record link has.
		const rows = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(eq(reviews.workId, workId));
		const uriOf = (rowId: number) => `at://did:plc:${id}/${REVIEW_COLLECTION}/r${rowId}key`;
		for (const row of rows) {
			await db
				.update(reviews)
				.set({ atprotoUri: uriOf(row.id) })
				.where(eq(reviews.id, row.id));
		}
		try {
			// Signed out — the link is not the author's alone: the record is public no
			// matter who reads, so every reader who can see a review carries it.
			const list = await readReviews();
			expect(list.reviews.length).toBeGreaterThan(0);
			for (const review of list.reviews) {
				expect(review.recordUrl).toBe(`https://atproto.at/uri/${uriOf(review.id)}`);
			}
		} finally {
			await db.update(reviews).set({ atprotoUri: null }).where(eq(reviews.workId, workId));
		}
	});
});

describe("the owner's Works listing", () => {
	it("carries the Reviews column's counts, matching the public aggregate", async () => {
		// The Studio's table shows the net and the pair behind it in one cell, so the
		// owner's listing carries the same two numbers the Work page's aggregate counts —
		// textless verdicts included. The expected figures come from the rows rather than
		// from the public list, which deliberately omits the textless one; that difference
		// is the point, and it is asserted alongside.
		const [expected] = (await db.execute(
			sql`
				SELECT
					count(*) FILTER (WHERE verdict = 'recommended') AS recommended,
					count(*) FILTER (WHERE verdict <> 'recommended') AS not_recommended
				FROM reviews
				WHERE work_id = ${workId} AND moderation_status = 'visible'
			`,
		)) as unknown as { recommended: string; not_recommended: string }[];

		const publicList = await readReviews();
		expect(publicList.count).toBe(4);
		expect(publicList.reviews).toHaveLength(3);

		const res = await req("/api/content/works", {
			headers: { Cookie: creator, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const { works: rows } = (await res.json()) as {
			works: { id: number; reviewCounts?: { recommended: number; notRecommended: number } }[];
		};
		expect(rows.find((w) => w.id === workId)?.reviewCounts).toEqual({
			recommended: Number(expected.recommended),
			notRecommended: Number(expected.not_recommended),
		});
	});
});
