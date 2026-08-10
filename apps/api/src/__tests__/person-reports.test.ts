// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reporting a person — the third `subject_type`, and the shape 40.06 built for.
 *
 * The assertions that matter are the ones about what a person report is NOT:
 *
 * - **It is not hideable.** `users` carries no `moderation_status`, and hiding an
 *   account is suspension — which has to answer what becomes of their Works, their
 *   buyers' purchases, the Seeds pointed at them and any payout in flight. None of
 *   that is decided. So `hide` returns a legible 400 rather than a 500 from a missing
 *   column, and the queue item says `moderatable: false` so the console never offers
 *   a button that could only fail.
 * - **It is not a block.** Nothing here touches `user_blocks`; see `blocking.test.ts`.
 * - **It did not need a seventh reason code.** The six describe what is wrong and all
 *   six can be true of a person; what a person report needs is *where to look*, so
 *   `details` is required. That is an intake rule, and pinning it here is what keeps
 *   someone from "fixing" it by adding a reason instead — which would be a data
 *   migration dressed as a copy edit.
 *
 * The orphan case gets its own test because `users` is the row everything else
 * cascades FROM: a deleted account strands every report ABOUT it, and the queue and
 * its own headline count have to agree about that or the console shows work that
 * cannot be cleared.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { moderationActions, moderationReports, users } from "@anthers/db/schema";
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

interface QueueItem {
	subjectType: string;
	subjectId: number;
	excerpt: string;
	moderatable: boolean;
	openReports: number;
	reasons: string[];
	details: string[];
	author: { username: string } | null;
	context: { kind: string; slug: string; title: string } | null;
}

async function queue(cookie: string, filter: string) {
	const res = await req(`/api/admin/moderation?filter=${filter}`, { headers: { Cookie: cookie } });
	expect(res.status).toBe(200);
	return (await res.json()) as {
		items: QueueItem[];
		summary: { openReports: number; reportedPeople: number };
	};
}

const id = crypto.randomUUID().slice(0, 8);
const adminName = `pr_admin_${id}`;
const reporterName = `pr_reporter_${id}`;
const subjectName = `pr_subject_${id}`;
/** Reported, then deleted — the orphan case. */
const ghostName = `pr_ghost_${id}`;

let admin: string;
let reporter: string;
let subjectId: number;
let ghostId: number;
/** A comment by the subject — the contrast case for the details rule. */
let commentId: number;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${adminName}, ${reporterName}, ${subjectName}, ${ghostName})`,
	);
	admin = await signUp(adminName);
	reporter = await signUp(reporterName);
	const subject = await signUp(subjectName);
	await signUp(ghostName);
	await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${adminName}`);
	await db.execute(
		sql`UPDATE users SET display_name = 'Subject Person', bio = 'a bio line' WHERE username = ${subjectName}`,
	);

	const [s] = await db.select({ id: users.id }).from(users).where(eq(users.username, subjectName));
	const [g] = await db.select({ id: users.id }).from(users).where(eq(users.username, ghostName));
	subjectId = s.id;
	ghostId = g.id;

	const postRes = await post("/api/content/posts", admin, {
		title: `Person report fixture ${id}`,
		isPublished: true,
	});
	expect(postRes.status).toBe(201);
	const slug = (await postRes.json()).post.slug;
	const commentRes = await post(`/api/content/posts/${slug}/comments`, subject, {
		body: `something to report ${id}`,
	});
	expect(commentRes.status).toBe(201);
	commentId = (await commentRes.json()).comment.id;
}, DB_SETUP_TIMEOUT);

/** Distinct people currently in the `people` queue — what the headline count must equal. */
function peopleInQueue(items: QueueItem[]): number {
	return new Set(items.filter((i) => i.subjectType === "user").map((i) => i.subjectId)).size;
}

describe("filing a report about a person", () => {
	it("requires details, because a person is not its own evidence", async () => {
		const bare = await post("/api/moderation/reports", reporter, {
			subjectType: "user",
			subjectId,
			reason: "harassment",
		});
		expect(bare.status).toBe(400);
		expect(((await bare.json()) as { code?: string }).code).toBe("details_required");

		// Whitespace is not detail.
		const blank = await post("/api/moderation/reports", reporter, {
			subjectType: "user",
			subjectId,
			reason: "harassment",
			details: "   ",
		});
		expect(blank.status).toBe(400);

		// The same reason against a COMMENT needs no details — a comment is the artifact,
		// and an operator opens it and sees what the reporter saw. Asserting the contrast
		// here is the point: it is what shows the rule is about the *subject type*, not
		// about `harassment` reports being special, which is what a seventh reason code
		// would have implied.
		const onComment = await post("/api/moderation/reports", reporter, {
			subjectType: "comment",
			subjectId: commentId,
			reason: "harassment",
		});
		expect(onComment.status).toBe(201);
	});

	it("accepts a report with details, and refuses a self-report", async () => {
		const good = await post("/api/moderation/reports", reporter, {
			subjectType: "user",
			subjectId,
			reason: "harassment",
			details: `following me across threads ${id}`,
		});
		expect(good.status).toBe(201);

		const [row] = await db
			.select({ reason: moderationReports.reason, details: moderationReports.details })
			.from(moderationReports)
			.where(
				and(eq(moderationReports.subjectType, "user"), eq(moderationReports.subjectId, subjectId)),
			);
		expect(row.reason).toBe("harassment");
		expect(row.details).toContain("across threads");

		// Self-reporting is allowed for a comment (the only way an author can ask for
		// their own words down) and meaningless for a person.
		const [me] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, reporterName));
		const self = await post("/api/moderation/reports", reporter, {
			subjectType: "user",
			subjectId: me.id,
			reason: "spam",
			details: "me",
		});
		expect(self.status).toBe(400);
	});

	it("404s a report about an account that does not exist", async () => {
		const res = await post("/api/moderation/reports", reporter, {
			subjectType: "user",
			subjectId: 999_999_999,
			reason: "spam",
			details: "nobody",
		});
		expect(res.status).toBe(404);
	});
});

describe("the person report in the operator queue", () => {
	it("appears under the people filter, with the profile as its context", async () => {
		expect(
			(
				await post("/api/moderation/reports", reporter, {
					subjectType: "user",
					subjectId,
					reason: "harassment",
					details: `following me across threads ${id}`,
				})
			).status,
		).toBe(201);

		const { items, summary } = await queue(admin, "people");
		const item = items.find((i) => i.subjectType === "user" && i.subjectId === subjectId);
		expect(item).toBeDefined();
		expect(item!.openReports).toBeGreaterThan(0);
		expect(item!.reasons).toContain("harassment");
		// The reporter's own words are the evidence for this subject type, so they have
		// to reach the operator — a queue entry without them is unactionable.
		expect(item!.details.join(" ")).toContain("across threads");
		// The subject IS the author: a person's report is about them, not about
		// something of theirs.
		expect(item!.author?.username).toBe(subjectName);
		expect(item!.context).toEqual({
			kind: "profile",
			slug: subjectName,
			title: `Subject Person (@${subjectName})`,
		});
		expect(item!.excerpt).toContain("a bio line");
		expect(summary.reportedPeople).toBeGreaterThan(0);
	});

	it("marks the person NOT moderatable, and hide/restore refuse with a legible 400", async () => {
		const { items } = await queue(admin, "people");
		const item = items.find((i) => i.subjectId === subjectId)!;

		// The console reads this to decide whether to render the button at all.
		expect(item.moderatable).toBe(false);

		for (const action of ["hide", "restore"]) {
			const res = await post(`/api/admin/moderation/${action}`, admin, {
				subjectType: "user",
				subjectId,
				...(action === "hide" ? { reason: "harassment" } : {}),
			});
			// A 400 with a reason, not a 500 from a column that isn't there. Suspending an
			// account is a product decision that hasn't been made; saying so is the honest
			// answer, and stubbing it into something that half-works is not.
			expect(res.status).toBe(400);
			expect(((await res.json()) as { code?: string }).code).toBe("not_moderatable");
		}

		// And nothing was logged — a refused action is not a decision.
		const logged = await db
			.select({ id: moderationActions.id })
			.from(moderationActions)
			.where(
				and(eq(moderationActions.subjectType, "user"), eq(moderationActions.subjectId, subjectId)),
			);
		expect(logged).toEqual([]);
	});

	it("dismiss is the one outcome available, and it clears the entry", async () => {
		const res = await post("/api/admin/moderation/dismiss", admin, {
			subjectType: "user",
			subjectId,
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { dismissed: number }).dismissed).toBeGreaterThan(0);

		const { items } = await queue(admin, "people");
		expect(items.find((i) => i.subjectId === subjectId)).toBeUndefined();
	});

	it("also surfaces in the mixed reported queue, not only under people", async () => {
		expect(
			(
				await post("/api/moderation/reports", reporter, {
					subjectType: "user",
					subjectId,
					reason: "spam",
					details: `bulk-DMing links ${id}`,
				})
			).status,
		).toBe(201);

		const { items } = await queue(admin, "reported");
		expect(items.some((i) => i.subjectType === "user" && i.subjectId === subjectId)).toBe(true);
	});
});

describe("a deleted account strands its reports, and the queue has to agree", () => {
	it("drops the orphan from BOTH the queue and the headline count", async () => {
		expect(
			(
				await post("/api/moderation/reports", reporter, {
					subjectType: "user",
					subjectId: ghostId,
					reason: "spam",
					details: `ghost report ${id}`,
				})
			).status,
		).toBe(201);

		const before = await queue(admin, "people");
		expect(before.items.some((i) => i.subjectId === ghostId)).toBe(true);

		// `users` is the row everything else cascades FROM. The report survives — both
		// its users FKs are `set null` on purpose, because a moderation record has to
		// outlive the account it concerns — so the SUBJECT side, which has no FK at all,
		// is left pointing at nothing.
		await db.delete(users).where(eq(users.id, ghostId));

		const surviving = await db
			.select({ id: moderationReports.id })
			.from(moderationReports)
			.where(
				and(eq(moderationReports.subjectType, "user"), eq(moderationReports.subjectId, ghostId)),
			);
		expect(surviving.length).toBeGreaterThan(0);

		// The queue and its own count must drop it together. Filtering only one of them
		// is what makes the console insist there is work over an empty list, with no way
		// to clear it — the exact defect the comment/rating orphan filter was added for.
		//
		// Asserted as the invariant "the count equals what the queue shows" rather than
		// as a decrement, because both are global figures: an exact before/after
		// subtraction would be a false failure the first time another suite files a
		// person report while this one runs.
		const after = await queue(admin, "people");
		expect(after.items.some((i) => i.subjectId === ghostId)).toBe(false);
		expect(after.summary.reportedPeople).toBe(peopleInQueue(after.items));
		expect(before.summary.reportedPeople).toBe(peopleInQueue(before.items));
	});
});
