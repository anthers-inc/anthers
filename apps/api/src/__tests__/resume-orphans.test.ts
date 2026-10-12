// SPDX-License-Identifier: Apache-2.0
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
 *
 * **The benign-bounds work was sabotage-verified the same way (2026-10-12), and its
 * predictions were written before each run:** dropping the flag split from the sweep's two
 * filters AND its conditional charge fails 3 (the past-bound benign resume, and the two
 * count assertions on ordinary rows — the charge-path half, which the plain filter removal
 * under-covers); writing the canned message unconditionally fails 1 (the real-error row);
 * retiring nothing fails 1 (the vanished-row retire); the shutdown marker no-oped fails 1.
 * The handler guard's own skip is verified in `transcode-lock.test.ts` (predict 1, got 1).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { QUEUES } from "../jobs/queue";
import {
	type LingeringQueueAccess,
	MAX_TRANSCODE_RESUMES,
	markBenignInterrupted,
	resumeOrphanedTranscodes,
	retireLingeringQueueJobs,
	type SendJob,
} from "../jobs/resume-orphans";
import { createAccount } from "./account-fixture";
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
	return (await createAccount(username)).cookie;
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
		.select({
			status: transcodingJobs.status,
			error: transcodingJobs.errorMessage,
			resumeCount: transcodingJobs.resumeCount,
			flag: transcodingJobs.interruptedGracefully,
		})
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

// The retire pass, captured through an injected LingeringQueueAccess: `queuedFake` names
// the queued pg-boss jobs the fake `findQueued` reports, and `retiredDeletions` records
// which of them the sweep deleted.
const QUEUED_FAKE: { queue: string; id: string; data: Record<string, unknown> }[] = [];
let retiredDeletions: { queue: string; id: string }[] = [];
const recordingLingering: LingeringQueueAccess = {
	findQueued: (queueName) => Promise.resolve(QUEUED_FAKE.filter((q) => q.queue === queueName)),
	deleteJob: (queueName, id) => {
		retiredDeletions.push({ queue: queueName, id });
		return Promise.resolve();
	},
};

let video: { workId: number; jobId: number };
let unsourced: { workId: number; jobId: number };
let audio: { workId: number; jobId: number };
let ebook: { workId: number; jobId: number };
let unknown: { workId: number; jobId: number };
let done: { workId: number; jobId: number };
let exhausted: { workId: number; jobId: number };
let onceResumed: { workId: number; jobId: number };
let benign: { workId: number; jobId: number };
let benignPastBound: { workId: number; jobId: number };
let exhaustedWithError: { workId: number; jobId: number };

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE email = ${`${ownerName}@example.com`}`);
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
	// A job the sweep has already handed back enough times: the crash-loop case,
	// where the file keeps taking the worker down and this boot is one past the bound.
	exhausted = await makeJob({ title: "orphan-exhausted", mediaType: "video", sourced: true });
	await db
		.update(transcodingJobs)
		.set({ resumeCount: MAX_TRANSCODE_RESUMES })
		.where(eq(transcodingJobs.id, exhausted.jobId));
	// One below the bound, so the same pass proves an ordinary retry still resumes and
	// that resuming is what the count measures.
	onceResumed = await makeJob({ title: "orphan-once-resumed", mediaType: "video", sourced: true });
	await db
		.update(transcodingJobs)
		.set({ resumeCount: MAX_TRANSCODE_RESUMES - 1 })
		.where(eq(transcodingJobs.id, onceResumed.jobId));
	// The benign fixtures: rows carrying `interruptedGracefully`, the flag a graceful
	// (SIGTERM) stop leaves. A flagged row is resumed WITHOUT spending a ceiling slot —
	// its `resumeCount` passes through untouched — and one past the bound is resumed
	// all the same, because the bound counts crash-resumes and a deploy is not a crash.
	benign = await makeJob({ title: "orphan-benign", mediaType: "video", sourced: true });
	await db
		.update(transcodingJobs)
		.set({ interruptedGracefully: true })
		.where(eq(transcodingJobs.id, benign.jobId));
	benignPastBound = await makeJob({
		title: "orphan-benign-past-bound",
		mediaType: "video",
		sourced: true,
	});
	await db
		.update(transcodingJobs)
		.set({ resumeCount: MAX_TRANSCODE_RESUMES, interruptedGracefully: true })
		.where(eq(transcodingJobs.id, benignPastBound.jobId));
	// The real-error fixture: a row past the bound that also carries the error its one
	// reached-handler attempt wrote. The canned "kept interrupting" message must not
	// overwrite it — the real reason is the one thing the creator can act on.
	exhaustedWithError = await makeJob({
		title: "orphan-exhausted-with-error",
		mediaType: "video",
		sourced: true,
	});
	await db
		.update(transcodingJobs)
		.set({
			resumeCount: MAX_TRANSCODE_RESUMES,
			errorMessage: "ffmpeg HLS failed for 1080p: sample refusal from the reached attempt",
		})
		.where(eq(transcodingJobs.id, exhaustedWithError.jobId));

	// The queued pg-boss jobs the retire pass examines: one for a real fixture row
	// (kept), one for a row that exists NOWHERE in this table (deleted), and one whose
	// payload never resolved (deleted).
	QUEUED_FAKE.length = 0;
	QUEUED_FAKE.push(
		{ queue: QUEUES.TRANSCODE_VIDEO, id: "q-kept", data: { jobId: video.jobId } },
		{ queue: QUEUES.TRANSCODE_VIDEO, id: "q-vanished", data: { jobId: 999_999 } },
		{ queue: QUEUES.PROCESS_AUDIO, id: "q-malformed", data: {} },
	);

	sent = [];
	retiredDeletions = [];
	await resumeOrphanedTranscodes(recordingSend, recordingLingering);
}, DB_SETUP_TIMEOUT);

// Works go first and by creator_id: `works.creator_id` is ON DELETE SET NULL, so deleting
// the user alone orphans the Works rather than removing them — and the transcoding_jobs
// that cascade off works would survive with them, which is precisely the litter this sweep
// exists to stop replaying on every `make dev`.
afterAll(async () => {
	const owners = sql`SELECT id FROM users WHERE email = ${`${ownerName}@example.com`}`;
	await db.execute(sql`DELETE FROM works WHERE creator_id IN (${owners})`);
	await db.execute(sql`DELETE FROM users WHERE email = ${`${ownerName}@example.com`}`);
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
		expect(sentFor(ebook.jobId)).toEqual([QUEUES.RENDER_PAGED]);
	});

	it("skips an unrecognized mediaType rather than sending it somewhere", async () => {
		// Not failed, either: having nowhere to send a row is not the same as the row being
		// unfinishable, so a release that later understands the type can still run it.
		expect(sentFor(unknown.jobId)).toEqual([]);
		expect((await statusOf(unknown.jobId)).status).toBe("pending");
		// The spent flag is still spent by a pass that did nothing but warn: leaving it
		// would let every later crash-free boot read the same stale excuse.
		expect((await statusOf(unknown.jobId)).flag).toBe(false);
	});

	it("leaves a completed job alone", async () => {
		expect(sentFor(done.jobId)).toEqual([]);
		expect((await statusOf(done.jobId)).status).toBe("completed");
	});

	it("gives up on a job that has already been resumed past the bound", async () => {
		// The crash loop, ended: a file that took the worker down every time it ran does
		// not get sent again once it has hit the bound. The message is for the creator,
		// who is the one who can act on it — re-upload, or ask.
		const row = await statusOf(exhausted.jobId);
		expect(row.status).toBe("failed");
		expect(row.error).toContain("interrupting the media worker");
		expect(sentFor(exhausted.jobId)).toEqual([]);
	});

	it("fails a past-the-bound row whose own error was blank, with the canned message", async () => {
		// The same pass that gives up must still write SOMETHING the creator can act on
		// when the crash left the row with empty error — the handler never reached its
		// catch, so there is nothing of its own to keep.
		expect((await statusOf(exhausted.jobId)).error).toBe(
			"Processing this file kept interrupting the media worker, so it was stopped. Re-upload the file, or contact support if it happens again.",
		);
	});

	it("does not overwrite a past-the-bound row's REAL handler error with the canned text", async () => {
		// 🚨 The misleading-message case filed with the task: the sweep used to stamp
		// "kept interrupting the media worker" over every row it failed, including one
		// whose previous attempt had reached a catch and written the actual refusal —
		// the one diagnostic its creator can act on. The real error survives the fail.
		const row = await statusOf(exhaustedWithError.jobId);
		expect(row.status).toBe("failed");
		expect(row.error).toBe("ffmpeg HLS failed for 1080p: sample refusal from the reached attempt");
		expect(row.error).not.toContain("interrupting the media worker");
		expect(sentFor(exhaustedWithError.jobId)).toEqual([]);
	});

	it("resumes a benignly interrupted row WITHOUT spending a resume", async () => {
		// A deploy bounce is the normal case the ceiling must not charge: the previous
		// stop marked the row, so the resume passes through uncharged and the flag is
		// spent by the hand-back.
		const row = await statusOf(benign.jobId);
		expect(row.status).toBe("pending");
		expect(row.resumeCount).toBe(0);
		expect(row.flag).toBe(false);
		expect(sentFor(benign.jobId)).toEqual([QUEUES.TRANSCODE_VIDEO]);
	});

	it("resumes a flagged row even past the bound, still without spending a resume", async () => {
		// The bound counts crash-resumes; deploys are not crashes. A file that survived
		// three real crashes and was then deploy-bounced keeps working rather than
		// failing for the deploy.
		const row = await statusOf(benignPastBound.jobId);
		expect(row.status).toBe("pending");
		expect(row.resumeCount).toBe(MAX_TRANSCODE_RESUMES);
		expect(row.flag).toBe(false);
		expect(sentFor(benignPastBound.jobId)).toEqual([QUEUES.TRANSCODE_VIDEO]);
	});

	it("retires queued pg-boss jobs whose row has vanished, and never one whose row exists", async () => {
		const retiredIds = retiredDeletions
			.filter((d) => d.queue === QUEUES.TRANSCODE_VIDEO)
			.map((d) => d.id);
		// The vanished row's job is deleted; the live row's is not touched.
		expect(retiredIds).toEqual(["q-vanished"]);
		// A job whose payload never resolved cannot be handled at any time, so there is
		// nothing it could ever do but fail — retired on the same pass.
		const audioRetired = retiredDeletions
			.filter((d) => d.queue === QUEUES.PROCESS_AUDIO)
			.map((d) => d.id);
		expect(audioRetired).toEqual(["q-malformed"]);
	});

	it("retires nothing when every queued job still resolves", async () => {
		// The quiet case — the ordinary boot, where the trash cascade has stranded
		// nothing. `video.jobId`'s queued job above is the only kept one; a fake pass
		// reporting only it deletes nothing. The RETIRE pass alone is re-run here, not
		// the sweep: a second full sweep re-charges every row this suite's fixed state
		// was built for (the board's rows are global, the pass is global, and a second
		// pass reads the first pass's writes — `onceResumed` would reach its bound).
		const quiet: LingeringQueueAccess = {
			findQueued: (queueName) =>
				Promise.resolve(
					[{ id: "q-kept", data: { jobId: video.jobId } }].filter(
						() => queueName === QUEUES.TRANSCODE_VIDEO,
					),
				),
			deleteJob: () => {
				throw new Error("nothing should be deleted when every queued job resolves");
			},
		};
		expect(await retireLingeringQueueJobs(quiet)).toBe(0);
	});

	it("the shutdown marker flags the rows a graceful stop leaves behind, and nothing terminal", async () => {
		const pending = await makeJob({ title: "mark-pending", mediaType: "video", sourced: true });
		const processing = await makeJob({
			title: "mark-processing",
			mediaType: "video",
			sourced: true,
			status: "processing",
		});
		const completed = await makeJob({
			title: "mark-completed",
			mediaType: "video",
			sourced: true,
			status: "completed",
		});
		await markBenignInterrupted();
		expect((await statusOf(pending.jobId)).flag).toBe(true);
		// The row a handler is mid-way through is the row the bounce actually interrupts —
		// the principal case this marker exists to record.
		const processingRow = await statusOf(processing.jobId);
		expect(processingRow.flag).toBe(true);
		expect(processingRow.status).toBe("processing");
		// A terminal row is left alone — the flag is inert anywhere it lands, but a
		// completed job is nobody's interruption.
		expect((await statusOf(completed.jobId)).flag).toBe(false);
	});

	it("resumes a job below the bound, and the count is what the resume spends", async () => {
		// A deploy bounces the worker mid-transcode as a matter of course, so the first
		// and second resumes must still happen — a bound of 1 would fail ordinary work
		// every deploy, and the count rather than the status is the thing being tested.
		const row = await statusOf(onceResumed.jobId);
		expect(row.status).toBe("pending");
		expect(row.resumeCount).toBe(MAX_TRANSCODE_RESUMES);
		expect(sentFor(onceResumed.jobId)).toEqual([QUEUES.TRANSCODE_VIDEO]);
	});

	it("a fresh job counts its own resume, and the unsent ones do not count", async () => {
		expect((await statusOf(video.jobId)).resumeCount).toBe(1);
		// An unsendable row was never handed back, so it must not be charged a resume —
		// counting it would fail it forever for a reason it cannot act on.
		expect((await statusOf(unknown.jobId)).resumeCount).toBe(0);
	});
});
