// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Delivery-layer access — that a denied viewer is never handed a *pointer* at the media,
 * not merely that the access reason says "gated".
 *
 * This distinction is the whole point of the file. `access-staircase.test.ts` proves the
 * resolver returns the right reason for every rung, and it would have stayed green through
 * every bug fixed here: locked JSON shipped `transcoding.hlsManifestUrl` and
 * `outputFileUrl` regardless of access, the transcoding poller had no access check on those
 * fields at all, and processed audio was uploaded public-read — so the reason said "gated"
 * while a working URL to the bytes sat in the same response. A reason-only suite is
 * structurally incapable of catching that, so these assertions are about URLs.
 *
 * Delivery is **Work-scoped** since migration `0010`. One check this file used to make is
 * deliberately gone rather than ported: each endpoint had to confirm the item it was handed
 * was actually referenced by the post being used to reach it, or one accessible post would
 * unlock every item on the platform. With the gate on the Work, the Work addresses itself
 * and that hazard doesn't exist to test for.
 *
 * Works are inserted directly rather than through `POST /works`, which queues a transcode —
 * pg-boss isn't running in the test process, so that route 500s for audio and video.
 * Inserting the Work and its completed job is also the only way to test the delivered state
 * without actually running ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, purchases, transcodingJobs, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

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

/** The raw stored URLs the fixtures below stand in for. Neither may reach a denied viewer. */
const AUDIO_URL = "https://cdn.example.com/creators/x/audio/processed/secret.mp3";
const HLS_URL = "https://cdn.example.com/creators/x/videos/hls/secret/master.m3u8";

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `deliv_${id}`;
const viewerName = `deliv_viewer_${id}`;

/** Locked to everyone but the owner: present rows, none allowed. */
const LOCKED = { seedAccess: [{ threshold: 0, allow: false, price: "0" }] };

describe("Delivery-layer access", () => {
	let creatorCookie: string;
	let viewerCookie: string;
	let creatorId: number;
	let audioItemId: number;
	let videoItemId: number;
	/** A released, free audio Work — the "entitled viewer" side of every assertion below. */
	let freeAudioId: number;
	/** A free, downloadable Work plus its asset — for the delivery-stamp assertion. */
	let freeWorkId: number;
	let freeAssetId: number;

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

		// An audio and a video Work, each with a COMPLETED job carrying a stored media URL —
		// the state a real upload reaches once the worker is done with it. Both LOCKED, so
		// the only viewer who should ever see a URL is their owner.
		const audio = await insertWork({
			creatorId,
			type: "audio",
			title: "Locked Track",
			...LOCKED,
		});
		audioItemId = audio.id;
		await db.insert(transcodingJobs).values({
			workId: audioItemId,
			mediaType: "audio",
			status: "completed",
			progress: 100,
			outputFileUrl: AUDIO_URL,
		});

		const video = await insertWork({
			creatorId,
			type: "video",
			title: "Locked Film",
			...LOCKED,
		});
		videoItemId = video.id;
		await db.insert(transcodingJobs).values({
			workId: videoItemId,
			mediaType: "video",
			status: "completed",
			progress: 100,
			hlsManifestUrl: HLS_URL,
		});

		const freeAudio = await insertWork({
			creatorId,
			type: "audio",
			title: "Open Track",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		freeAudioId = freeAudio.id;
		await db.insert(transcodingJobs).values({
			workId: freeAudioId,
			mediaType: "audio",
			status: "completed",
			progress: 100,
			outputFileUrl: AUDIO_URL,
		});
		const game = await insertWork({
			creatorId,
			type: "game",
			title: "Open Game",
			downloadEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		freeWorkId = game.id;
		const [gameAsset] = await db
			.insert(assets)
			.values({
				workId: freeWorkId,
				file: "creators/x/games/open-game.zip",
				filename: "open-game.zip",
				fileSize: 1024,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			})
			.returning();
		freeAssetId = gameAsset.id;
	}, DB_SETUP_TIMEOUT);

	// The usernames carry a per-run suffix, so without this each run's rows stay in the
	// shared dev database forever — including the simulated transcoding_jobs above, which
	// the worker's boot-time resume sweep used to re-send as real jobs on every `make dev`.
	// Works and posts must go first and by creator_id: both are ON DELETE SET NULL (a Work
	// outlives its creator's account), so deleting the users alone orphans them instead.
	afterAll(async () => {
		const owners = sql`SELECT id FROM users WHERE username IN (${creatorName}, ${viewerName})`;
		await db.execute(sql`DELETE FROM works WHERE creator_id IN (${owners})`);
		await db.execute(sql`DELETE FROM posts WHERE creator_id IN (${owners})`);
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
	});

	it("publishes a locked post and a free post over the same two items", async () => {});

	// ── Work detail ────────────────────────────────────────────────────────────

	it("withholds every media URL from a denied viewer on Work detail", async () => {
		for (const [who, headers] of [
			["signed-in viewer", { Cookie: viewerCookie }],
			["anonymous", {}],
		] as const) {
			for (const workId of [audioItemId, videoItemId]) {
				const res = await req(`/api/content/works/${workId}`, { headers });
				expect(res.status).toBe(200);
				const { work } = await res.json();
				expect(work.access.canAccess).toBe(false);

				// The pointers at the bytes — the actual bug this file exists for.
				expect(work.transcoding.hlsManifestUrl, `${who} hlsManifestUrl`).toBeNull();
				expect(work.transcoding.outputFileUrl, `${who} outputFileUrl`).toBeNull();
				expect(work.sourceKey).toBe("");
				// Status still flows, so a locked Work renders "Processing…" rather than a
				// blank frame. Withholding the URL is the fix; withholding the status isn't.
				expect(work.transcoding.status).toBe("completed");
			}
		}
	});

	it("withholds a locked text Work's prose, which IS its deliverable", async () => {
		const essay = await insertWork({
			creatorId,
			type: "text",
			title: "Locked Essay",
			bodyHtml: "<p>the gated prose</p>",
			...LOCKED,
		});
		const res = await req(`/api/content/works/${essay.id}`, { headers: { Cookie: viewerCookie } });
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.access.canAccess).toBe(false);
		expect(work.bodyHtml).toBe("");
	});

	/*
	 * Lyrics, which are the same shape of deliverable as prose and were the easiest thing
	 * in this file to get wrong: a new column that nobody thinks of as "media" quietly
	 * riding out past the gate with the title and the thumbnail.
	 *
	 * The second assertion is the one that stops the fix being "blank everything": the
	 * public blurb has to survive, or a locked Work cannot say what it is.
	 */
	it("withholds a locked track's lyrics but keeps its public blurb", async () => {
		const track = await insertWork({
			creatorId,
			type: "audio",
			title: "Locked Track",
			description: "A song about gates.",
			lyrics: "the gated words\nsecond line",
			...LOCKED,
		});
		const res = await req(`/api/content/works/${track.id}`, { headers: { Cookie: viewerCookie } });
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.access.canAccess).toBe(false);
		expect(work.lyrics).toBe("");
		expect(work.description).toBe("A song about gates.");
	});

	it("hands the lyrics over once the viewer can actually reach the track", async () => {
		// Free to everyone, so `canAccess` is true and the payload is the viewer's. Without
		// this case the assertion above passes against a build that never sends lyrics at
		// all — an "always empty" implementation is indistinguishable from a working gate
		// if you only ever look at the denied side.
		const track = await insertWork({
			creatorId,
			type: "audio",
			title: "Open Track",
			lyrics: "the open words",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		const res = await req(`/api/content/works/${track.id}`, { headers: { Cookie: viewerCookie } });
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.access.canAccess).toBe(true);
		expect(work.lyrics).toBe("the open words");
	});

	it("still hands the owner their own media URLs", async () => {
		for (const workId of [audioItemId, videoItemId]) {
			const res = await req(`/api/content/works/${workId}`, {
				headers: { Cookie: creatorCookie },
			});
			expect(res.status).toBe(200);
			const { work } = await res.json();
			const urls = [work.transcoding.outputFileUrl, work.transcoding.hlsManifestUrl];
			expect(urls.some((u) => u === AUDIO_URL || u === HLS_URL)).toBe(true);
		}
	});

	it("404s an unreleased Work for everyone but its creator", async () => {
		// Not a 403: the existence of unreleased work is itself not public information.
		const staging = await insertWork({
			creatorId,
			type: "video",
			title: "Still Editing",
			visibility: "private",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		const denied = await req(`/api/content/works/${staging.id}`, {
			headers: { Cookie: viewerCookie },
		});
		expect(denied.status).toBe(404);
		const owner = await req(`/api/content/works/${staging.id}`, {
			headers: { Cookie: creatorCookie },
		});
		expect(owner.status).toBe(200);
	});

	// ── The transcoding poller ─────────────────────────────────────────────────

	it("withholds media URLs from a denied viewer on the transcoding route", async () => {
		const res = await req(`/api/content/works/${videoItemId}/transcoding`, {
			headers: { Cookie: viewerCookie },
		});
		// Deliberately not a 403: the poller is allowed to learn that media is still
		// processing. What it must not be is a second door to the URLs detail withheld.
		expect(res.status).toBe(200);
		const { jobs } = await res.json();
		expect(jobs.length).toBeGreaterThan(0);
		for (const job of jobs) {
			expect(job.hlsManifestUrl).toBeNull();
			expect(job.outputFileUrl).toBeNull();
			expect(job.status).toBe("completed");
		}
	});

	it("hands the owner real URLs on the transcoding route", async () => {
		const res = await req(`/api/content/works/${videoItemId}/transcoding`, {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const { jobs } = await res.json();
		expect(jobs.flatMap((j: any) => [j.outputFileUrl, j.hlsManifestUrl])).toContain(HLS_URL);
	});

	// ── The audio endpoint ─────────────────────────────────────────────────────

	it("403s the audio endpoint for a denied viewer, and for an anonymous one", async () => {
		const cases: Record<string, string>[] = [{ Cookie: viewerCookie }, {}];
		for (const headers of cases) {
			const res = await req(`/api/content/works/${audioItemId}/audio`, {
				headers,
				redirect: "manual",
			});
			expect(res.status).toBe(403);
		}
	});

	it("redirects an entitled viewer to the media, uncacheably", async () => {
		const res = await req(`/api/content/works/${freeAudioId}/audio`, {
			headers: { Cookie: viewerCookie },
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBeTruthy();
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("rejects a non-numeric Work id instead of 500ing on it", async () => {
		const res = await req("/api/content/works/not-a-number/audio", {
			headers: { Cookie: viewerCookie },
			redirect: "manual",
		});
		expect(res.status).toBe(404);
	});

	// ── The Catalog listing ────────────────────────────────────────────────────

	it("withholds media URLs from a denied viewer across the whole Catalog listing", async () => {
		// The listing is a second door at the same rows, and a batch endpoint is exactly
		// where a per-item check gets forgotten.
		const res = await req(`/api/content/catalog/${creatorName}`, {
			headers: { Cookie: viewerCookie },
		});
		expect(res.status).toBe(200);
		const { works: listed } = await res.json();
		const locked = listed.filter((w: any) => !w.access.canAccess);
		expect(locked.length).toBeGreaterThan(0);
		for (const w of locked) {
			expect(w.sourceKey).toBe("");
			expect(w.transcoding?.hlsManifestUrl ?? null).toBeNull();
			expect(w.transcoding?.outputFileUrl ?? null).toBeNull();
		}
	});

	it("hides unreleased Works from the public Catalog but shows them to the creator", async () => {
		const publicView = await req(`/api/content/catalog/${creatorName}`, {
			headers: { Cookie: viewerCookie },
		});
		const ownerView = await req(`/api/content/catalog/${creatorName}`, {
			headers: { Cookie: creatorCookie },
		});
		const pub = (await publicView.json()).works as any[];
		const own = (await ownerView.json()).works as any[];
		expect(pub.every((w) => w.visibility === "released")).toBe(true);
		expect(own.length).toBeGreaterThan(pub.length);
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
		// `...row.post` used to spread the whole row here, body included — following a
		// creator is not access. A post carries no gate now, but the habit is what kept
		// the leak out, so the assertion stays.
		for (const p of posts) {
			expect(p.body).toBeUndefined();
			expect(p.bodyHtml).toBeUndefined();
		}
	});

	/**
	 * The delivery stamp, from the route rather than from the service.
	 *
	 * 🚨 `markPurchaseDownloaded` is now called from exactly ONE place — this route — since
	 * the P2P chunk endpoint that also called it was removed on 2026-08-11. Everything that
	 * reads `purchases.downloaded_at` is downstream of this single call: the refund cap
	 * counts only refunds where it is set, and `refunds.ts` books the delivery fee only when
	 * it is set. `refunds.test.ts` proves the service works when handed a row; nothing proved
	 * the route reaches it, which is precisely the shape of bug that survives a suite this
	 * size — a well-tested function nobody calls.
	 */
	it("stamps the buyer's purchase when they take the bytes", async () => {
		const [buyer] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, viewerName))
			.limit(1);

		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId: buyer.id,
				workId: freeWorkId,
				creatorId,
				workTitle: "Delivery stamp",
				workType: "game",
				workPublicId: null,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				deliveryFee: "0.10",
				crfFee: "0.00",
				salesTax: "0.00",
				creatorEarnings: "4.45",
				stripePaymentIntentId: `pi_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
				downloadedAt: null,
			})
			.returning();

		try {
			const res = await req(`/api/content/works/${freeWorkId}/assets/${freeAssetId}/download`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: viewerCookie },
			});
			expect(res.status).toBe(200);

			// Fire-and-forget on the route, so the write may land just after the response.
			let stamped: Date | null = null;
			for (let i = 0; i < 40 && !stamped; i++) {
				await new Promise((r) => setTimeout(r, 25));
				const [row] = await db
					.select({ downloadedAt: purchases.downloadedAt })
					.from(purchases)
					.where(eq(purchases.id, purchase.id))
					.limit(1);
				stamped = row?.downloadedAt ?? null;
			}
			expect(stamped).not.toBeNull();
		} finally {
			await db.delete(purchases).where(eq(purchases.id, purchase.id));
		}
	});
});
