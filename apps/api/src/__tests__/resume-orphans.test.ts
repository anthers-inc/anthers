// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The worker's boot-time recovery of interrupted transcodes.
 *
 * 🚨 **This sweep ran uncovered from the day its guard shipped, and that was measured
 * rather than assumed:** sabotaging the `sourceKey` guard to a no-op left all 41 tests in
 * `post-lifecycle` + `delivery-access` green. The prediction had been that at least one
 * would fail; being wrong was the finding. Those suites insert `transcoding_jobs` rows to
 * simulate an encode in flight, which looks like coverage of this code and is not — they
 * exercise the *release gate* that reads the rows, never the sweep that rewrites them.
 * Same family as the DMCA restore cron, whose selector was broken on every run since it
 * shipped while thirteen tests exercised the manual path beside it.
 *
 * The reason it was uncovered was structural, so the fix was too: `resumeOrphanedTranscodes`
 * now lives in `jobs/resume-orphans.ts` instead of `jobs/worker.ts`, which calls `start()`
 * at module scope — importing that from a test booted a real worker against pg-boss and
 * never returned.
 *
 * ⚠️ **Assertions are scoped to the rows this file creates, deliberately.** The sweep is
 * global by design (it is recovery, not a query), so against the shared dev database its
 * summary counts include whatever litter other suites have left. Asserting on
 * `summary.resumed` would make this suite pass or fail on the state of the database rather
 * than on its own fixture — so every assertion below filters to a known job id.
 *
 * **Sabotage-verified 1 / 2 / 1, all three predicted correctly and all three MEASURED —
 * these numbers are not guesses.** Removing the `sourceKey` split so every row is resumable
 * (the pre-guard behavior) fails 1. Putting back the `video ? TRANSCODE : PROCESS_AUDIO`
 * ternary fails 2 — the ebook routing AND the unknown-type skip, since under a ternary
 * there is no such thing as an unrecognized type: everything that is not video is audio.
 * Widening the status filter to include `completed` fails 1. Each sabotage was `grep`ed
 * for before running, because a no-op sabotage comes back fully green and reads exactly
 * like "this test proves nothing", which is the most convincing possible false result.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { QUEUES } from "../jobs/queue";
import { resumeOrphanedTranscodes, type SendJob } from "../jobs/resume-orphans";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const ownerName = `ro_${id}`;
let owner: string;

async function signUp(username: string): Promise<string> {
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

/**
 * A Work plus a `transcoding_jobs` row in the state the sweep will find.
 *
 * `sourced` is the whole point of the fixture: `works.source_key` defaults to `""`, which
 * is falsy, so a Work created through the API and never uploaded to is exactly the
 * "job that can never succeed" case — no special setup needed to produce it.
 */
async function makeJob(opts: {
	title: string;
	mediaType: string;
	sourced: boolean;
	status?: string;
}): Promise<{ workId: number; jobId: number }> {
	const res = await req("/api/content/works", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
		// `game` so creating it queues nothing of its own — the media type under test is
		// the one on the transcoding_jobs row, which is what the sweep actually reads.
		body: JSON.stringify({ type: "game", title: opts.title }),
	});
	expect(res.status).toBe(201);
	const workId = (await res.json()).work.id as number;

	if (opts.sourced) {
		await db
			.update(works)
			.set({ sourceKey: `creators/1/originals/${opts.title}.bin` })
			.where(eq(works.id, workId));
	}

	const [row] = await db
		.insert(transcodingJobs)
		.values({
			workId,
			mediaType: opts.mediaType,
			status: opts.status ?? "pending",
			progress: 0,
		})
		.returning({ id: transcodingJobs.id });
	return { workId, jobId: row.id };
}

function statusOf(jobId: number) {
	return db
		.select({ status: transcodingJobs.status, error: transcodingJobs.errorMessage })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.then((r) => r[0]);
}

// Every queue name the sweep sent to, per job id, captured through the injected sender.
let sent: { queue: string; jobId: number }[] = [];
const recordingSend: SendJob = async (queueName, data) => {
	sent.push({ queue: queueName, jobId: data.jobId });
};
const sentFor = (jobId: number) => sent.filter((s) => s.jobId === jobId).map((s) => s.queue);

let video: { workId: number; jobId: number };
let unsourced: { workId: number; jobId: number };
let audio: { workId: number; jobId: number };
let ebook: { workId: number; jobId: number };
let unknown: { workId: number; jobId: number };
let done: { workId: number; jobId: number };

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username = ${ownerName}`);
	owner = await signUp(ownerName);

	video = await makeJob({ title: "orphan-video", mediaType: "video", sourced: true });
	unsourced = await makeJob({ title: "orphan-unsourced", mediaType: "video", sourced: false });
	audio = await makeJob({ title: "orphan-audio", mediaType: "audio", sourced: true });
	ebook = await makeJob({ title: "orphan-ebook", mediaType: "ebook", sourced: true });
	unknown = await makeJob({ title: "orphan-unknown", mediaType: "hologram", sourced: true });
	// A finished job, to prove the sweep selects on status rather than sweeping the table.
	done = await makeJob({
		title: "orphan-done",
		mediaType: "video",
		sourced: true,
		status: "completed",
	});

	sent = [];
	await resumeOrphanedTranscodes(recordingSend);
}, DB_SETUP_TIMEOUT);

// Works go first and by creator_id: `works.creator_id` is ON DELETE SET NULL, so deleting
// the user alone orphans the Works rather than removing them — and the transcoding_jobs
// that cascade off works would survive with them, which is precisely the litter this sweep
// exists to stop replaying on every `make dev`.
afterAll(async () => {
	const owners = sql`SELECT id FROM users WHERE username = ${ownerName}`;
	await db.execute(sql`DELETE FROM works WHERE creator_id IN (${owners})`);
	await db.execute(sql`DELETE FROM users WHERE username = ${ownerName}`);
});

describe("resumeOrphanedTranscodes", () => {
	it("records a job whose Work has no source file as failed, and does NOT re-send it", async () => {
		// The guard that stopped `make dev` replaying 463 guaranteed-failing jobs. All three
		// handlers throw on a missing source key before reaching ffmpeg, so failing the row
		// here reaches the same outcome AND takes it out of the pending set for good —
		// which re-sending never does, however many times it runs.
		const row = await statusOf(unsourced.jobId);
		expect(row.status).toBe("failed");
		expect(row.error).toBe("No source file on content item");
		expect(sentFor(unsourced.jobId)).toEqual([]);
	});

	it("resumes a job whose Work still has its source file", async () => {
		expect(sentFor(video.jobId)).toEqual([QUEUES.TRANSCODE_VIDEO]);
		expect((await statusOf(video.jobId)).status).toBe("pending");
	});

	it("sends each media type to ITS OWN handler, not to a guessed one", async () => {
		// 🚨 The case the old `video ? TRANSCODE : PROCESS_AUDIO` ternary got wrong. It was
		// correct for exactly two media types, so an orphaned EBOOK resumed onto the audio
		// handler — which fails on a PDF for reasons that name ffmpeg, i.e. a wrong answer
		// wearing a plausible error. A test that only covered video and audio would agree
		// with the broken version completely.
		expect(sentFor(audio.jobId)).toEqual([QUEUES.PROCESS_AUDIO]);
		expect(sentFor(ebook.jobId)).toEqual([QUEUES.RASTERIZE_EBOOK]);
	});

	it("skips an unrecognized mediaType rather than sending it somewhere", async () => {
		// Not failed, either: having nowhere to send a row is not the same as the row being
		// unfinishable, so a release that later understands the type can still run it.
		expect(sentFor(unknown.jobId)).toEqual([]);
		expect((await statusOf(unknown.jobId)).status).toBe("pending");
	});

	it("leaves a completed job alone", async () => {
		expect(sentFor(done.jobId)).toEqual([]);
		expect((await statusOf(done.jobId)).status).toBe("completed");
	});
});
