// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Delivery-layer access — that a denied viewer is never handed a *pointer* at the media,
 * not merely that the access reason says "gated".
 *
 * This distinction is the whole point of the file. `access-staircase.test.ts` proves the
 * resolver returns the right reason for every rung, and it would have stayed green through
 * every bug fixed here: a locked post's JSON shipped `transcoding.hlsManifestUrl` and
 * `outputFileUrl` regardless of access, `GET /posts/:slug/transcoding` had no access check
 * on those fields at all, and processed audio was uploaded public-read — so the reason said
 * "gated" while a working URL to the bytes sat in the same response. A reason-only suite is
 * structurally incapable of catching that, so these assertions are about URLs.
 *
 * Media items are inserted directly rather than through `POST /content-items`, which queues
 * a transcode — pg-boss isn't running in the test process, so that route 500s for audio and
 * video. Inserting the item and its completed job is also the only way to test the delivered
 * state without actually running ffmpeg.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { contentItems, transcodingJobs, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
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

/** The raw stored URLs the fixtures below stand in for. Neither may reach a denied viewer. */
const AUDIO_URL = "https://cdn.example.com/creators/x/audio/processed/secret.mp3";
const HLS_URL = "https://cdn.example.com/creators/x/videos/hls/secret/master.m3u8";

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `deliv_${id}`;
const viewerName = `deliv_viewer_${id}`;

/** Locked to everyone but the owner: present rows, none allowed. */
const LOCKED = { anthersAccess: [{ threshold: 0, allow: false, price: "0" }] };

describe("Delivery-layer access", () => {
	let creatorCookie: string;
	let viewerCookie: string;
	let creatorId: number;
	let audioItemId: number;
	let videoItemId: number;
	let lockedSlug: string;
	let freeSlug: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
		creatorCookie = await signUp(creatorName);
		viewerCookie = await signUp(viewerName);

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName))
			.limit(1);
		creatorId = creator.id;

		// An audio and a video item, each with a COMPLETED job carrying a stored media URL —
		// the state a real upload reaches once the worker is done with it.
		const [audio] = await db
			.insert(contentItems)
			.values({ creatorId, type: "audio", title: "Locked Track" })
			.returning();
		audioItemId = audio.id;
		await db.insert(transcodingJobs).values({
			contentItemId: audioItemId,
			mediaType: "audio",
			status: "completed",
			progress: 100,
			outputFileUrl: AUDIO_URL,
		});

		const [video] = await db
			.insert(contentItems)
			.values({ creatorId, type: "video", title: "Locked Film" })
			.returning();
		videoItemId = video.id;
		await db.insert(transcodingJobs).values({
			contentItemId: videoItemId,
			mediaType: "video",
			status: "completed",
			progress: 100,
			hlsManifestUrl: HLS_URL,
		});
	});

	it("publishes a locked post and a free post over the same two items", async () => {
		const locked = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Locked ${id}`,
				...LOCKED,
				contents: [
					{ kind: "content", contentItemId: audioItemId },
					{ kind: "content", contentItemId: videoItemId },
				],
				body: "the gated prose",
				isPublished: true,
			}),
		});
		expect(locked.status).toBe(201);
		lockedSlug = (await locked.json()).post.slug;

		const free = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Free ${id}`,
				seedAccess: [{ threshold: 0, allow: true, price: "0" }],
				contents: [{ kind: "content", contentItemId: audioItemId }],
				isPublished: true,
			}),
		});
		expect(free.status).toBe(201);
		freeSlug = (await free.json()).post.slug;
	});

	// ── Post detail ────────────────────────────────────────────────────────────

	it("withholds every media URL from a denied viewer on post detail", async () => {
		for (const [who, headers] of [
			["signed-in viewer", { Cookie: viewerCookie }],
			["anonymous", {}],
		] as const) {
			const res = await req(`/api/content/posts/${lockedSlug}`, { headers });
			expect(res.status).toBe(200);
			const { post } = await res.json();
			expect(post.access.canAccess).toBe(false);

			const items = post.contents.map((e: any) => e.contentItem);
			expect(items.length).toBe(2);
			for (const item of items) {
				// The pointers at the bytes — the actual bug this file exists for.
				expect(item.transcoding.hlsManifestUrl, `${who} hlsManifestUrl`).toBeNull();
				expect(item.transcoding.outputFileUrl, `${who} outputFileUrl`).toBeNull();
				expect(item.sourceKey).toBe("");
			}
			// Status still flows, so a locked post can render "Processing…" rather than a
			// blank frame. Withholding the URL is the fix; withholding the status isn't.
			expect(items[0].transcoding.status).toBe("completed");
			// And the body is gated in the same breath.
			expect(post.bodyHtml).toBe("");
			expect(post.body).toBe("");
		}
	});

	it("still hands the owner their own media URLs", async () => {
		const res = await req(`/api/content/posts/${lockedSlug}`, {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const { post } = await res.json();
		expect(post.access.canAccess).toBe(true);
		const urls = post.contents.flatMap((e: any) => [
			e.contentItem.transcoding.outputFileUrl,
			e.contentItem.transcoding.hlsManifestUrl,
		]);
		expect(urls).toContain(AUDIO_URL);
		expect(urls).toContain(HLS_URL);
	});

	// ── The transcoding poller ─────────────────────────────────────────────────

	it("withholds media URLs from a denied viewer on the transcoding route", async () => {
		const res = await req(`/api/content/posts/${lockedSlug}/transcoding`, {
			headers: { Cookie: viewerCookie },
		});
		// Deliberately not a 403: the poller is allowed to learn that media is still
		// processing. What it must not be is a second door to the URLs post detail withheld.
		expect(res.status).toBe(200);
		const { jobs } = await res.json();
		expect(jobs.length).toBe(2);
		for (const job of jobs) {
			expect(job.hlsManifestUrl).toBeNull();
			expect(job.outputFileUrl).toBeNull();
			expect(job.status).toBe("completed");
		}
	});

	it("hands the owner real URLs on the transcoding route", async () => {
		const res = await req(`/api/content/posts/${lockedSlug}/transcoding`, {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const { jobs } = await res.json();
		const urls = jobs.flatMap((j: any) => [j.outputFileUrl, j.hlsManifestUrl]);
		expect(urls).toContain(AUDIO_URL);
		expect(urls).toContain(HLS_URL);
	});

	// ── The audio endpoint ─────────────────────────────────────────────────────

	it("403s the audio endpoint for a denied viewer, and for an anonymous one", async () => {
		const cases: Record<string, string>[] = [{ Cookie: viewerCookie }, {}];
		for (const headers of cases) {
			const res = await req(`/api/content/posts/${lockedSlug}/audio/${audioItemId}`, {
				headers,
				redirect: "manual",
			});
			expect(res.status).toBe(403);
		}
	});

	it("redirects an entitled viewer to the media, uncacheably", async () => {
		const res = await req(`/api/content/posts/${freeSlug}/audio/${audioItemId}`, {
			headers: { Cookie: viewerCookie },
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBeTruthy();
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("refuses to serve an item the post doesn't reference", async () => {
		// The free post references only the audio item. Asking it for the video item must
		// 404 rather than borrow that post's access for someone else's media.
		const res = await req(`/api/content/posts/${freeSlug}/audio/${videoItemId}`, {
			headers: { Cookie: viewerCookie },
			redirect: "manual",
		});
		expect(res.status).toBe(404);
	});

	it("rejects a non-numeric content id instead of 500ing on it", async () => {
		const res = await req(`/api/content/posts/${freeSlug}/audio/not-a-number`, {
			headers: { Cookie: viewerCookie },
			redirect: "manual",
		});
		expect(res.status).toBe(404);
	});

	// ── The follow feed ────────────────────────────────────────────────────────

	it("never ships post bodies through the follow feed", async () => {
		const follow = await req(`/api/accounts/users/${creatorName}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(follow.ok).toBe(true);

		const res = await req("/api/accounts/me/feed", { headers: { Cookie: viewerCookie } });
		expect(res.status).toBe(200);
		const { posts } = await res.json();

		const locked = posts.find((p: any) => p.slug === lockedSlug);
		expect(locked).toBeTruthy();
		// `...row.post` used to spread the whole row here, body included — following a
		// creator is not access.
		expect(locked.body).toBeUndefined();
		expect(locked.bodyHtml).toBeUndefined();
		expect(locked.access.canAccess).toBe(false);

		// The free post over the same creator resolves the other way, so the feed is
		// reporting real access rather than blanket-denying.
		expect(posts.find((p: any) => p.slug === freeSlug).access.canAccess).toBe(true);
	});
});
