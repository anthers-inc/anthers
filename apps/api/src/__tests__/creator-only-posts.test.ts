// SPDX-License-Identifier: Apache-2.0
/**
 * Posting is for creators.
 *
 * Creators post and everyone else reacts (Parker, 2026-09-12), and a published post writes an
 * `org.anthers.post` record under the creator permission set — so a reader who could post
 * would be writing a creator's record into their own repository. Three paths put a post in
 * front of people and each is refused here for somebody who is not a creator: creating one,
 * publishing or scheduling one through an edit, and the scheduled sweep that publishes with
 * nobody asking.
 *
 * 🚨 **What must stay open is the owner taking a post down.** Somebody who leaves creator mode
 * still owns what they posted, and unpublishing is what removes its record from the network.
 *
 * Publishing also takes completed payout setup, which `payouts-release-gate.test.ts` covers;
 * every creator here has it, so creator mode is the only variable.
 *
 * ⚠️ **`queue.send` is replaced for the duration**, so a refused request can be shown to have
 * asked for no record, and nothing is actually enqueued.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { publishScheduled } from "../jobs/publish-scheduled";
import { QUEUES, queue } from "../jobs/queue";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const makerName = `cop_maker_${id}`;
const leaverName = `cop_leaver_${id}`;
const readerName = `cop_reader_${id}`;

let sent: { name: string; data: Record<string, unknown> }[] = [];
let sendSpy: ReturnType<typeof spyOn>;

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const account = await createAccount(username);
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${username}@example.com`));
	return { cookie: account.cookie, id: row.id };
}

async function setCreator(userId: number, isCreator: boolean) {
	await db.update(users).set({ isCreator }).where(eq(users.id, userId));
}

async function postRow(slug: string) {
	const [row] = await db
		.select({ isPublished: posts.isPublished, scheduledFor: posts.scheduledFor })
		.from(posts)
		.where(eq(posts.slug, slug));
	return row;
}

function recordSyncs(): Record<string, unknown>[] {
	return sent.filter((s) => s.name === QUEUES.SYNC_ATPROTO_RECORD).map((s) => s.data);
}

let maker: { cookie: string; id: number };
let leaver: { cookie: string; id: number };
let reader: { cookie: string; id: number };

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${makerName}@example.com`}`, sql`${`${leaverName}@example.com`}`, sql`${`${readerName}@example.com`}`], sql`, `)})`,
	);
	maker = await signUp(makerName);
	leaver = await signUp(leaverName);
	reader = await signUp(readerName);
	// Both start fully set up, so creator mode is the only thing this suite takes away.
	await enablePayoutsFor(maker.id);
	await enablePayoutsFor(leaver.id);

	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	sendSpy.mockRestore();
	// A departing account's posts are kept as tombstones for the threads under them, so the
	// account purge would leave these behind.
	await db.execute(
		sql`DELETE FROM posts WHERE creator_id IN (SELECT id FROM users WHERE email IN (${sql.join([sql`${`${makerName}@example.com`}`, sql`${`${leaverName}@example.com`}`, sql`${`${readerName}@example.com`}`], sql`, `)}))`,
	);
});

describe("creating a post", () => {
	it("refuses somebody who is not a creator, writes nothing and asks for no record", async () => {
		sent = [];
		const res = await call("POST", "/api/content/posts", reader.cookie, {
			title: "A reader's post",
			slug: `cop-reader-${id}`,
			isPublished: true,
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("creator_required");

		const rows = await db
			.select({ id: posts.id })
			.from(posts)
			.where(eq(posts.creatorId, reader.id));
		expect(rows).toEqual([]);
		expect(recordSyncs()).toEqual([]);
	});

	it("refuses a reader's draft too, since a draft is a post waiting to go live", async () => {
		const res = await call("POST", "/api/content/posts", reader.cookie, {
			title: "A reader's draft",
			slug: `cop-reader-draft-${id}`,
			isPublished: false,
		});
		expect(res.status).toBe(403);
	});

	it("lets a creator post", async () => {
		const res = await call("POST", "/api/content/posts", maker.cookie, {
			title: "A creator's post",
			slug: `cop-maker-${id}`,
			isPublished: true,
		});
		expect(res.status).toBe(201);
	});
});

describe("an owner who has left creator mode", () => {
	const liveSlug = `cop-leaver-live-${id}`;
	const draftSlug = `cop-leaver-draft-${id}`;

	beforeAll(async () => {
		const live = await call("POST", "/api/content/posts", leaver.cookie, {
			title: "Posted while a creator",
			slug: liveSlug,
			isPublished: true,
		});
		expect(live.status).toBe(201);
		const draft = await call("POST", "/api/content/posts", leaver.cookie, {
			title: "Drafted while a creator",
			slug: draftSlug,
			isPublished: false,
		});
		expect(draft.status).toBe(201);
		await setCreator(leaver.id, false);
	});

	it("cannot publish a draft", async () => {
		sent = [];
		const res = await call("PATCH", `/api/content/posts/${draftSlug}`, leaver.cookie, {
			isPublished: true,
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("creator_required");
		expect((await postRow(draftSlug)).isPublished).toBe(false);
		expect(recordSyncs()).toEqual([]);
	});

	it("cannot schedule a draft, because the sweep would publish it", async () => {
		const res = await call("PATCH", `/api/content/posts/${draftSlug}`, leaver.cookie, {
			scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
		});
		expect(res.status).toBe(403);
		expect((await postRow(draftSlug)).scheduledFor).toBeNull();
	});

	it("can still edit a post", async () => {
		const res = await call("PATCH", `/api/content/posts/${draftSlug}`, leaver.cookie, {
			title: "Retitled after leaving",
		});
		expect(res.status).toBe(200);
	});

	it("can still take a live post down, which is what removes its record", async () => {
		sent = [];
		const res = await call("PATCH", `/api/content/posts/${liveSlug}`, leaver.cookie, {
			isPublished: false,
		});
		expect(res.status).toBe(200);
		expect((await postRow(liveSlug)).isPublished).toBe(false);
		expect(recordSyncs().length).toBe(1);
	});
});

describe("the scheduled sweep", () => {
	it("publishes a creator's due draft and clears the schedule on anybody else's", async () => {
		const makerSlug = `cop-sweep-maker-${id}`;
		const leaverSlug = `cop-sweep-leaver-${id}`;
		const future = new Date(Date.now() + 86_400_000).toISOString();

		// Both are scheduled while their authors are creators, which is the only way to schedule.
		await setCreator(leaver.id, true);
		for (const [who, slug] of [
			[maker, makerSlug],
			[leaver, leaverSlug],
		] as const) {
			const res = await call("POST", "/api/content/posts", who.cookie, {
				title: `Scheduled ${slug}`,
				slug,
				isPublished: false,
				scheduledFor: future,
			});
			expect(res.status).toBe(201);
		}
		await setCreator(leaver.id, false);

		// Brought due by moving the date rather than the clock, so the sweep publishes nothing
		// else in the shared database that is not already due.
		await db.execute(
			sql`UPDATE posts SET scheduled_for = now() - interval '1 minute' WHERE slug IN (${makerSlug}, ${leaverSlug})`,
		);
		await publishScheduled();

		const made = await postRow(makerSlug);
		expect(made.isPublished).toBe(true);
		const left = await postRow(leaverSlug);
		expect(left.isPublished).toBe(false);
		expect(left.scheduledFor).toBeNull();
	});
});
