// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server-side attention eligibility on POST /api/subscriptions/attention.
 *
 * `distribute-pool` sums `attention_events.duration_seconds` per creator and splits the
 * Time Pool proportionally, nightly — so a row in that table is money. The eligibility
 * rule that decides which seconds may become a row is that only a **Work** earns; posts,
 * project pages, profiles, discovery and comments are connective tissue and earn nothing.
 *
 * That rule used to be a filter inside the endpoint, policed against a schema whose column
 * said `post_id`. It is now structural — a claim names a Work or it is not a claim about
 * anything that earns — which is what these tests pin.
 *
 * The wall-clock clamp is not a substitute and never was: it bounds *volume* — you cannot
 * be credited more seconds than have elapsed — and has nothing to say about *attribution*.
 * A hand-written request could sit inside the clamp perfectly while crediting `read`
 * seconds against a creator who had nothing to do with the Work. These tests are about
 * attribution.
 *
 * Policy itself lives in `packages/shared/src/attention.ts` and is unit-tested there; what's
 * asserted here is that the endpoint actually consults it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return {
		cookie: res.headers.get("Set-Cookie")!.split(";")[0],
		id: (await res.json()).user.id,
	};
}

type Event = {
	creatorId: number;
	eventType: string;
	durationSeconds: number;
	workId?: number;
};

async function claim(cookie: string, events: Event[]) {
	const res = await req("/api/subscriptions/attention", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ events }),
	});
	expect(res.status).toBe(200);
	return res.json();
}

/** Seconds this user has ever been credited toward this creator. */
async function creditedTo(userId: number, creatorId: number): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(and(eq(attentionEvents.userId, userId), eq(attentionEvents.creatorId, creatorId)));
	return row?.total ?? 0;
}

const FREE = [{ threshold: 0, allow: true, price: "0" }];
const LOCKED = [{ threshold: 0, allow: false, price: "0" }];

let viewer: { cookie: string; id: number };
let creator: { cookie: string; id: number };
let bystander: { cookie: string; id: number };

/** Released, free video Work → earns "watch". */
let videoWorkId: number;
/** Released, free text Work → earns "read". Prose in the Catalog earns; a post body doesn't. */
let textWorkId: number;
/** Released video Work, locked to everyone. */
let lockedWorkId: number;
/** A video Work still staging — never released, so not publicly consumable. */
let privateWorkId: number;

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	viewer = await signUp(`eligviewer${stamp}`);
	creator = await signUp(`eligcreator${stamp}`);
	bystander = await signUp(`eligbystander${stamp}`);

	// Inserted rather than created through the API: creating a video Work queues a
	// transcode, and pg-boss isn't running in the test process.
	videoWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "A Film",
			anthersAccess: FREE,
		})
	).id;
	textWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "text",
			title: "An Essay",
			bodyHtml: "<p>prose that earns, because it is a Work</p>",
			anthersAccess: FREE,
		})
	).id;
	lockedWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "A Locked Film",
			anthersAccess: LOCKED,
		})
	).id;
	privateWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "Still Editing",
			visibility: "private",
			anthersAccess: FREE,
		})
	).id;
});

describe("attention eligibility is decided server-side", () => {
	it("credits time against a Work whose type earns it", async () => {
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 30, workId: videoWorkId },
			{ creatorId: creator.id, eventType: "read", durationSeconds: 20, workId: textWorkId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before + 50);
	});

	it("refuses an event type the Work's own type doesn't earn", async () => {
		// A text Work has no video, so "watch" against it is not a real observation.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: textWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time credited to someone who isn't the Work's creator", async () => {
		// Straightforward attribution forgery: real Work, right type, wrong payee.
		const before = await creditedTo(viewer.id, bystander.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: bystander.id, eventType: "watch", durationSeconds: 60, workId: videoWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, bystander.id)).toBe(before);
	});

	it("refuses time against a Work the viewer can't access", async () => {
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: lockedWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time against a Work that hasn't been released", async () => {
		// Private staging is not public consumption. The Work is free and the viewer would
		// clear its gate — being unreleased is the whole reason this is refused.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: privateWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time with no Work context at all", async () => {
		// A claim naming no Work is connective tissue by definition — a post, a profile,
		// discovery. This is the shape a naive forged request takes.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60 },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time against a Work that doesn't exist", async () => {
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: 2_000_000_000 },
		]);
		expect(body.ineligible).toBe(1);
	});

	it("still records zero-duration visit pings, with or without a Work", async () => {
		// These carry no time so they cannot over-credit, and they are deliberately the
		// analytics signal for surfaces that earn nothing. Dropping them would lose that.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0 },
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0, workId: videoWorkId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});
});
