// SPDX-License-Identifier: Apache-2.0
/**
 * The claim-time guards the two lighter handlers share with `transcode-video`.
 *
 * The failed-past-bound skip protects the same invariant in all three handlers — a row
 * the boot sweep finally failed (its crash-resume ceiling spent) must not be resurrected
 * by a stale pg-boss redelivery, which is exactly the re-run that keeps a
 * worker-crashing file in a crash loop after the ceiling has stopped its recovery — but
 * the code is per-file, not shared, so each copy is asserted in its own right rather
 * than trusted by resemblance. `transcode-video`'s copy is exercised in
 * `transcode-lock.test.ts`, under the lock whose claim check it rides.
 *
 * The counterweight is tested for both too: a failed row BELOW the bound still re-runs —
 * that is the queue's ordinary self-healing for a possibly-transient cause still inside
 * its job's retry budget, and proving the body RUNS (by the throw its missing source
 * produces) is what bars a wrongly-broadened skip.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { processAudio } from "../jobs/process-audio";
import { renderPaged } from "../jobs/render-paged";
import { MAX_TRANSCODE_RESUMES } from "../jobs/resume-orphans";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

let creatorId: number;

beforeAll(async () => {
	creatorId = (
		await createAccount(`hcg_${crypto.randomUUID().slice(0, 8)}`, {
			fields: { isCreator: true },
		})
	).userId;
}, DB_SETUP_TIMEOUT);

/**
 * A Work plus a `transcoding_jobs` row this suite then drives past the bound. `type:
 * "game"` creates it queues nothing of its own; no source file is attached, so the body
 * (when it runs) throws at the source check rather than reaching any ffmpeg/poppler.
 */
async function makeJob(mediaType: string, title: string, status = "failed"): Promise<number> {
	const workId = (await insertWork({ creatorId, type: "game", title })).id;
	const [job] = await db
		.insert(transcodingJobs)
		.values({ workId, mediaType, status })
		.returning({ id: transcodingJobs.id });
	return job.id;
}

async function jobRow(jobId: number) {
	const [row] = await db
		.select({
			status: transcodingJobs.status,
			resumeCount: transcodingJobs.resumeCount,
			flag: transcodingJobs.interruptedGracefully,
		})
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId));
	return row;
}

function pastTheBound(jobId: number) {
	return db
		.update(transcodingJobs)
		.set({ resumeCount: MAX_TRANSCODE_RESUMES })
		.where(eq(transcodingJobs.id, jobId));
}

describe("the lighter handlers' failed-past-bound skip", () => {
	it(
		"process-audio does not resurrect a finally failed row past the bound",
		async () => {
			const jobId = await makeJob("audio", "audio-past-bound-skip");
			await pastTheBound(jobId);

			await processAudio({ jobId });

			const row = await jobRow(jobId);
			expect(row.status).toBe("failed");
			expect(row.resumeCount).toBe(MAX_TRANSCODE_RESUMES);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"render-paged does not resurrect a finally failed row past the bound",
		async () => {
			const jobId = await makeJob("ebook", "paged-past-bound-skip");
			await pastTheBound(jobId);

			await renderPaged({ jobId });

			const row = await jobRow(jobId);
			expect(row.status).toBe("failed");
			expect(row.resumeCount).toBe(MAX_TRANSCODE_RESUMES);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"process-audio still re-runs a failed row below the bound",
		async () => {
			// The body runs and throws at its source check — proof the skip is not broadened
			// past the bound. The catch marks the row failed (again) with the real reason.
			const jobId = await makeJob("audio", "audio-below-bound-reruns");
			await expect(processAudio({ jobId })).rejects.toThrow("No source file on content item");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"render-paged still re-runs a failed row below the bound",
		async () => {
			const jobId = await makeJob("ebook", "paged-below-bound-reruns");
			await expect(renderPaged({ jobId })).rejects.toThrow("No source file on this Work");
		},
		DB_SETUP_TIMEOUT,
	);
});
