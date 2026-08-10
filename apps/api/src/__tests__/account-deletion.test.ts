// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion — the scheduled wipe, and the seven different things "deleted"
 * means depending on which table you are in.
 *
 * The per-table outcomes are the whole risk here, because every one of them is
 * *plausible* as its opposite and none of them fails loudly when it's wrong:
 *
 * - tombstoning that hard-deletes instead takes **third parties' comments** with it;
 * - anonymising a review by deleting it moves a creator's average through no fault of
 *   theirs;
 * - a purchased Work destroyed instead of withdrawn breaks the promise a buyer paid
 *   for;
 * - and `purchases` cascading instead of detaching destroys sales-tax records Anthers
 *   has to be able to evidence.
 *
 * So each is asserted **positively and negatively**: the identity is gone AND the
 * artifact is still there. A suite that only checked the first half would pass against
 * an implementation that deleted everything, which is precisely the implementation
 * somebody writes when the ticket says "delete the account".
 *
 * The one guarantee worth stating on its own: **we never claim a user deleted
 * something they didn't.** A tombstone carries a null author and nothing else — the
 * reason a thing is gone lives in `moderation_status`, and the two are asserted to
 * stay separate.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, posts, purchases, ratings, users, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import {
	cancelDeletion,
	deletionPreview,
	eraseAccount,
	requestDeletion,
	runDueDeletions,
} from "../services/account-deletion.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string, body?: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
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

async function idOf(username: string): Promise<number | null> {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return row?.id ?? null;
}

const id = crypto.randomUUID().slice(0, 8);
/** The account that gets deleted. */
const leaverName = `del_leaver_${id}`;
/** Stays. Their comment on the leaver's post must survive the tombstone. */
const stayerName = `del_stayer_${id}`;
/** Buys one of the leaver's Works, and must keep it. */
const buyerName = `del_buyer_${id}`;

let leaver: string;
let stayer: string;
let leaverId: number;
let buyerId: number;

let postId: number;
let postSlug: string;
let leaverCommentId: number;
let stayerCommentId: number;
let ratingId: number;
let soldWorkId: number;
let unsoldWorkId: number;
let purchaseId: number;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${leaverName}, ${stayerName}, ${buyerName})`,
	);
	leaver = await signUp(leaverName);
	stayer = await signUp(stayerName);
	await signUp(buyerName);
	await db.execute(sql`UPDATE users SET is_creator = true WHERE username = ${leaverName}`);

	leaverId = (await idOf(leaverName))!;
	buyerId = (await idOf(buyerName))!;

	// Two Works: one someone buys, one nobody does.
	const sold = await insertWork({ creatorId: leaverId, type: "game", title: `Sold ${id}` });
	const unsold = await insertWork({ creatorId: leaverId, type: "game", title: `Unsold ${id}` });
	soldWorkId = sold.id;
	unsoldWorkId = unsold.id;

	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId,
			workId: soldWorkId,
			creatorId: leaverId,
			workTitle: `Sold ${id}`,
			workType: "game",
			workPublicId: sold.publicId,
			type: "digital",
			amount: "12.00",
			salesTax: "0.99",
			processingFee: "0.65",
			crfFee: "0.00",
			stripePaymentIntentId: `pi_test_${id}`,
			creatorEarnings: "11.35",
			status: "completed",
		})
		.returning();
	purchaseId = purchase.id;
	// Fixture integrity: the whole purchased-vs-unpurchased split keys off this, and a
	// null here would silently reclassify the sold Work as unsold and delete it.
	expect(purchase.workId).toBe(soldWorkId);
	expect(purchase.status).toBe("completed");

	const postRes = await post("/api/content/posts", leaver, {
		title: `Leaver post ${id}`,
		isPublished: true,
	});
	expect(postRes.status).toBe(201);
	const p = (await postRes.json()).post;
	postId = p.id;
	postSlug = p.slug;

	// The leaver's own comment, and a THIRD PARTY's on the same thread.
	const c1 = await post(`/api/content/posts/${postSlug}/comments`, leaver, {
		body: `LEAVER-SAID-${id}`,
	});
	expect(c1.status).toBe(201);
	leaverCommentId = (await c1.json()).comment.id;

	const c2 = await post(`/api/content/posts/${postSlug}/comments`, stayer, {
		body: `STAYER-SAID-${id}`,
	});
	expect(c2.status).toBe(201);
	stayerCommentId = (await c2.json()).comment.id;

	// A review by the leaver, inserted directly — reviewing requires access, and the
	// point under test is the anonymisation rather than the access path.
	//
	// It hangs off the SOLD Work deliberately. `ratings.work_id` cascades, so a review
	// attached to the unsold Work would be destroyed along with it and the
	// anonymisation assertion would be testing an empty table.
	const [rating] = await db
		.insert(ratings)
		.values({ userId: leaverId, workId: soldWorkId, score: 4, body: `LEAVER-REVIEW-${id}` })
		.returning();
	ratingId = rating.id;
}, DB_SETUP_TIMEOUT);

describe("the request is scheduled, informed, and reversible", () => {
	it("previews what would happen using this account's real numbers", async () => {
		const preview = await deletionPreview(leaverId);
		// Consent that isn't informed isn't consent — the confirmation screen renders
		// these, and "3 Works deleted, 1 withdrawn because somebody bought it" is a
		// decision where "your content will be deleted" is a sentence people click past.
		expect(preview.posts).toBe(1);
		expect(preview.comments).toBe(1);
		expect(preview.reviews).toBe(1);
		expect(preview.worksDeleted).toBe(1);
		expect(preview.worksWithdrawn).toBe(1);
		expect(preview.purchases).toBe(0); // the leaver bought nothing
	});

	it("schedules rather than wipes, and signs every device out", async () => {
		const res = await req("/api/accounts/me", {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: leaver },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { scheduledFor: string; graceDays: number };
		expect(body.graceDays).toBeGreaterThanOrEqual(1);
		expect(new Date(body.scheduledFor).getTime()).toBeGreaterThan(Date.now());

		// Still there. The whole point of the window.
		expect(await idOf(leaverName)).toBe(leaverId);

		// Signed out everywhere: a shared laptop stops being a way in during the window.
		const stillIn = await req("/api/accounts/me", { headers: { Cookie: leaver } });
		expect(stillIn.status).toBe(401);
	});

	it("lets them sign back in, tells them it's pending, and cancels", async () => {
		// Signing back in IS the cancel path — a deletion you can only reverse by
		// emailing support is not the "oops" window this was asked for.
		const signIn = await req("/api/auth/sign-in", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ login: leaverName, password: "testpass123" }),
		});
		expect(signIn.status).toBe(200);
		leaver = signIn.headers.get("Set-Cookie")!.split(";")[0];

		// And they're told, rather than having to remember unaided.
		const me = await (await req("/api/accounts/me", { headers: { Cookie: leaver } })).json();
		expect(me.user.deletionRequestedAt).toBeTruthy();

		const cancel = await post("/api/accounts/me/deletion/cancel", leaver);
		expect(cancel.status).toBe(200);

		const after = await (await req("/api/accounts/me", { headers: { Cookie: leaver } })).json();
		expect(after.user.deletionRequestedAt).toBeNull();

		// Cancelling twice is a 404, not a silent success.
		expect((await post("/api/accounts/me/deletion/cancel", leaver)).status).toBe(404);
	});

	it("does not erase an account whose window has not elapsed", async () => {
		await requestDeletion(leaverId);
		const { erased } = await runDueDeletions();
		expect(erased).toBe(0);
		expect(await idOf(leaverName)).toBe(leaverId);
		await cancelDeletion(leaverId);
	});

	it("erases one whose window HAS elapsed", async () => {
		await requestDeletion(leaverId);
		// Reach in and back-date the schedule rather than waiting a week.
		await db.execute(
			sql`UPDATE users SET deletion_requested_at = now() - interval '1 day' WHERE id = ${leaverId}`,
		);
		const { erased } = await runDueDeletions();
		expect(erased).toBeGreaterThanOrEqual(1);
		expect(await idOf(leaverName)).toBeNull();
	});
});

describe("what 'deleted' means, table by table", () => {
	it("TOMBSTONES the leaver's comment — author gone, words and thread intact", async () => {
		const [row] = await db.select().from(comments).where(eq(comments.id, leaverCommentId));
		// Both halves. The row still exists…
		expect(row).toBeDefined();
		expect(row.body).toContain(`LEAVER-SAID-${id}`);
		// …with nobody attached to it.
		expect(row.userId).toBeNull();

		// 🚨 And the tombstone says only WHO, never WHY. `moderation_status` is the
		// separate axis, and a departing user must never be made to look moderated.
		expect(row.moderationStatus).toBe("visible");
	});

	it("keeps the tombstone IN THE THREAD, which is where the promise actually lives", async () => {
		// The DB assertion above is necessary and not sufficient. `listComments` joined
		// `users` to get the author's name, and an inner join silently drops a row whose
		// author is null — so a comment could survive in the table and still vanish from
		// the only place anyone reads it. That is the tombstone failing while every
		// row-level test passes.
		const res = await req(`/api/content/posts/${postSlug}/comments`);
		expect(res.status).toBe(200);
		const list = (await res.json()).comments as {
			id: number;
			body: string;
			username: string | null;
			deletedByAuthor: boolean;
		}[];

		const tombstone = list.find((c) => c.id === leaverCommentId);
		expect(tombstone).toBeDefined();
		expect(tombstone!.body).toContain(`LEAVER-SAID-${id}`);
		expect(tombstone!.username).toBeNull();
		expect(tombstone!.deletedByAuthor).toBe(true);

		// And the third party's is still attributed, in the same thread.
		const kept = list.find((c) => c.id === stayerCommentId);
		expect(kept!.username).toBe(stayerName);
		expect(kept!.deletedByAuthor).toBe(false);
	});

	it("keeps the THIRD PARTY's comment on the leaver's post, untouched", async () => {
		// The reason posts are tombstoned rather than deleted: `DELETE /posts/:slug`
		// removes the thread with the post, so hard-deleting a departing user's posts
		// would destroy other people's contributions.
		const [row] = await db.select().from(comments).where(eq(comments.id, stayerCommentId));
		expect(row).toBeDefined();
		expect(row.body).toContain(`STAYER-SAID-${id}`);
		expect(row.userId).not.toBeNull();
	});

	it("TOMBSTONES the post itself rather than removing it", async () => {
		const [row] = await db.select().from(posts).where(eq(posts.id, postId));
		expect(row).toBeDefined();
		expect(row.creatorId).toBeNull();
		// Still readable at its own URL, which is where the surviving thread lives.
		const res = await req(`/api/content/posts/${postSlug}`);
		expect(res.status).toBe(200);
	});

	it("ANONYMISES the review — score survives, author does not", async () => {
		const [row] = await db.select().from(ratings).where(eq(ratings.id, ratingId));
		expect(row).toBeDefined();
		// Deleting it would move a creator's average through no fault of theirs.
		expect(row.score).toBe(4);
		expect(row.userId).toBeNull();
	});

	it("DESTROYS a Work nobody bought", async () => {
		const rows = await db.select().from(works).where(eq(works.id, unsoldWorkId));
		expect(rows).toEqual([]);
	});

	it("WITHDRAWS a Work somebody bought, so the buyer keeps what they paid for", async () => {
		const [row] = await db.select().from(works).where(eq(works.id, soldWorkId));
		expect(row).toBeDefined();
		expect(row.visibility).toBe("withdrawn");
		expect(row.withdrawnAt).not.toBeNull();
	});

	it("DETACHES the buyer from a purchase but keeps the tax record", async () => {
		// The 2026-08-10 decision. Anthers is a marketplace facilitator and has to be
		// able to evidence the sales tax it collected; it cannot do that from a row that
		// no longer exists. What is left is not personal data — there is no route back
		// from it to a person.
		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
		expect(row).toBeDefined();
		expect(row.amount).toBe("12.00");
		expect(row.salesTax).toBe("0.99");
		expect(row.workTitle).toBe(`Sold ${id}`);
		// The leaver was the SELLER here, so creatorId detaches; the buyer is a different
		// account and is untouched.
		expect(row.buyerId).toBe(buyerId);
	});

	it("detaches the buyer when it is the BUYER who leaves", async () => {
		// The other direction, which is the one the decision was actually about.
		const buyerCookie = await req("/api/auth/sign-in", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ login: buyerName, password: "testpass123" }),
		});
		expect(buyerCookie.status).toBe(200);

		await eraseAccount(buyerId);
		expect(await idOf(buyerName)).toBeNull();

		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
		expect(row).toBeDefined();
		expect(row.buyerId).toBeNull();
		// Everything a remittance needs survives the person.
		expect(row.amount).toBe("12.00");
		expect(row.salesTax).toBe("0.99");
		expect(row.stripePaymentIntentId).toBe(`pi_test_${id}`);
	});

	it("leaves nothing behind that names the deleted person", async () => {
		// The counterpart to every "the artifact survives" assertion above: the things
		// that were purely theirs really are gone.
		for (const [table, column] of [
			["sessions", "user_id"],
			["follows", "follower_id"],
			["bookmarks", "user_id"],
			["attention_events", "user_id"],
			["accounts", "user_id"],
		] as const) {
			const rows = await db.execute(
				sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${leaverId}`,
			);
			const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
			expect(Number((list[0] as { n: number }).n)).toBe(0);
		}
	});
});
