// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The moderation surface, end to end: report → queue → hide → recorded removal.
 *
 * The assertion this file exists for is the one the whole design rests on:
 * **hiding is a state transition, not a delete.** So every "it's gone" check is
 * paired with a direct SELECT proving the row is still in the table with its
 * author and its text intact — a suite that only checked the API response would
 * pass just as happily against a `DELETE`, and that implementation would cost a
 * migration to undo.
 *
 * Also covered: the gate (a non-admin gets 404, not 403, same as the rest of the
 * console), that hiding reaches every public read of the content — the comment
 * list, the ratings endpoint's aggregate, and the aggregate embedded in post
 * detail — that re-rating can't resurrect a hidden rating, and that a restore is
 * a NEW log row rather than an edit to the hide it reverses.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, moderationActions, moderationReports, ratings } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";

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
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

interface QueueItem {
	subjectType: string;
	subjectId: number;
	excerpt: string;
	moderationStatus: string;
	openReports: number;
	totalReports: number;
	reasons: string[];
	details: string[];
	author: { username: string } | null;
	context: { kind: "post" | "work"; slug: string } | null;
	lastAction: { action: string; reason: string; actor: string | null } | null;
}

async function queue(cookie: string, filter: string) {
	const res = await req(`/api/admin/moderation?filter=${filter}`, { headers: { Cookie: cookie } });
	expect(res.status).toBe(200);
	return (await res.json()) as {
		filter: string;
		items: QueueItem[];
		summary: { openReports: number; hiddenComments: number; hiddenRatings: number };
	};
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `mod_creator_${id}`;
const adminName = `mod_admin_${id}`;
const viewerAName = `mod_a_${id}`;
const viewerBName = `mod_b_${id}`;
const FREE = [{ threshold: 0, allow: true, price: "0" }];

let creator: string;
let admin: string;
let viewerA: string;
let viewerB: string;
let slug: string;
let workId: number;
/** viewerA's comment — the one we report and hide. */
let commentId: number;
/** viewerB's comment — the control that must stay visible throughout. */
let otherCommentId: number;
let ratingId: number;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${adminName}, ${viewerAName}, ${viewerBName})`,
	);
	creator = await signUp(creatorName);
	admin = await signUp(adminName);
	viewerA = await signUp(viewerAName);
	viewerB = await signUp(viewerBName);
	await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${adminName}`);

	const itemRes = await post("/api/content/works", creator, {
		type: "game",
		title: `Mod fixture ${id}`,
	});
	expect(itemRes.status).toBe(201);
	workId = (await itemRes.json()).work.id;

	const postRes = await post("/api/content/posts", creator, {
		title: `Moderated post ${id}`,
		workIds: [workId],
		isPublished: true,
	});
	expect(postRes.status).toBe(201);
	slug = (await postRes.json()).post.slug;

	// Reviewing requires access, so the fixture Work has to be released and open.
	const release = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator },
		body: JSON.stringify({
			visibility: "released",
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(release.status).toBe(200);

	const c1 = await post(`/api/content/posts/${slug}/comments`, viewerA, {
		body: "buy cheap followers at example.com",
	});
	expect(c1.status).toBe(201);
	commentId = (await c1.json()).comment.id;

	const c2 = await post(`/api/content/posts/${slug}/comments`, viewerB, {
		body: "genuinely enjoyed this",
	});
	expect(c2.status).toBe(201);
	otherCommentId = (await c2.json()).comment.id;

	// Two ratings: 1 star from A (the one we'll hide), 5 stars from B.
	const r1 = await post(`/api/content/works/${workId}/ratings`, viewerA, {
		score: 1,
		body: "did not work for me at all",
	});
	expect(r1.status).toBe(201);
	ratingId = (await r1.json()).rating.id;
	expect(
		(
			await post(`/api/content/works/${workId}/ratings`, viewerB, {
				score: 5,
				body: "one of the best things I have played this year",
			})
		).status,
	).toBe(201);
});

describe("Filing a report", () => {
	it("requires a session", async () => {
		const res = await req("/api/moderation/reports", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ subjectType: "comment", subjectId: commentId, reason: "spam" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects a reason outside the taxonomy", async () => {
		const res = await post("/api/moderation/reports", viewerB, {
			subjectType: "comment",
			subjectId: commentId,
			reason: "i-just-disagree",
		});
		expect(res.status).toBe(400);
	});

	it("rejects an unknown subject type", async () => {
		const res = await post("/api/moderation/reports", viewerB, {
			subjectType: "post",
			subjectId: 1,
			reason: "spam",
		});
		expect(res.status).toBe(400);
	});

	it("404s a subject that doesn't exist rather than queueing a report about nothing", async () => {
		const res = await post("/api/moderation/reports", viewerB, {
			subjectType: "comment",
			subjectId: 2_000_000_000,
			reason: "spam",
		});
		expect(res.status).toBe(404);
	});

	it("accepts a report from a signed-in user", async () => {
		const res = await post("/api/moderation/reports", viewerB, {
			subjectType: "comment",
			subjectId: commentId,
			reason: "spam",
			details: "links to a follower farm",
		});
		expect(res.status).toBe(201);
		expect((await res.json()).reported).toBe(true);
	});

	it("is idempotent per reporter — re-reporting updates, it doesn't stack", async () => {
		const res = await post("/api/moderation/reports", viewerB, {
			subjectType: "comment",
			subjectId: commentId,
			reason: "harassment",
		});
		expect(res.status).toBe(201);

		const rows = await db
			.select({ id: moderationReports.id, reason: moderationReports.reason })
			.from(moderationReports)
			.where(
				and(
					eq(moderationReports.subjectType, "comment"),
					eq(moderationReports.subjectId, commentId),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0].reason).toBe("harassment");
	});
});

describe("Queue gating", () => {
	it("401s an unauthenticated caller", async () => {
		expect((await req("/api/admin/moderation")).status).toBe(401);
	});

	it("404s a signed-in non-admin — the surface isn't advertised", async () => {
		const res = await req("/api/admin/moderation", { headers: { Cookie: viewerB } });
		expect(res.status).toBe(404);
	});

	it("404s a non-admin on the mutating routes too", async () => {
		const res = await post("/api/admin/moderation/hide", viewerB, {
			subjectType: "comment",
			subjectId: commentId,
			reason: "spam",
		});
		expect(res.status).toBe(404);
	});
});

describe("The operator queue", () => {
	it("shows the reported comment with its reporters, reason and context", async () => {
		const { items, summary } = await queue(admin, "reported");
		const entry = items.find((i) => i.subjectType === "comment" && i.subjectId === commentId);
		expect(entry).toBeDefined();
		expect(entry?.excerpt).toContain("cheap followers");
		expect(entry?.openReports).toBe(1);
		expect(entry?.reasons).toContain("harassment");
		expect(entry?.author?.username).toBe(viewerAName);
		// The queue names WHERE the item lives, and that is no longer always a post — so
		// the context carries its kind. A comment on a post reads as one.
		expect(entry?.context?.kind).toBe("post");
		expect(entry?.context?.slug).toBe(slug);
		expect(entry?.moderationStatus).toBe("visible");
		expect(summary.openReports).toBeGreaterThanOrEqual(1);
	});

	it("lists reviews nobody reported, so an operator can act before anyone complains", async () => {
		const { items } = await queue(admin, "ratings");
		const entry = items.find((i) => i.subjectId === ratingId && i.subjectType === "rating");
		expect(entry).toBeDefined();
		expect(entry?.excerpt).toBe("1/5 — did not work for me at all");
		expect(entry?.openReports).toBe(0);
	});
});

describe("Hiding a comment", () => {
	it("records the decision and flips the row's state", async () => {
		const res = await post("/api/admin/moderation/hide", admin, {
			subjectType: "comment",
			subjectId: commentId,
			reason: "spam",
			note: "follower farm",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("hidden");

		const actions = await db
			.select()
			.from(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "comment"),
					eq(moderationActions.subjectId, commentId),
				),
			);
		expect(actions).toHaveLength(1);
		expect(actions[0].action).toBe("hide");
		expect(actions[0].reason).toBe("spam");
		expect(actions[0].note).toBe("follower farm");
		expect(actions[0].actorRole).toBe("operator");
		expect(actions[0].actorId).toBeGreaterThan(0);
	});

	// The load-bearing assertion. Everything else in this file would also pass
	// against an implementation that deleted the row.
	it("leaves the row — author, text and timestamp — intact in the table", async () => {
		const [row] = await db.select().from(comments).where(eq(comments.id, commentId));
		expect(row).toBeDefined();
		expect(row.body).toBe("buy cheap followers at example.com");
		expect(row.userId).toBeGreaterThan(0);
		expect(row.createdAt).toBeInstanceOf(Date);
		expect(row.moderationStatus).toBe("hidden");
	});

	it("withholds it from the public comment list, leaving everyone else's", async () => {
		const res = await req(`/api/content/posts/${slug}/comments`);
		expect(res.status).toBe(200);
		const ids = ((await res.json()).comments as { id: number }[]).map((c) => c.id);
		expect(ids).not.toContain(commentId);
		expect(ids).toContain(otherCommentId);
	});

	it("hides it from its own author too — hidden is hidden", async () => {
		const res = await req(`/api/content/posts/${slug}/comments`, { headers: { Cookie: viewerA } });
		const ids = ((await res.json()).comments as { id: number }[]).map((c) => c.id);
		expect(ids).not.toContain(commentId);
	});

	it("resolves the open reports it answers, so the queue doesn't re-serve them", async () => {
		const { items } = await queue(admin, "reported");
		expect(
			items.find((i) => i.subjectType === "comment" && i.subjectId === commentId),
		).toBeUndefined();

		const [report] = await db
			.select()
			.from(moderationReports)
			.where(
				and(
					eq(moderationReports.subjectType, "comment"),
					eq(moderationReports.subjectId, commentId),
				),
			);
		expect(report.status).toBe("resolved");
		expect(report.resolvedAt).toBeInstanceOf(Date);
	});

	it("surfaces it under the hidden filter, with who hid it and why", async () => {
		const { items, summary } = await queue(admin, "hidden");
		const entry = items.find((i) => i.subjectType === "comment" && i.subjectId === commentId);
		expect(entry).toBeDefined();
		expect(entry?.lastAction?.action).toBe("hide");
		expect(entry?.lastAction?.reason).toBe("spam");
		expect(entry?.lastAction?.actor).toBe(adminName);
		expect(summary.hiddenComments).toBeGreaterThanOrEqual(1);
	});
});

describe("Hiding a rating", () => {
	it("drops it out of the aggregate on the ratings endpoint", async () => {
		const before = await (await req(`/api/content/works/${workId}/ratings`)).json();
		expect(before.count).toBe(2);
		expect(before.average).toBe(3); // (1 + 5) / 2

		const res = await post("/api/admin/moderation/hide", admin, {
			subjectType: "rating",
			subjectId: ratingId,
			reason: "spam",
		});
		expect(res.status).toBe(200);

		const after = await (await req(`/api/content/works/${workId}/ratings`)).json();
		expect(after.count).toBe(1);
		expect(after.average).toBe(5);
	});

	it("has no second aggregate to leak through — post detail carries none", async () => {
		// There used to be TWO places computing this: the ratings endpoint and an aggregate
		// embedded in post detail, and forgetting the moderation filter at either one was a
		// live hazard the Agents Hub called out by name. A review is a verdict on a WORK, so
		// post detail carries no aggregate at all now and the second site is gone rather
		// than merely being remembered about.
		const res = await req(`/api/content/posts/${slug}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.post.ratingCount).toBeUndefined();
		expect(body.post.ratingAverage).toBeUndefined();
	});

	it("still shows the author their own score rather than lying about it", async () => {
		const res = await req(`/api/content/works/${workId}/ratings`, { headers: { Cookie: viewerA } });
		expect((await res.json()).userRating).toBe(1);
	});

	it("cannot be resurrected by re-rating — the upsert only touches the score", async () => {
		const res = await post(`/api/content/works/${workId}/ratings`, viewerA, {
			score: 4,
			body: "came back to it and warmed up considerably",
		});
		expect(res.status).toBe(201);

		const [row] = await db.select().from(ratings).where(eq(ratings.id, ratingId));
		expect(row.score).toBe(4);
		expect(row.moderationStatus).toBe("hidden");

		const agg = await (await req(`/api/content/works/${workId}/ratings`)).json();
		expect(agg.count).toBe(1);
		expect(agg.average).toBe(5);
	});
});

describe("Restoring", () => {
	it("puts the comment back and appends a NEW action rather than editing the hide", async () => {
		const res = await post("/api/admin/moderation/restore", admin, {
			subjectType: "comment",
			subjectId: commentId,
			note: "reviewed, it stays",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("visible");

		const list = await (await req(`/api/content/posts/${slug}/comments`)).json();
		expect((list.comments as { id: number }[]).map((c) => c.id)).toContain(commentId);

		// Two rows now: the hide and the restore. The history reads as the sequence
		// of decisions actually taken, including the reversed one.
		const actions = await db
			.select()
			.from(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "comment"),
					eq(moderationActions.subjectId, commentId),
				),
			);
		expect(actions).toHaveLength(2);
		expect(actions.map((a) => a.action).sort()).toEqual(["hide", "restore"]);
	});

	it("404s a subject that doesn't exist", async () => {
		const res = await post("/api/admin/moderation/restore", admin, {
			subjectType: "comment",
			subjectId: 2_000_000_000,
		});
		expect(res.status).toBe(404);
	});
});

describe("A report whose subject is gone", () => {
	it("counts for nothing, so the console can't show reports over an empty queue", async () => {
		// Reports are polymorphic and carry no FK, so deleting a post (which cascades
		// its comments away) strands them. The queue hydrates from the content tables
		// and drops orphans; the summary has to agree, or an operator sees a count
		// they have no way to clear.
		const doomed = await post(`/api/content/posts/${slug}/comments`, viewerB, {
			body: "about to be cascaded away",
		});
		const doomedId = (await doomed.json()).comment.id;
		expect(
			(
				await post("/api/moderation/reports", viewerA, {
					subjectType: "comment",
					subjectId: doomedId,
					reason: "spam",
				})
			).status,
		).toBe(201);

		const before = await queue(admin, "reported");
		expect(before.summary.openReports).toBeGreaterThanOrEqual(1);

		await db.delete(comments).where(eq(comments.id, doomedId));

		const after = await queue(admin, "reported");
		expect(
			after.items.find((i) => i.subjectType === "comment" && i.subjectId === doomedId),
		).toBeUndefined();
		expect(after.summary.openReports).toBe(before.summary.openReports - 1);

		// The report row itself survives — it's a record, not a cache of the content.
		const rows = await db
			.select()
			.from(moderationReports)
			.where(
				and(
					eq(moderationReports.subjectType, "comment"),
					eq(moderationReports.subjectId, doomedId),
				),
			);
		expect(rows).toHaveLength(1);
	});
});

describe("Dismissing a report", () => {
	it("clears the queue entry without touching the content", async () => {
		const filed = await post("/api/moderation/reports", viewerA, {
			subjectType: "comment",
			subjectId: otherCommentId,
			reason: "other",
			details: "i don't like it",
		});
		expect(filed.status).toBe(201);

		const before = await queue(admin, "reported");
		expect(
			before.items.find((i) => i.subjectType === "comment" && i.subjectId === otherCommentId),
		).toBeDefined();

		const res = await post("/api/admin/moderation/dismiss", admin, {
			subjectType: "comment",
			subjectId: otherCommentId,
		});
		expect(res.status).toBe(200);
		expect((await res.json()).dismissed).toBe(1);

		const after = await queue(admin, "reported");
		expect(
			after.items.find((i) => i.subjectType === "comment" && i.subjectId === otherCommentId),
		).toBeUndefined();

		// The comment is untouched — dismissing is "I looked, it's fine", and it has
		// to be distinct from hiding or the only way to empty the queue is takedowns.
		const [row] = await db.select().from(comments).where(eq(comments.id, otherCommentId));
		expect(row.moderationStatus).toBe("visible");
	});
});
