// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Give the User Gauntlet fixture **real playable media**, through the real transcode path.
 *
 * The fixture used to seed nine posts whose only media was one asset row pointing at a zip
 * key no file backed. So nothing at any layer confirmed that a video plays or that bytes
 * arrive — the strongest media-adjacent assertion in the suite was that a "Downloads"
 * heading was visible. That matters more than it sounds: a delivery leak is precisely the
 * case where the resolver correctly says "gated" and a working URL sits in the same
 * response, and a suite that only reads access *reasons* cannot catch it by construction.
 *
 * What this does, per post in `GAUNTLET_MEDIA_POSTS`:
 *   1. generate a short clip with ffmpeg's synthetic sources (no binaries in the repo),
 *   2. upload it as the content item's source, exactly as an upload would,
 *   3. insert the `content_items` + `post_contents` + `transcoding_jobs` rows, then
 *   4. run the **actual job function** — `transcodeVideo` / `processAudio` — in-process.
 *
 * Step 4 is the point. Calling the job directly (rather than `queue.send`) sidesteps
 * pg-boss, which is not running here and whose absence is why `POST /content-items` 500s
 * for video and audio in tests — but it is the same code the worker runs, so the output is
 * a genuine HLS ladder and a genuine loudness-normalized MP3 with a real waveform, not a
 * hand-written row claiming to be one.
 *
 * **Why this lives in `apps/api` and not beside the rest of the fixture in `packages/db`:**
 * the transcode jobs and the storage service are the API's, and `packages/db` must not
 * depend upward on an app. The fixture's *shape* stays in `@anthers/db/gauntlet`, which
 * this reads; only the media production lives here.
 *
 * > [!warning] Local storage proves the ROUTE, not the ACL
 * > With `STORAGE_BACKEND=local`, `/content` serves everything unsigned and `getUrl`
 * > returns a plain URL — so no fixture, however real its media, exercises signing or the
 * > stored ACLs. What the walk gets from this is genuine: the access check, the playlist
 * > rewrite, the redirect, and real bytes over the wire. What it cannot get locally is
 * > proof that the stored object is private. That half is covered at the API layer by
 * > `storage-acl.test.ts`, which asserts the ACL passed at upload time.
 *
 * Usage: `bun run db:gauntlet:media` (run after `db:gauntlet`, which owns the posts).
 * A no-op with a loud notice when ffmpeg is absent, so a machine without it still gets a
 * working — if less thorough — gauntlet rather than a failed reset.
 *
 * Spec: `40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import {
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_MEDIA_POSTS,
	type GauntletPost,
} from "@anthers/db/gauntlet";
import { works, postContents, posts, transcodingJobs, users } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { processAudio } from "../jobs/process-audio.js";
import { transcodeVideo } from "../jobs/transcode-video.js";
import { storage } from "../services/storage/index.js";

const TAG = "[gauntlet-media]";

/**
 * Short on purpose. The video is 3s of the standard test pattern at 640×360 — small enough
 * that the whole ladder transcodes in a couple of seconds, tall enough that the job's
 * variant selection produces at least one rung rather than bailing out.
 */
const CLIP_SECONDS = 3;
const VIDEO_SIZE = "640x360";

async function ffmpegAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/** Generate a clip from ffmpeg's synthetic sources — nothing binary is committed. */
async function generateClip(kind: "video" | "audio"): Promise<string> {
	const path = join(
		tmpdir(),
		`gauntlet_${kind}_${randomUUID()}.${kind === "video" ? "mp4" : "mp3"}`,
	);
	const args =
		kind === "video"
			? [
					"ffmpeg",
					"-y",
					"-f",
					"lavfi",
					"-i",
					`testsrc=duration=${CLIP_SECONDS}:size=${VIDEO_SIZE}:rate=15`,
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=440:duration=${CLIP_SECONDS}`,
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-shortest",
					path,
				]
			: [
					"ffmpeg",
					"-y",
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=440:duration=${CLIP_SECONDS}`,
					"-c:a",
					"libmp3lame",
					path,
				];

	const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) {
		throw new Error(
			`ffmpeg failed generating the ${kind} clip:\n${await new Response(proc.stderr).text()}`,
		);
	}
	return path;
}

/** The gauntlet creator's id, or null when the fixture hasn't been seeded yet. */
async function creatorId(): Promise<number | null> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, GAUNTLET_CREATOR_USERNAME))
		.limit(1);
	return row?.id ?? null;
}

/**
 * Attach real media to one post. Idempotent by deletion: any content item already hanging
 * off this post is removed first, so re-running never accumulates duplicates (and a stale
 * item from a previous shape can't linger and be served).
 */
async function seedMediaFor(post: GauntletPost & { media: "video" | "audio" }, creator: number) {
	const [row] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.creatorId, creator), eq(posts.slug, post.slug)))
		.limit(1);
	if (!row) {
		throw new Error(
			`${TAG} fixture post ${post.slug} not found — run \`bun run db:gauntlet\` first`,
		);
	}

	const existing = await db
		.select({ workId: postContents.workId })
		.from(postContents)
		.where(eq(postContents.postId, row.id));
	const staleIds = existing.map((e) => e.workId).filter((id): id is number => id != null);
	if (staleIds.length > 0) await db.delete(works).where(inArray(works.id, staleIds));

	const clipPath = await generateClip(post.media);
	try {
		const ext = post.media === "video" ? "mp4" : "mp3";
		const sourceKey = `creators/${creator}/${post.media}/source/${randomUUID().replace(/-/g, "")}.${ext}`;
		// Sources are private: only derived, access-checked deliverables are ever served.
		await storage.upload(
			sourceKey,
			new Uint8Array(await Bun.file(clipPath).arrayBuffer()),
			post.media === "video" ? "video/mp4" : "audio/mpeg",
			"private",
		);

		const [item] = await db
			.insert(works)
			.values({
				creatorId: creator,
				type: post.media,
				title: post.title,
				description: post.body,
				sourceKey,
			})
			.returning({ id: works.id });
		await db
			.insert(postContents)
			.values({ postId: row.id, position: 0, kind: "content", workId: item.id });

		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId: item.id, mediaType: post.media, status: "pending", progress: 0 })
			.returning({ id: transcodingJobs.id });

		// The real job, in-process. pg-boss isn't running; this is the code it would run.
		if (post.media === "video") await transcodeVideo({ jobId: job.id });
		else await processAudio({ jobId: job.id });

		const [done] = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.id, job.id))
			.limit(1);
		if (done?.status !== "completed") {
			throw new Error(
				`${TAG} ${post.key} ${post.media} job finished as "${done?.status}": ${done?.errorMessage || "no error recorded"}`,
			);
		}
		console.log(`${TAG} ${post.key} (${post.slug}) → real ${post.media}, item ${item.id}`);
	} finally {
		await rm(clipPath, { force: true });
	}
}

async function main() {
	if (!(await ffmpegAvailable())) {
		console.warn(
			`${TAG} ffmpeg not found — SKIPPING media seeding.\n${TAG} The gauntlet will still walk, but its media posts carry no playable bytes,\n${TAG} so the delivery assertions will be skipped. Install ffmpeg to cover them.`,
		);
		return;
	}

	const creator = await creatorId();
	if (creator == null) {
		throw new Error(`${TAG} no gauntlet creator — run \`bun run db:gauntlet\` first`);
	}

	for (const post of GAUNTLET_MEDIA_POSTS) {
		await seedMediaFor(post, creator);
	}
	console.log(`${TAG} seeded ${GAUNTLET_MEDIA_POSTS.length} media post(s)`);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(`${TAG} failed:`, error);
		process.exit(1);
	});
