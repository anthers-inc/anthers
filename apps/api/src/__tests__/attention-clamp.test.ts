// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The wall-clock clamp on POST /api/subscriptions/attention.
 *
 * Attention seconds are the allocation function for Time Pool money, and every
 * second arriving at this endpoint is client-supplied. The browser splits a tick
 * between concurrent claims, but it only sees one tab — and a forged request sees
 * nothing at all. This is the backstop: credited seconds in a rolling window can
 * never exceed the seconds that actually elapsed.
 *
 * These drive the real endpoint rather than the pure clamp (covered in
 * packages/shared/src/attention.test.ts), so the DB read of already-spent seconds
 * is exercised too.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";
import { insertWork } from "./work-fixtures.js";
import { CREDIT_WINDOW_SECONDS } from "@anthers/shared/attention";
import { and, eq, gte, sql } from "drizzle-orm";
import app from "../index";

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

/**
 * Every timed event names `workId` because the endpoint re-decides eligibility
 * server-side: time is only credited against a post that exists, belongs to the
 * claimed creator, is accessible to the viewer, and carries a content element that
 * earns the claimed event type. The clamp under test here runs *after* that filter,
 * so its fixtures have to be events that legitimately qualify.
 */
function postAttention(
	cookie: string,
	events: { creatorId: number; eventType: string; durationSeconds: number; workId?: number }[],
) {
	return req("/api/subscriptions/attention", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({
			events: events.map((e) => (e.durationSeconds > 0 ? { workId: earningWorkId, ...e } : e)),
		}),
	});
}

/** Total seconds credited to a user inside the current clamp window. */
async function creditedSeconds(userId: number): Promise<number> {
	const windowStart = new Date(Date.now() - CREDIT_WINDOW_SECONDS * 1_000);
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(and(eq(attentionEvents.userId, userId), gte(attentionEvents.createdAt, windowStart)));
	return row?.total ?? 0;
}

let viewer: { cookie: string; id: number };
let creator: { cookie: string; id: number };
/** A free post carrying both a video and a text element, so "watch" and "read" both earn. */
let earningWorkId: number;

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	viewer = await signUp(`clampviewer${stamp}`);
	creator = await signUp(`clampcreator${stamp}`);

	// Inserted rather than created through the API: a video Work queues a transcode,
	// and pg-boss isn't running in the test process. Free and released, so the clamp is
	// the only thing that can refuse anything here — which is the point of this suite.
	earningWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "Clamp Fixture",
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		})
	).id;
});

describe("attention wall-clock clamp", () => {
	it("credits an ordinary batch in full", async () => {
		const res = await postAttention(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 30 },
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 30 },
		]);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.granted).toBe(60);
		expect(body.refused).toBe(0);
		expect(await creditedSeconds(viewer.id)).toBe(60);
	});

	it("refuses seconds beyond the window and never exceeds it", async () => {
		// Claim far more than an hour in one go — the equivalent of many tabs, or a
		// client that simply lies.
		const greedy = Array.from({ length: 40 }, () => ({
			creatorId: creator.id,
			eventType: "watch",
			durationSeconds: 300,
		}));
		const res = await postAttention(viewer.cookie, greedy);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.refused).toBeGreaterThan(0);

		const total = await creditedSeconds(viewer.id);
		expect(total).toBe(CREDIT_WINDOW_SECONDS);
		expect(body.granted).toBe(CREDIT_WINDOW_SECONDS - 60); // 60 already spent above
	});

	it("refuses everything once the window is exhausted", async () => {
		const res = await postAttention(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 120 },
		]);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.granted).toBe(0);
		expect(body.refused).toBe(120);
		// Still exactly one window's worth — the extra claim bought nothing.
		expect(await creditedSeconds(viewer.id)).toBe(CREDIT_WINDOW_SECONDS);
	});

	it("still records zero-duration visit pings against a full window", async () => {
		const before = await creditedSeconds(viewer.id);
		const res = await postAttention(viewer.cookie, [
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0 },
		]);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.recorded).toBe(1);
		expect(body.refused).toBe(0);
		expect(await creditedSeconds(viewer.id)).toBe(before);
	});

	it("clamps each user independently", async () => {
		const fresh = await signUp(`clampother${Date.now().toString(36)}`);
		const res = await postAttention(fresh.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 45 },
		]);
		expect(res.status).toBe(200);
		expect((await res.json()).granted).toBe(45);
		expect(await creditedSeconds(fresh.id)).toBe(45);
	});

	it("requires authentication", async () => {
		const res = await req("/api/subscriptions/attention", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				events: [{ creatorId: creator.id, eventType: "watch", durationSeconds: 30 }],
			}),
		});
		expect(res.status).toBe(401);
	});
});
