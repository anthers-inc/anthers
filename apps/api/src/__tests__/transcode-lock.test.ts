// SPDX-License-Identifier: Apache-2.0
/**
 * The one-encode lock and the supersession re-checks in `jobs/transcode-video.ts`.
 *
 * 🚨 **This suite exists because the bug it guards cost a real production double-encode**
 * (2026-10-11: one source re-encoded in full, twice, because pg-boss re-delivered a job
 * whose handler had outlived the expiry window while the first handler was still running).
 * pg-boss's `localConcurrency` cannot guard this — the expiry path frees the worker's
 * local slot while the orphaned handler lives — so the guard is a session-level advisory
 * lock the re-delivery waits on, and pre-upload row re-reads a zombie run owes the row.
 *
 * The lock is exercised for real against Postgres rather than mocked, because session
 * scope is the property being tested: hold `pg_advisory_lock` from one reserved session
 * in the test and assert the handler's helper waits, runs on release, and returns the
 * lock to the pool. The supersession check is exercised through
 * `isTranscodeSettled` and through `transcodeVideo`'s claim-time skip on a row already
 * `completed` — the reachable surface of a job another handler finished.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { client, db } from "@anthers/db/client";
import { transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { MAX_TRANSCODE_RESUMES } from "../jobs/resume-orphans";
import {
	isTranscodeSettled,
	TRANSCODE_LOCK_KEY_BASE,
	transcodeVideo,
	withTranscodeLock,
} from "../jobs/transcode-video";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure; the
// Works and their transcoding_jobs rows cascade with them (purgeContentByIds).
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

let owner: string;

beforeAll(async () => {
	owner = (await createAccount(`tl_${crypto.randomUUID().slice(0, 8)}`)).cookie;
}, DB_SETUP_TIMEOUT);

/**
 * A Work plus a `transcoding_jobs` row, the FK target the lock key is derived from.
 * `type: "game"` so creating it queues nothing of its own — the row under test is the
 * kind the suites insert directly, per `resume-orphans.test.ts`'s reasoning.
 */
async function makeJob(status: string, title: string): Promise<number> {
	const res = await req("/api/content/works", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
		body: JSON.stringify({ type: "game", title }),
	});
	expect(res.status).toBe(201);
	const workId = (await res.json()).work.id as number;

	const [row] = await db
		.insert(transcodingJobs)
		.values({ workId, mediaType: "video", status, progress: 0 })
		.returning({ id: transcodingJobs.id });
	return row.id;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withTranscodeLock", () => {
	it(
		"waits while another handler holds the job's lock, then runs",
		async () => {
			const jobId = await makeJob("processing", "lock-waits");

			// The first handler: it holds the session lock and returns nothing for a while.
			const key = TRANSCODE_LOCK_KEY_BASE + jobId;
			const holder = await client.reserve();
			const [held] = await holder`select pg_try_advisory_lock(${key}::bigint) as acquired`;
			expect(held.acquired).toBe(true);

			let ran = false;
			// A fast poll: the real worker waits 10s between attempts; the behavior is
			// the same and the test needs it to be a few milliseconds.
			const pending = withTranscodeLock(
				jobId,
				async () => {
					ran = true;
				},
				20,
			);

			await tick(150);
			expect(ran).toBe(false);

			// The first handler finishes and lets the lock go.
			await holder`select pg_advisory_unlock(${key}::bigint)`;
			holder.release();

			await pending;
			expect(ran).toBe(true);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"returns the lock when it returns, so the next handler can hold it",
		async () => {
			const jobId = await makeJob("processing", "lock-releases");
			const key = TRANSCODE_LOCK_KEY_BASE + jobId;

			await withTranscodeLock(jobId, async () => {}, 20);

			const next = await client.reserve();
			const [held] = await next`select pg_try_advisory_lock(${key}::bigint) as acquired`;
			expect(held.acquired).toBe(true);
			await next`select pg_advisory_unlock(${key}::bigint)`;
			next.release();
		},
		DB_SETUP_TIMEOUT,
	);
});

describe("the re-delivery's claim re-check", () => {
	it(
		"sees a completed row as completed and a live row as not",
		async () => {
			const done = await makeJob("completed", "superseded-completed");
			const live = await makeJob("processing", "superseded-live");

			expect(await isTranscodeSettled(done)).toBe(true);
			expect(await isTranscodeSettled(live)).toBe(false);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"runs through the real entry point as a no-op on an already-completed row",
		async () => {
			const jobId = await makeJob("completed", "entry-claim-skip");

			// The row is `completed` and its Work carries no source file — if the claim
			// check failed to skip, the body would proceed, throw on the missing source,
			// and the catch would mark the row failed and re-throw. A clean resolve is
			// the assertion: nothing downstream may run.
			await transcodeVideo({ jobId });

			const [row] = await db
				.select({ status: transcodingJobs.status })
				.from(transcodingJobs)
				.where(eq(transcodingJobs.id, jobId));
			expect(row.status).toBe("completed");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"does not resurrect a row the boot sweep finally failed at its resume bound",
		async () => {
			// 🚨 The claim-time guard this suite's header does not yet describe: a row the
			// sweep failed as exhausted — its crash resumes spent, canned message left —
			// must not be resurrected by a stale pg-boss redelivery, which is exactly the
			// re-run that keeps a worker-crashing file in a crash loop after the ceiling
			// has already stopped its recovery. A clean resolve is the assertion: nothing
			// may touch the failed row's state.
			const jobId = await makeJob("failed", "entry-exhausted-skip");
			await db
				.update(transcodingJobs)
				.set({ resumeCount: MAX_TRANSCODE_RESUMES })
				.where(eq(transcodingJobs.id, jobId));

			await transcodeVideo({ jobId });

			const [row] = await db
				.select({ status: transcodingJobs.status, resumeCount: transcodingJobs.resumeCount })
				.from(transcodingJobs)
				.where(eq(transcodingJobs.id, jobId));
			expect(row.status).toBe("failed");
			expect(row.resumeCount).toBe(MAX_TRANSCODE_RESUMES);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"still re-runs a failed row BELOW its resume bound — the queue's own retry self-healing",
		async () => {
			// The counterweight guard: a handler refusal from a possibly-transient cause
			// stays inside its job's retry budget, and re-running is how a transient
			// failure heals. Proven by the body RUNNING — the row is `failed` and its Work
			// carries no source, so reaching the body throws from the source check; a
			// wrongly-broadened skip would resolve cleanly instead.
			const jobId = await makeJob("failed", "entry-below-bound-reruns");

			await expect(transcodeVideo({ jobId })).rejects.toThrow("No source file on content item");
		},
		DB_SETUP_TIMEOUT,
	);
});
