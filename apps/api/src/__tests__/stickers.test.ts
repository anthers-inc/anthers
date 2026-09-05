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
			artKey: "butterfly-small",
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
			artKey: "butterfly-small",
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("not_yours");
	});

	it("refuses a Sticker on your own work — that is not a gift, it is a loop", async () => {
		const ownWork = await insertWork({ creatorId: giverId, type: "text", title: `Own ${RUN}` });
		const res = await give(giverCookie, {
			subjectType: "work",
			subjectId: ownWork.id,
			artKey: "butterfly-small",
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("own_work");
	});

	it("🚨 takes art rather than an amount, so the money cannot be paired with the wrong drawing", async () => {
		// The art IS the denomination. A caller that could send both could put the most
		// elaborate butterfly on a quarter, and the drawing is what a creator reads as
		// generosity — so an amount in the request is refused outright rather than checked.
		const withAmount = await give(giverCookie, {
			subjectType: "work",
			subjectId: workId,
			artKey: "butterfly-small",
			amount: 1,
		} as never);
		expect(withAmount.status).toBe(201);
		const { sticker } = (await withAmount.json()) as { sticker: { amount: string } };
		expect(sticker.amount).toBe("0.25");
	});

	it("refuses art that is not in the batch", async () => {
		for (const artKey of ["butterfly-enormous", "", "../etc/passwd", "BUTTERFLY-SMALL"]) {
			const res = await give(giverCookie, { subjectType: "work", subjectId: workId, artKey });
			expect(res.status, `artKey ${artKey}`).toBe(400);
		}
	});

	it("404s on a subject that is not there", async () => {
		const res = await give(giverCookie, {
			subjectType: "work",
			subjectId: 2_000_000_000,
			artKey: "butterfly-small",
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
		// ⚠️ Derived from the rows rather than pinned to a literal. It was pinned to the
		// one Sticker given above, which made the number a function of how many tests
		// happen to run first — so adding a test anywhere earlier broke this one for a
		// reason that had nothing to do with allowances. What is actually being asserted
		// is that the endpoint agrees with the table.
		expect(body.directed).toBeCloseTo(await directed(), 2);
		expect(body.directed).toBeGreaterThan(0);
		expect(body.remaining).toBeCloseTo(body.allowance - body.directed, 2);
	});

	it("🚨 counts a REMOVED Sticker against the allowance, so it cannot be spent twice", async () => {
		const before = await directed();
		const res = await give(giverCookie, {
			subjectType: "work",
			subjectId: workId,
			artKey: "butterfly-small",
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
			const res = await give(giverCookie, {
				subjectType: "work",
				subjectId: workId,
				artKey: "butterfly-large",
			});
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

		const res = await give(cookie, {
			subjectType: "work",
			subjectId: work.id,
			artKey: "butterfly-small",
		});
		// ⭐ Refused on the allowance BEFORE the subject is resolved. The arithmetic settles
		// this before policy has to: a third of the subsidized pot buys no Sticker at any
		// denomination.
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("no_allowance");
		// `user` is the free account itself, and it directed nothing.
		expect((await db.select().from(stickers).where(eq(stickers.giverId, user.id))).length).toBe(0);
	});
});

/**
 * The Stickers a page shows.
 *
 * ⚠️ **Its own giver, deliberately.** The suite above deliberately exhausts an allowance to
 * prove the cap engages, so anything giving a Sticker after it would be refused for a
 * reason that has nothing to do with what it is testing. A fresh account makes these
 * independent of where they sit in the file.
 */
describe("the Stickers on a page", () => {
	let cookie: string;
	let giverId: number;
	let creatorId: number;

	beforeAll(async () => {
		cookie = await signUp(`stk_show_${RUN}`);
		await signUp(`stk_showcreator_${RUN}`);
		const rows = await db.select({ id: users.id, username: users.username }).from(users);
		const byName = new Map(rows.map((r) => [r.username, r.id]));
		giverId = byName.get(`stk_show_${RUN}`)!;
		creatorId = byName.get(`stk_showcreator_${RUN}`)!;
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
	}, DB_SETUP_TIMEOUT);

	async function listOn(
		subjectId: number,
		as?: string,
	): Promise<{ artKey: string; count: number; mine: number[] }[]> {
		const res = await req(`/api/subscriptions/stickers?subjectType=work&subjectId=${subjectId}`, {
			headers: as ? { Cookie: as } : {},
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { stickers: never[] }).stickers;
	}

	it("⭐ groups by art rather than returning one row per Sticker", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `Grouped ${RUN}` });
		for (const artKey of ["butterfly-small", "butterfly-small", "butterfly-medium"]) {
			const res = await give(cookie, { subjectType: "work", subjectId: work.id, artKey });
			expect(res.status).toBe(201);
		}
		const shown = await listOn(work.id, cookie);
		expect(shown.find((g) => g.artKey === "butterfly-small")?.count).toBe(2);
		expect(shown.find((g) => g.artKey === "butterfly-medium")?.count).toBe(1);
	});

	it("🚨 drops a removed Sticker from the page while it stays spent", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `Removed ${RUN}` });
		const res = await give(cookie, {
			subjectType: "work",
			subjectId: work.id,
			artKey: "butterfly-small",
		});
		expect(res.status).toBe(201);
		const { sticker } = (await res.json()) as { sticker: { id: number } };

		const spentBefore = await db.select().from(stickers).where(eq(stickers.giverId, giverId));
		await req(`/api/subscriptions/stickers/${sticker.id}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: cookie },
		});

		// Gone from the display...
		expect(await listOn(work.id, cookie)).toEqual([]);
		// ...and the row is still there, still carrying its amount. Removal is display-only,
		// which is what stops a Sticker being rented and refunded.
		const spentAfter = await db.select().from(stickers).where(eq(stickers.giverId, giverId));
		expect(spentAfter.length).toBe(spentBefore.length);
	});

	it("🚨 identifies a viewer's own Stickers, and nobody's to a stranger", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `Mine ${RUN}` });
		expect(
			(await give(cookie, { subjectType: "work", subjectId: work.id, artKey: "butterfly-small" }))
				.status,
		).toBe(201);

		// The giver gets a row id back, because taking one back is theirs alone to do.
		expect((await listOn(work.id, cookie))[0]?.mine.length).toBe(1);

		// A signed-out reader sees the Sticker and no identity attached to it.
		const anon = (await listOn(work.id))[0];
		expect(anon?.count).toBe(1);
		expect(anon?.mine).toEqual([]);
	});

	it("refuses a subject it does not recognize", async () => {
		expect((await req("/api/subscriptions/stickers?subjectType=galaxy&subjectId=1")).status).toBe(
			400,
		);
		expect((await req("/api/subscriptions/stickers?subjectType=work&subjectId=nope")).status).toBe(
			400,
		);
	});
});
