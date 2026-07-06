// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Publish gating (E50 Phase 3) — the server half of decoupling drafting from media.
 * A post saves as a draft with defined-but-empty media slots, but publishing is blocked
 * until every video/audio slot carries a source. Covers both handlers (create + patch)
 * and confirms a rejected publish doesn't partially apply.
 *
 * The filled-slot → publish path enqueues a transcode via pg-boss (not started in this
 * unit slice), so it's exercised in the browser/worker rather than here; the "no media
 * slots → publish allowed" case proves the gate is specific to *unfilled* media.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string) {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `gate_${id}`;

/** Free baseline so the created posts are readable back by the owner. */
const FREE = [{ threshold: 0, allow: true, price: "0" }];

describe("Publish gating — drafting decoupled from media", () => {
	let cookie: string;
	let draftSlug: string;
	let videoContentId: number;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${creatorName}`);
	});

	it("signs up a creator", async () => {
		cookie = await signUp(creatorName);
		expect(cookie).toBeTruthy();
	});

	it("saves a draft with defined-but-empty video + audio slots", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				title: `Draft ${id}`,
				body: "A draft with empty media slots.",
				streamEnabled: true,
				downloadEnabled: false,
				boostAccess: FREE,
				contents: [{ contentType: "video" }, { contentType: "audio" }],
				isPublished: false,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.isPublished).toBe(false);
		draftSlug = post.slug;
		const video = post.contents.find((e: { contentType: string }) => e.contentType === "video");
		expect(video.videoFile).toBe(""); // empty slot persisted, no source required
		videoContentId = video.id;
	});

	it("blocks publishing while a media slot is still empty (patch)", async () => {
		const res = await req(`/api/content/posts/${draftSlug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				isPublished: true,
				contents: [{ id: videoContentId, contentType: "video" }, { contentType: "audio" }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("blocks create-and-publish with an empty media slot", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				title: `Insta ${id}`,
				body: "x",
				streamEnabled: true,
				downloadEnabled: false,
				boostAccess: FREE,
				contents: [{ contentType: "video" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("still allows publishing a post with no media slots", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				title: `Text ${id}`,
				body: "No media here.",
				streamEnabled: true,
				downloadEnabled: false,
				boostAccess: FREE,
				contents: [{ contentType: "text", bodyHtml: "<p>hi</p>" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.isPublished).toBe(true);
	});

	it("left the draft unpublished — the blocked publish didn't partially apply", async () => {
		const res = await req(`/api/content/posts/${draftSlug}`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		const { post } = await res.json();
		expect(post.isPublished).toBe(false);
	});
});
