// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Giving a Sticker: who gets paid, and how much may be directed.
 *
 * 🚨 **A Sticker pays the creator of the Work, never the author of the comment.** It rides
 * the giver's own comment, so on a comment thread the two are different people and the
 * wrong one is a single line away. Paying commenters would have Anthers moving money
 * between users, which is a different regulatory question and a different product — so that
 * is the first thing asserted here.
 *
 * ⭐ **The cap counts removed Stickers.** Removing one returns no money, so if the cap
 * ignored them a user could give, remove, and give again on the same allowance — the
 * rentable-standing hole the removal rule exists to close, arriving through the back door.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, comments, stickers, users } from "@anthers/db/schema";
import { stickerBudgetFor } from "@anthers/shared/constants";
import { eq } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

const RUN = crypto.randomUUID().slice(0, 8);
const SUPPORT = 12; // Blossom — an allowance of $2.00.

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

function give(cookie: string, body: Record<string, unknown>) {
	return req("/api/subscriptions/stickers", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	});
}

describe("giving a Sticker", () => {
	let giverCookie: string;
	let giverId: number;
	let creatorId: number;
	let strangerId: number;
	let workId: number;
	/** The giver's own comment on the creator's Work — where a Sticker may ride. */
	let ownCommentId: number;
	/** Somebody else's comment on the same Work — where one may not. */
	let otherCommentId: number;

	beforeAll(async () => {
		giverCookie = await signUp(`stk_giver_${RUN}`);
		await signUp(`stk_creator_${RUN}`);
		await signUp(`stk_other_${RUN}`);
		const rows = await db.select({ id: users.id, username: users.username }).from(users);
		const byName = new Map(rows.map((r) => [r.username, r.id]));
		giverId = byName.get(`stk_giver_${RUN}`)!;
		creatorId = byName.get(`stk_creator_${RUN}`)!;
		strangerId = byName.get(`stk_other_${RUN}`)!;

		// The giver is at Blossom, so they have $2.00 of their Time Pool to direct.
		await db
			.insert(accounts)
			.values({
				userId: giverId,
				anthersSupport: SUPPORT.toFixed(2),
				currentPeriodStart: new Date("2031-06-01T00:00:00Z"),
				currentPeriodEnd: new Date("2031-07-01T00:00:00Z"),
				isActive: true,
			})
			.onConflictDoNothing();

		workId = (await insertWork({ creatorId, type: "text", title: `Sticker work ${RUN}` })).id;
		const made = await db
			.insert(comments)
			.values([
				{ userId: giverId, subjectType: "work", subjectId: workId, body: `mine ${RUN}` },
				{ userId: strangerId, subjectType: "work", subjectId: workId, body: `theirs ${RUN}` },
			])
			.returning({ id: comments.id, userId: comments.userId });
		ownCommentId = made.find((m) => m.userId === giverId)!.id;
		otherCommentId = made.find((m) => m.userId === strangerId)!.id;
	}, DB_SETUP_TIMEOUT);

	it("🚨 pays the Work's creator, not the author of the comment it rides", async () => {
		const res = await give(giverCookie, {
			subjectType: "comment",
			subjectId: ownCommentId,
			amount: 0.25,
		});
		expect(res.status).toBe(201);
		const { sticker } = (await res.json()) as { sticker: { creatorId: number } };
		expect(sticker.creatorId).toBe(creatorId);
		// The giver wrote the comment, and is emphatically not the one being paid.
		expect(sticker.creatorId).not.toBe(giverId);
	});

	it("🚨 refuses a Sticker on somebody else's comment", async () => {
		const res = await give(giverCookie, {
			subjectType: "comment",
			subjectId: otherCommentId,
			amount: 0.25,
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("not_yours");
	});

	it("refuses a Sticker on your own work — that is not a gift, it is a loop", async () => {
		const ownWork = await insertWork({ creatorId: giverId, type: "text", title: `Own ${RUN}` });
		const res = await give(giverCookie, {
			subjectType: "work",
			subjectId: ownWork.id,
			amount: 0.25,
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("own_work");
	});

	it("takes only the three denominations Anthers designs", async () => {
		for (const amount of [0.1, 0.75, 2, 5, -0.25, 0]) {
			const res = await give(giverCookie, { subjectType: "work", subjectId: workId, amount });
			expect(res.status, `amount ${amount}`).toBe(400);
		}
	});

	it("404s on a subject that is not there", async () => {
		const res = await give(giverCookie, {
			subjectType: "work",
			subjectId: 2_000_000_000,
			amount: 0.25,
		});
		expect(res.status).toBe(404);
	});

	it("⭐ reports an allowance that is a third of the Time Pool, and what is left of it", async () => {
		const res = await req("/api/subscriptions/stickers/allowance", {
			headers: { Cookie: giverCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { allowance: number; directed: number; remaining: number };
		expect(body.allowance).toBeCloseTo(stickerBudgetFor(SUPPORT), 2);
		expect(body.directed).toBeCloseTo(0.25, 2); // the one given above
		expect(body.remaining).toBeCloseTo(body.allowance - body.directed, 2);
	});

	it("🚨 counts a REMOVED Sticker against the allowance, so it cannot be spent twice", async () => {
		const before = await directed();
		const res = await give(giverCookie, {
			subjectType: "work",
			subjectId: workId,
			amount: 0.25,
		});
		expect(res.status).toBe(201);
		const { sticker } = (await res.json()) as { sticker: { id: number } };

		const removal = await req(`/api/subscriptions/stickers/${sticker.id}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: giverCookie },
		});
		expect(removal.status).toBe(200);
		// The response says the thing the UI has to tell the giver.
		expect((await removal.json()).creatorStaysPaid).toBe(true);

		// The row survives, carries its amount, and is merely marked.
		const [row] = await db.select().from(stickers).where(eq(stickers.id, sticker.id));
		expect(row.removedAt).not.toBeNull();
		expect(row.amount).toBe("0.25");
		// And the allowance does not come back.
		expect(await directed()).toBeCloseTo(before + 0.25, 2);
	});

	it("🚨 refuses a Sticker that would take a user past their allowance", async () => {
		// Blossom's allowance is $2.00 and some is already directed above; spend the rest in
		// $1.00 steps until it refuses, then check it refused for the right reason.
		let refused: Response | null = null;
		for (let i = 0; i < 6 && !refused; i++) {
			const res = await give(giverCookie, { subjectType: "work", subjectId: workId, amount: 1 });
			if (res.status !== 201) refused = res;
		}
		expect(refused, "the cap never engaged").not.toBeNull();
		expect(refused!.status).toBe(409);
		const body = (await refused!.json()) as { code: string; remaining: number };
		expect(body.code).toBe("over_allowance");
		expect(body.remaining).toBeGreaterThanOrEqual(0);
		// Never more than the allowance, however many attempts were made.
		expect(await directed()).toBeLessThanOrEqual(stickerBudgetFor(SUPPORT) + 0.001);
	});

	async function directed(): Promise<number> {
		const rows = await db.select().from(stickers).where(eq(stickers.giverId, giverId));
		return rows.reduce((sum, r) => sum + Number(r.amount), 0);
	}
});

describe("a free account", () => {
	it("has no Time Pool to direct by hand", async () => {
		const cookie = await signUp(`stk_free_${RUN}`);
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, `stk_free_${RUN}`));
		await db
			.insert(accounts)
			.values({
				userId: user.id,
				anthersSupport: "0.00",
				currentPeriodStart: new Date("2031-06-01T00:00:00Z"),
				currentPeriodEnd: new Date("2031-07-01T00:00:00Z"),
				isActive: true,
			})
			.onConflictDoNothing();

		// Somebody else's Work, so the refusal can only be about the allowance. Stickering
		// their own would be refused too, for a different reason, and the test could not tell
		// which rule fired.
		await signUp(`stk_freetarget_${RUN}`);
		const [target] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, `stk_freetarget_${RUN}`));
		const work = await insertWork({ creatorId: target.id, type: "text", title: `Free ${RUN}` });

		const res = await give(cookie, { subjectType: "work", subjectId: work.id, amount: 0.25 });
		// ⭐ Refused on the allowance BEFORE the subject is resolved. The arithmetic settles
		// this before policy has to: a third of the subsidized pot buys no Sticker at any
		// denomination.
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("no_allowance");
		// `user` is the free account itself, and it directed nothing.
		expect((await db.select().from(stickers).where(eq(stickers.giverId, user.id))).length).toBe(0);
	});
});
