// SPDX-License-Identifier: Apache-2.0
/**
 * A packaged shell's `<video>` and `<audio>` elements can play a Work.
 *
 * 🚨 **This is the delivery door's second credential, and its absence is silent.** A shell
 * serves from `tauri.localhost`, so the `.anthers.org` session cookie is never sent, and a
 * media element cannot attach the `Authorization: Bearer` header the rest of the app uses.
 * Before the media token, every video and audio Work fetched in a shell carried delivery
 * URLs that 401'd the moment the player touched them — the page looked right, the tap
 * landed, and nothing played. The browser path stayed green throughout because its cookie
 * is sent on the same request, which is why this needs a *bearer* request and a *bare* one
 * in the same file.
 *
 * ⚠️ **The delivery rewrite only exists under `STORAGE_BACKEND=s3`**, and that environment
 * cannot be set inside a suite — one `bun test` invocation is one process, sharing
 * `process.env` with every sibling file loaded after it. So this file is two roles, the
 * shape `original-delivery.test.ts` carries: when loaded normally it DRIVES, spawning a
 * child `bun test` of this same file under the s3 environment, and the child runs the
 * assertions that matter. Nothing here stores a byte — the storage stand-in answers the
 * two playlist reads the HLS route needs and 404s everything else.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/** The mode flag the driver sets for the child, and only the child sees set. */
const MODE_ENV = "ANTHERS_TEST_SHELL_MEDIA";

if (process.env[MODE_ENV] === "1") {
	await runShellMediaSuite();
} else {
	describe("shell media delivery (driven)", () => {
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
			expect(code, "the shell-media child must exit green; see its output above").toBe(0);
		}, 180_000);
	});
}

/** The body of the suite, run only where the delivery environment is in force. */
async function runShellMediaSuite(): Promise<void> {
	// Imports are dynamic because everything below belongs to the child — the driver role
	// never needs the app or the fixtures, and the app's imports read the `STORAGE_*`
	// environment this body sets first.
	const { afterAll, beforeAll } = await import("bun:test");
	const { db } = await import("@anthers/db/client");
	const { workTranscodingJobs } = await import("@anthers/db/schema");
	const { createAccount } = await import("./account-fixture");
	const { purgeAccountsCreatedHere } = await import("./cleanup");
	const { DB_SETUP_TIMEOUT } = await import("./setup-timeouts.js");
	const { insertWork } = await import("./work-fixtures.js");

	// The two playlist reads the HLS route makes. A master names one variant, which names
	// one segment; nothing else is ever fetched, because every other probe is an existence
	// check that a 404 declines.
	const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n720p.m3u8\n";
	const VARIANT = "#EXTM3U\n#EXTINF:6,\n720p_000.ts\n";
	const storageStandIn = Bun.serve({
		port: 0,
		fetch(request) {
			const file = new URL(request.url).pathname.split("/").pop();
			if (file === "master.m3u8") {
				return new Response(MASTER, {
					headers: { "Content-Type": "application/vnd.apple.mpegurl" },
				});
			}
			if (file === "720p.m3u8") {
				return new Response(VARIANT, {
					headers: { "Content-Type": "application/vnd.apple.mpegurl" },
				});
			}
			return new Response(null, { status: 404 });
		},
	});

	process.env.STORAGE_BACKEND = "s3";
	process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${storageStandIn.port}`;
	process.env.STORAGE_REGION = "anthers-test";
	process.env.STORAGE_BUCKET = "anthers-test-bucket";
	process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.anthers.org";
	process.env.STORAGE_KEY = "test-key";
	process.env.STORAGE_SECRET = "test-secret";
	process.env.STORAGE_FORCE_PATH_STYLE = "true";
	process.env.WEB_BUILD_SIGNING_KEY = "test-shell-media-signing-key";

	const app = (await import("../index")).default;

	function req(path: string, options?: RequestInit) {
		return app.fetch(new Request(`http://localhost${path}`, options));
	}

	/** A delivery URL as the media element would request it: path and query, no header. */
	function asMediaElement(url: string): string {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.search}`;
	}

	const PUBLIC_ACCESS = { access: [{ threshold: 0, allow: true, price: "0" }] };
	const id = crypto.randomUUID().slice(0, 8);
	const creatorName = `shell_creator_${id}`;
	const viewerName = `shell_viewer_${id}`;

	purgeAccountsCreatedHere();

	describe("a packaged shell's media delivery", () => {
		let viewerToken: string;
		let viewerCookie: string;
		let audioId: number;
		let videoId: number;

		beforeAll(async () => {
			const creator = await createAccount(creatorName);
			const viewer = await createAccount(viewerName);
			viewerToken = viewer.token;
			viewerCookie = viewer.cookie;

			const audio = await insertWork({
				creatorId: creator.userId,
				type: "audio",
				title: "Shell audio",
				streamEnabled: true,
				...PUBLIC_ACCESS,
			});
			audioId = audio.id;
			await db.insert(workTranscodingJobs).values({
				workId: audioId,
				mediaType: "audio",
				status: "completed",
				outputFileUrl: `https://cdn.example.com/creators/${creator.userId}/audio/processed/open.mp3`,
			});

			const video = await insertWork({
				creatorId: creator.userId,
				type: "video",
				title: "Shell video",
				streamEnabled: true,
				...PUBLIC_ACCESS,
			});
			videoId = video.id;
			await db.insert(workTranscodingJobs).values({
				workId: videoId,
				mediaType: "video",
				status: "completed",
				hlsManifestUrl: `https://cdn.example.com/creators/${creator.userId}/videos/hls/open/master.m3u8`,
			});
		}, DB_SETUP_TIMEOUT);

		afterAll(() => {
			storageStandIn.stop(true);
		});

		it("puts a media token on every delivery URL a bearer request receives", async () => {
			const bearer = { Authorization: `Bearer ${viewerToken}` };
			const audio = await (await req(`/api/content/works/${audioId}`, { headers: bearer })).json();
			const video = await (await req(`/api/content/works/${videoId}`, { headers: bearer })).json();

			expect(audio.work.transcoding.outputFileUrl).toContain("media=");
			expect(video.work.transcoding.hlsManifestUrl).toContain("media=");
		});

		it("🚨 lets a bare media-element request through the audio route with that token", async () => {
			// No Cookie and no Authorization — exactly what an `<audio src>` sends. This was
			// the 401 that made pressing play do nothing in the shell.
			const bearer = { Authorization: `Bearer ${viewerToken}` };
			const payload = await (
				await req(`/api/content/works/${audioId}`, { headers: bearer })
			).json();
			const res = await req(asMediaElement(payload.work.transcoding.outputFileUrl), {
				redirect: "manual",
			});
			expect(res.status).toBe(302);
		});

		it("🚨 carries the token onto the HLS master's variant URLs, and the variant plays bare", async () => {
			const bearer = { Authorization: `Bearer ${viewerToken}` };
			const payload = await (
				await req(`/api/content/works/${videoId}`, { headers: bearer })
			).json();
			const master = await req(asMediaElement(payload.work.transcoding.hlsManifestUrl));
			expect(master.status).toBe(200);
			const variant = (await master.text())
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line && !line.startsWith("#"));
			expect(variant).toBeTruthy();
			expect(variant).toContain("media=");
			const variantRes = await req(asMediaElement(variant!));
			expect(variantRes.status).toBe(200);
		});

		it("puts a media token on the transcoding poll's URLs too", async () => {
			// The Studio's player reads this route while a transcode runs, so the same
			// bearer-only rule applies to it. It resolves auth through `getOptionalUserId`
			// rather than `requireAuth`, which is why the route has to pass the account on.
			const res = await req(`/api/content/works/${audioId}/transcoding`, {
				headers: { Authorization: `Bearer ${viewerToken}` },
			});
			const { jobs } = await res.json();
			expect(jobs[0].outputFileUrl).toContain("media=");
		});

		it("does not leak a media token to a browser request, which has its cookie", async () => {
			const res = await req(`/api/content/works/${audioId}`, {
				headers: { Cookie: viewerCookie },
			});
			const { work } = await res.json();
			expect(work.transcoding.outputFileUrl).not.toContain("media=");
		});

		it("scopes a media token to the Work it names", async () => {
			const bearer = { Authorization: `Bearer ${viewerToken}` };
			const payload = await (
				await req(`/api/content/works/${audioId}`, { headers: bearer })
			).json();
			const token = new URL(payload.work.transcoding.outputFileUrl).searchParams.get("media");
			expect(token).toBeTruthy();
			// The audio token on the video Work's audio route: the door must refuse, not
			// authenticate as the viewer and 404 on the missing job.
			const res = await req(
				`/api/content/works/${videoId}/audio?media=${encodeURIComponent(token!)}`,
			);
			expect(res.status).toBe(401);
		});

		it("does not turn a media token into a session for a non-media route", async () => {
			const bearer = { Authorization: `Bearer ${viewerToken}` };
			const payload = await (
				await req(`/api/content/works/${audioId}`, { headers: bearer })
			).json();
			const token = new URL(payload.work.transcoding.outputFileUrl).searchParams.get("media");
			// The Work page is a read route with optional auth, not the delivery door. The
			// token names an account but is not a session, so the signed-out shape must hold.
			const res = await req(`/api/content/works/${audioId}?media=${encodeURIComponent(token!)}`);
			const { work } = await res.json();
			expect(work.transcoding.outputFileUrl).toBeNull();
			expect(work.access.canAccess).toBe(false);
		});
	});
}
