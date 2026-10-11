// SPDX-License-Identifier: Apache-2.0
/**
 * A video Work plays its original file, from the moment it exists, at an access-checked
 * route — the 2026-10-11 ruling's baseline (wiki 70.06), pinned end-to-end.
 *
 *   - `GET /works/:id/original` runs the same gate ladder the audio route runs (access,
 *     the Public Access meter, the household limit) and 302s to a freshly-minted signed
 *     address — never the stored key, which names the private bucket;
 *   - the Work's user-facing payload carries `originalUrl` at that route for anyone who
 *     may reach the Work at all, and the meter bites at the route, not in the payload;
 *   - a video with no file yet, and a non-video kind, find nothing there (404s), and
 *     the creator reaches their own original like any other viewer.
 *
 * ⚠️ **The delivery rewrite only exists under `STORAGE_BACKEND=s3`, and that environment
 * cannot be set inside a suite** — one `bun test` invocation is one process, sharing
 * `process.env` with every sibling file loaded after it. So this file is two roles, the
 * shape `owner-hls-preview.test.ts` carries: when loaded normally it DRIVES, spawning a
 * child `bun test` of this same file under the s3 environment, and the child runs the
 * assertions that matter. Nothing here stores a byte — the storage stand-in answers
 * 404 for every probe, which is all `userTranscoding`'s existence checks need to see.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/** The mode flag the driver sets for the child, and only the child sees set. */
const MODE_ENV = "ANTERS_TEST_S3_DELIVERY";

if (process.env[MODE_ENV] === "1") {
	await runDeliveryModeSuite();
} else {
	describe("a video's original is playable (driven)", () => {
		it("runs the s3-delivery suite in a child process, so its storage environment cannot reach a sibling file", async () => {
			const proc = Bun.spawn(["bun", "test", import.meta.path], {
				// The api workspace's own bunfig, whose preload brings the child its session.
				cwd: join(import.meta.dir, "../.."),
				env: { ...process.env, [MODE_ENV]: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (stdout) console.log(`child stdout:\n${stdout}`);
			if (stderr) console.log(`child stderr:\n${stderr}`);
			expect(code, "the s3-delivery child must exit green; see its output above").toBe(0);
		}, 180_000);
	});
}

/** The body of the suite, run only where the delivery environment is in force. */
async function runDeliveryModeSuite(): Promise<void> {
	// Imports are dynamic because everything below belongs to the child — the driver role
	// never needs the app or the fixtures, and the app's imports read the `STORAGE_*`
	// environment this body sets first.
	const { afterAll, beforeAll } = await import("bun:test");
	const { db } = await import("@anthers/db/client");
	const { attentionEvents } = await import("@anthers/db/schema");
	const { cycleKeyFor, cycleStart } = await import("@anthers/shared/billing-cycle");
	const { FREE_PUBLIC_ACCESS_SECONDS } = await import("@anthers/shared/public-access");
	const { createAccount } = await import("./account-fixture");
	const { purgeAccountsCreatedHere } = await import("./cleanup");
	const { DB_SETUP_TIMEOUT } = await import("./setup-timeouts.js");
	const { insertWork } = await import("./work-fixtures.js");

	// A bare HTTP stand-in for object storage, answering 404 for every probe. Nothing is
	// stored anywhere — every `STORAGE_*` value is fake — and the only prober in play is
	// `userTranscoding`'s audio-rendition existence check, which a 404 declines.
	const storageStandIn = Bun.serve({
		port: 0,
		fetch() {
			return new Response(null, { status: 404 });
		},
	});

	const BUCKET = "anthers-test-bucket";
	process.env.STORAGE_BACKEND = "s3";
	process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${storageStandIn.port}`;
	process.env.STORAGE_REGION = "anthers-test";
	process.env.STORAGE_BUCKET = BUCKET;
	process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.anthers.org";
	process.env.STORAGE_KEY = "test-key";
	process.env.STORAGE_SECRET = "test-secret";
	process.env.STORAGE_FORCE_PATH_STYLE = "true";

	const app = (await import("../index")).default;

	const ORIGIN = "http://localhost:3000";

	function req(path: string, options?: RequestInit) {
		return app.fetch(new Request(`http://localhost${path}`, options));
	}

	async function fetchWork(workId: number, cookie: string) {
		const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: cookie } });
		const { work } = (await res.json()) as {
			work: { originalUrl: string | null; sourceKey: string };
		};
		return work;
	}

	/**
	 * Spend `seconds` of the commons for the viewer, anchored at the start of the
	 * cycle exactly as public-access-meter.test.ts's own helper is — the meter reads
	 * a range split against the calendar-month window, so a duration-only row
	 * undercounts anywhere but the month's first second.
	 */
	async function spend(userId: number, workId: number, seconds: number) {
		const endedAt = cycleStart(cycleKeyFor(new Date()));
		endedAt.setUTCSeconds(endedAt.getUTCSeconds() + seconds);
		await db.insert(attentionEvents).values({
			userId,
			creatorId,
			workId,
			eventType: "watch",
			durationSeconds: seconds,
			startedAt: cycleStart(cycleKeyFor(new Date())),
			endedAt,
			clientId: `fixture-${userId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
			publicAccess: true,
		});
	}

	// Every account this suite creates is taken back afterward, on success or failure —
	// and the Works cascade with the creator. Nothing was stored.
	purgeAccountsCreatedHere();
	afterAll(() => storageStandIn.stop(true));

	const id = crypto.randomUUID().slice(0, 8);
	const creatorName = `vorig_c_${id}`;
	const viewerName = `vorig_v_${id}`;

	/** Ungated + streaming + free to everyone, i.e. Public Access. */
	const PUBLIC_ACCESS = [{ threshold: 0, allow: true, price: "0" }];
	/** Gated at $1 — reachable to the fixture ladder, refused to the plain viewer. */
	const SEED_GATED = [
		{ threshold: 0, allow: false, price: "0" },
		{ threshold: 1, allow: true, price: "0" },
	];

	let creatorCookie: string;
	let creatorId: number;
	let viewerCookie: string;
	let viewerId: number;
	let videoId: number;
	let gatedVideoId: number;
	let filelessVideoId: number;
	let audioWorkId: number;

	describe("the original is the day-one deliverable", () => {
		beforeAll(async () => {
			const creator = await createAccount(creatorName);
			creatorId = creator.userId;
			creatorCookie = creator.cookie;
			const viewer = await createAccount(viewerName);
			viewerCookie = viewer.cookie;
			viewerId = viewer.userId;

			videoId = (
				await insertWork({
					creatorId,
					type: "video",
					title: "Public Access video",
					streamEnabled: true,
					sourceKey: `creators/${creatorId}/videos/originals/day-one-${id}.mp4`,
					access: PUBLIC_ACCESS,
				})
			).id;

			gatedVideoId = (
				await insertWork({
					creatorId,
					type: "video",
					title: "Gated video",
					streamEnabled: true,
					sourceKey: `creators/${creatorId}/videos/originals/gated-${id}.mp4`,
					access: SEED_GATED,
				})
			).id;

			filelessVideoId = (
				await insertWork({
					creatorId,
					type: "video",
					title: "Video with no file yet",
					streamEnabled: true,
					sourceKey: "",
					access: PUBLIC_ACCESS,
				})
			).id;

			audioWorkId = (
				await insertWork({
					creatorId,
					type: "audio",
					title: "Track (its original is not a play surface)",
					streamEnabled: true,
					sourceKey: `creators/${creatorId}/audio/sources/track-${id}.wav`,
					access: PUBLIC_ACCESS,
				})
			).id;
		}, DB_SETUP_TIMEOUT);

		it("hands an entitled viewer the original at the access-checked route", async () => {
			const work = await fetchWork(videoId, viewerCookie);
			expect(work.originalUrl).toBe(`${ORIGIN}/api/content/works/${videoId}/original`);
		});

		it("never hands out a presigned address in the payload — addresses mint only at the gate", async () => {
			const res = await req(`/api/content/works/${videoId}`, { headers: { Cookie: viewerCookie } });
			const body = JSON.stringify(await res.json());
			// A public chrome address (the thumbnail) may ride — it is the CDN's own —
			// but nothing in the payload may carry a presigned media address, which
			// only the delivery routes mint, after the gate ladder answers.
			expect(body).not.toContain("X-Amz-");
		});

		it("the original route serves a fresh signed address, never a bare public one", async () => {
			const res = await req(`/api/content/works/${videoId}/original`, {
				headers: { Cookie: viewerCookie },
			});
			expect(res.status).toBe(302);
			// no-store: the 302 carries a signed URL and is access-dependent, so a proxy
			// must never cache and replay it.
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			const location = res.headers.get("Location");
			expect(location).not.toBeNull();
			// The URL is presigned — a query signature carried to the S3 endpoint, per
			// `storage/config.ts` — and is not the bare public CDN address, which a
			// private object answers only as a 404 no matter who it reaches.
			// It is also not this api host: the request the player then makes does not
			// loop back through the gate.
			expect(location).toContain("X-Amz-");
			expect(location?.startsWith(`${ORIGIN}/api/`)).toBe(false);
			expect(location?.startsWith("https://cdn.anthers.org")).toBe(false);
		});

		it("the creator reaches their own original through the same gate ladder", async () => {
			const res = await req(`/api/content/works/${videoId}/original`, {
				headers: { Cookie: creatorCookie },
			});
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).not.toBeNull();
		});

		it("the owner's shape carries the original too, for the Studio's own preview", async () => {
			const work = await fetchWork(videoId, creatorCookie);
			expect(work.originalUrl).toBe(`${ORIGIN}/api/content/works/${videoId}/original`);
		});

		it("refuses a viewer whose allowance is spent with a real 402", async () => {
			await spend(viewerId, videoId, FREE_PUBLIC_ACCESS_SECONDS);
			const res = await req(`/api/content/works/${videoId}/original`, {
				headers: { Cookie: viewerCookie },
			});
			expect(res.status).toBe(402);
			// 403 would say "you may not"; the truth is "you may, and here is how".
			expect((await res.json()).error).toBeDefined();
			expect(res.headers.get("Location")).toBeNull();
		});

		it("refuses a viewer the gate refuses — 403, and the payload carries no address", async () => {
			const res = await req(`/api/content/works/${gatedVideoId}/original`, {
				headers: { Cookie: viewerCookie },
			});
			expect(res.status).toBe(403);
			const work = await fetchWork(gatedVideoId, viewerCookie);
			expect(work.originalUrl).toBeNull();
		});

		it("an accountless request never reaches the meter at all", async () => {
			expect((await req(`/api/content/works/${videoId}/original`)).status).toBe(401);
		});

		it("a video with no file, and a non-video kind, find nothing to serve", async () => {
			expect(
				(
					await req(`/api/content/works/${filelessVideoId}/original`, {
						headers: { Cookie: viewerCookie },
					})
				).status,
			).toBe(404);
			expect(
				(
					await req(`/api/content/works/${audioWorkId}/original`, {
						headers: { Cookie: viewerCookie },
					})
				).status,
			).toBe(404);
		});

		it("a fileless video's payload carries no original either", async () => {
			const work = await fetchWork(filelessVideoId, viewerCookie);
			expect(work.originalUrl).toBeNull();
		});
	});
}
