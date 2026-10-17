// SPDX-License-Identifier: Apache-2.0
/**
 * A creator plays their own finished video Work from the Studio, through the same
 * access-checked delivery route every other viewer gets.
 *
 * 🚨 **The owner branch of `GET /works/:id` was the one branch that returned the transcode
 * row without `userTranscoding`'s rewrite, and that meant the STORED URL.** A row's
 * `hls_manifest_url` is a CDN address over the private bucket — in production a 404, and
 * nowhere a host that permits the browser's player — so the creator's own preview died on
 * the very Work they made, while every other viewer's played. The fix runs the owner's job
 * through that same rewrite with access asserted outright, because a creator may always
 * see their own media.
 *
 * ⚠️ **The delivery rewrite only exists under `STORAGE_BACKEND=s3`, and that environment
 * cannot be set inside a suite.** One `bun test` invocation is one process: a shared module
 * registry and a shared `process.env` across every file it loads, in no order a suite can
 * rely on — so a file that flipped the backend for itself would also hand production
 * delivery to any sibling loaded afterward, the same trap storage-acl.test.ts records for
 * the storage config. So this file is two roles. When `bun test` loads it normally, it only
 * DRIVES: it spawns a child `bun test` of this same file under the s3 environment, so the
 * mode lives and dies wholly inside the child's process. The child takes the other role and
 * runs the assertions that matter.
 *
 * The child's storage is pointed at a loopback HTTP server this file itself hosts, which
 * answers HEAD for the paths `confirmRendition` marks and 404 for everything else — that is
 * where `userTranscoding`'s "does the audio rendition exist?" probe arrives, so the
 * report-it-only-when-confirmable rule is exercised both ways. Byte-accurate playlists are
 * share-link-hls.test.ts's subject; this file is about who is handed the route URL.
 *
 * The save routes are held to the same rewrite (Parker, 2026-10-16 — the Studio's video
 * player flipped to the raw URL the moment a thumbnail save adopted the response, and the
 * console filled with 404s): the work edit (`PATCH /works/:id`) and the frame-thumbnail
 * (`POST /works/:id/thumbnail-frame`) responses answer a creator with a rewritten row too.
 */

import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The mode flag the driver sets for the child, and only the child sees set. */
const MODE_ENV = "ANTERS_TEST_S3_DELIVERY";

if (process.env[MODE_ENV] === "1") {
	await runDeliveryModeSuite();
} else {
	describe("the owner's own preview plays (driven)", () => {
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
			// The child's own results are the point — surface them rather than only reporting
			// the parent's assertion, so a scoped run shows which assertions moved.
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
	const { eq } = await import("drizzle-orm");
	const { db } = await import("@anthers/db/client");
	const { transcodingJobs, works } = await import("@anthers/db/schema");
	const { createAccount } = await import("./account-fixture");
	const { purgeAccountsCreatedHere } = await import("./cleanup");
	const { DB_SETUP_TIMEOUT } = await import("./setup-timeouts.js");
	const { insertWork } = await import("./work-fixtures.js");

	// A bare HTTP server standing in for object storage: a storage existence probe
	// (HeadObject under path-style addressing, bucket as the first path segment) is
	// answered 200 only for the paths `confirmRendition` marks, 404 otherwise. Nothing is
	// stored anywhere — every `STORAGE_*` value is fake.
	const confirmedPaths = new Set<string>();
	/** Bytes the run's own PUTs wrote, by path — the frame route reads its source this way. */
	const storedBytes = new Map<string, ArrayBuffer>();
	const storageStandIn = Bun.serve({
		port: 0,
		async fetch(request): Promise<Response> {
			const pathname = new URL(request.url).pathname;
			if (request.method === "PUT") {
				// A route's `storage.upload` — record the address and the bytes, so a later
				// HEAD confirms the object and a later GET (a signed input URL) carries it.
				storedBytes.set(pathname, await request.arrayBuffer());
				confirmedPaths.add(pathname);
				return new Response(null, { status: 200 });
			}
			if (request.method === "HEAD" && confirmedPaths.has(pathname))
				return new Response(null, { status: 200 });
			const bytes = storedBytes.get(pathname);
			if (request.method === "GET" && bytes) return new Response(bytes);
			return new Response(null, { status: 404 });
		},
	});

	// The delivery-mode environment, laid down before the app is imported — hence the
	// dynamic import of the app below instead of a hoisted static one: the storage factory
	// reads the backend and every S3 value once, at import.
	const BUCKET = "anthers-test-bucket";
	process.env.STORAGE_BACKEND = "s3";
	process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${storageStandIn.port}`;
	process.env.STORAGE_REGION = "anthers-test";
	process.env.STORAGE_BUCKET = BUCKET;
	process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.anthers.org";
	process.env.STORAGE_KEY = "test-key";
	process.env.STORAGE_SECRET = "test-secret";
	// Path-style, so a probe is `${endpoint}/${bucket}/${key}` and this server's fetch
	// sees the bucket as the leading path segment.
	process.env.STORAGE_FORCE_PATH_STYLE = "true";

	const app = (await import("../index")).default;

	// pg-boss is not running under the test runner, and the routes this suite drives
	// enqueue on their way out (a save queues its listing sync, a frame queues its scan).
	// The enqueue is not this suite's subject, so the shared queue singleton records and
	// succeeds instead — which is also why a save route can answer at all here.
	const { queue } = await import("../jobs/queue.js");
	let enqueued = 0;
	queue.send = async <T>(_name: string, _data: T, _options?: unknown) => `stub-${++enqueued}`;

	const ORIGIN = "http://localhost:3000";

	function req(path: string, options?: RequestInit) {
		return app.fetch(new Request(`http://localhost${path}`, options));
	}

	/** The bare storage address a real video transcode persists — the CDN URL. */
	function storedHlsUrl(workId: number): string {
		return `https://cdn.anthers.org/creators/x/videos/hls/${workId}/master.m3u8?fixture=${id}`;
	}

	/**
	 * Marks the path whose stand-in storage answers 200 — the audio-only rendition at
	 * `workId`'s manifest prefix, exactly where a real transcode parks it.
	 */
	function confirmRendition(workId: number): void {
		confirmedPaths.add(`/${BUCKET}/creators/x/videos/hls/${workId}/audio.m3u8`);
	}

	// Every account this suite creates is taken back afterward, on success or failure —
	// and the Works and their transcode rows cascade with the creator. Nothing was stored.
	purgeAccountsCreatedHere();
	afterAll(() => storageStandIn.stop(true));

	const id = crypto.randomUUID().slice(0, 8);
	const creatorName = `ohlp_c_${id}`;

	let creatorCookie: string;
	let creatorId: number;
	/** A video whose audio-only rendition the stand-in storage confirms. */
	let withRenditionId: number;
	/** A video whose audio-only rendition nothing confirms. */
	let withoutRenditionId: number;
	/** An audio Work, whose processed file rides its own access-checked endpoint. */
	let audioId: number;
	/** A video with real source bytes, so the frame-thumbnail route can extract from it. */
	let frameId: number;

	/** A synthetic two-second video, the input the frame route reads through a signed URL. */
	async function makeVideo(): Promise<Buffer> {
		const path = join(tmpdir(), `ohlp_frame_${id}.mp4`);
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc=duration=2:size=160x120:rate=10",
				"-pix_fmt",
				"yuv420p",
				path,
				"-y",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await proc.exited).toBe(0);
		const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
		await rm(path).catch(() => {});
		return bytes;
	}

	describe("the owner's own preview plays", () => {
		beforeAll(async () => {
			const creator = await createAccount(creatorName);
			creatorId = creator.userId;
			creatorCookie = creator.cookie;

			withRenditionId = (
				await insertWork({
					creatorId,
					type: "video",
					title: "Finished video, with podcast rendition",
					streamEnabled: true,
					access: [{ threshold: 0, allow: true, price: "0" }],
				})
			).id;
			confirmRendition(withRenditionId);
			await db.insert(transcodingJobs).values({
				workId: withRenditionId,
				mediaType: "video",
				status: "completed",
				hlsManifestUrl: storedHlsUrl(withRenditionId),
			});

			withoutRenditionId = (
				await insertWork({
					creatorId,
					type: "video",
					title: "Finished video, no podcast rendition",
					streamEnabled: true,
					access: [{ threshold: 0, allow: true, price: "0" }],
				})
			).id;
			await db.insert(transcodingJobs).values({
				workId: withoutRenditionId,
				mediaType: "video",
				status: "completed",
				hlsManifestUrl: storedHlsUrl(withoutRenditionId),
			});

			audioId = (
				await insertWork({
					creatorId,
					type: "audio",
					title: "Finished track",
					streamEnabled: true,
					access: [{ threshold: 0, allow: true, price: "0" }],
				})
			).id;
			await db.insert(transcodingJobs).values({
				workId: audioId,
				mediaType: "audio",
				status: "completed",
				outputFileUrl: `https://cdn.anthers.org/creators/x/audio/processed/${id}.mp3`,
			});

			// The frame route's work: real bytes at a private source key, and a completed
			// transcode row carrying the raw stored CDN URL exactly as a real transcode
			// persists it — the shape the save responses were leaking.
			frameId = (await insertWork({ creatorId, type: "video", title: `Frame video ${id}` })).id;
			const frameSourceKey = `creators/${creatorId}/videos/originals/frame-${id}.mp4`;
			const { storage } = await import("../services/storage/index.js");
			await storage.upload(frameSourceKey, await makeVideo(), "video/mp4", "private");
			await db.update(works).set({ sourceKey: frameSourceKey }).where(eq(works.id, frameId));
			await db.insert(transcodingJobs).values({
				workId: frameId,
				mediaType: "video",
				status: "completed",
				hlsManifestUrl: storedHlsUrl(frameId),
			});
		}, DB_SETUP_TIMEOUT);

		it("serves the owner's video manifest from the access-checked route, never the bare bucket URL", async () => {
			const res = await req(`/api/content/works/${withRenditionId}`, {
				headers: { Cookie: creatorCookie },
			});
			expect(res.status).toBe(200);
			const { work } = await res.json();

			// The owner shape itself answered — the editable access table, not a verdict,
			// is what the Studio's editor round-trips.
			expect(Array.isArray(work.access)).toBe(true);
			expect(work.transcoding.hlsManifestUrl).toBe(
				`${ORIGIN}/api/content/works/${withRenditionId}/hls/master.m3u8`,
			);
			// The rendition the storage layer confirms rides the same route.
			expect(work.transcoding.audioManifestUrl).toBe(
				`${ORIGIN}/api/content/works/${withRenditionId}/hls/audio.m3u8`,
			);
			// Every address the transcode carries reaches a browser only after the rewrite,
			// which is the whole property: the stored URL names the private bucket.
			expect(JSON.stringify(work.transcoding)).not.toContain("cdn.");
		});

		it("withholds a rendition nothing confirms, while keeping the manifest rewrite", async () => {
			const res = await req(`/api/content/works/${withoutRenditionId}`, {
				headers: { Cookie: creatorCookie },
			});
			expect(res.status).toBe(200);
			const { work } = await res.json();
			expect(work.transcoding.hlsManifestUrl).toBe(
				`${ORIGIN}/api/content/works/${withoutRenditionId}/hls/master.m3u8`,
			);
			expect(work.transcoding.audioManifestUrl).toBeNull();
			expect(JSON.stringify(work.transcoding)).not.toContain("cdn.");
		});

		it("serves the owner's audio deliverable from the access-checked endpoint too", async () => {
			const res = await req(`/api/content/works/${audioId}`, {
				headers: { Cookie: creatorCookie },
			});
			expect(res.status).toBe(200);
			const { work } = await res.json();
			expect(work.transcoding.outputFileUrl).toBe(`${ORIGIN}/api/content/works/${audioId}/audio`);
			expect(JSON.stringify(work.transcoding)).not.toContain("cdn.");
		});

		it("a save's response runs the same rewrite, so the player never flips to the raw URL", async () => {
			// The edit route passes the job row through `serializeWork` whole, and the
			// Studio adopts the response — this save is where the leak showed.
			const res = await req(`/api/content/works/${withRenditionId}`, {
				method: "PATCH",
				headers: { Cookie: creatorCookie, "Content-Type": "application/json", Origin: ORIGIN },
				body: JSON.stringify({ description: `Save-rewritten row ${id}` }),
			});
			expect(res.status).toBe(200);
			const { work } = await res.json();
			expect(work.transcoding.hlsManifestUrl).toBe(
				`${ORIGIN}/api/content/works/${withRenditionId}/hls/master.m3u8`,
			);
			expect(work.transcoding.audioManifestUrl).toBe(
				`${ORIGIN}/api/content/works/${withRenditionId}/hls/audio.m3u8`,
			);
			expect(JSON.stringify(work.transcoding)).not.toContain("cdn.");
		});

		it("taking a frame answers with the rewritten row too", async () => {
			const res = await req(`/api/content/works/${frameId}/thumbnail-frame`, {
				method: "POST",
				headers: { Cookie: creatorCookie, "Content-Type": "application/json", Origin: ORIGIN },
				body: JSON.stringify({ atSeconds: 0.5 }),
			});
			expect(res.status).toBe(200);
			const { work } = await res.json();
			// The frame itself was stored and set, and the row's URLs were rewritten.
			expect(work.thumbnail).toContain("/thumbnails/");
			expect(work.transcoding.hlsManifestUrl).toBe(
				`${ORIGIN}/api/content/works/${frameId}/hls/master.m3u8`,
			);
			expect(JSON.stringify(work.transcoding)).not.toContain("cdn.");
		});
	});
}
