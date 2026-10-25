// SPDX-License-Identifier: Apache-2.0
/**
 * Canceling an in-flight processing job, and the finality the handlers owe it.
 *
 * The route marks a pending or processing row `canceled`; everything else is the
 * handlers' obligation to *stay* canceled, which is what this suite holds together:
 * the claim-time guards must not resurrect a canceled row past a stale pg-boss
 * redelivery (the same invariant `handler-claim-guards.test.ts` holds for the
 * finally-failed row), the video job's supersession fact reads a canceled row as
 * settled, and the release gate treats a canceled latest job as the creator's to fix —
 * the same shape a failure has, since nothing will ever finish it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs, users, works } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { ingestEbook } from "../jobs/ingest-ebook";
import { processAudio } from "../jobs/process-audio";
import { renderPaged } from "../jobs/render-paged";
import { isTranscodeSettled, transcodeVideo } from "../jobs/transcode-video";
import { releaseRefusal } from "../services/work-release";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const creatorName = `cancel_${id}`;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

let cookie = "";
let creatorId = 0;
const createdWorkIds: number[] = [];

/** A Work plus a `transcoding_jobs` row, in whatever state the case asks for. */
async function makeJob(
	mediaType: string,
	title: string,
	status = "pending",
	workType: "video" | "game" = "game",
): Promise<{ workId: number; jobId: number }> {
	const workId = (await insertWork({ creatorId, type: workType, title, visibility: "private" })).id;
	createdWorkIds.push(workId);
	const [job] = await db
		.insert(transcodingJobs)
		.values({ workId, mediaType, status })
		.returning({ id: transcodingJobs.id });
	return { workId, jobId: job.id };
}

async function jobRow(jobId: number) {
	const [row] = await db
		.select({ status: transcodingJobs.status, resumeCount: transcodingJobs.resumeCount })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId));
	return row;
}

describe("canceling processing", () => {
	beforeAll(async () => {
		const account = await createAccount(creatorName, { fields: { creatorMode: true } });
		creatorId = account.userId;
		cookie = account.cookie;
		await enablePayoutsFor(creatorId);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (createdWorkIds.length > 0) {
			await db.delete(transcodingJobs).where(inArray(transcodingJobs.workId, createdWorkIds));
			await db.delete(works).where(inArray(works.id, createdWorkIds));
		}
		await db.delete(users).where(eq(users.id, creatorId));
	});

	it("marks a pending job canceled, and the row stays canceled", async () => {
		const { workId, jobId } = await makeJob("video", "cancel-pending");
		const res = await req(`/api/content/works/${workId}/transcoding/${jobId}`, {
			method: "DELETE",
			headers: { Cookie: cookie, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const row = await jobRow(jobId);
		expect(row.status).toBe("canceled");

		// Canceling an already-canceled row answers success, not an error.
		const again = await req(`/api/content/works/${workId}/transcoding/${jobId}`, {
			method: "DELETE",
			headers: { Cookie: cookie, Origin: ORIGIN },
		});
		expect(again.status).toBe(200);
	});

	it("refuses to cancel a completed job, and a failed one is directed at replace or remove", async () => {
		const done = await makeJob("video", "cancel-done", "completed");
		const doneRes = await req(`/api/content/works/${done.workId}/transcoding/${done.jobId}`, {
			method: "DELETE",
			headers: { Cookie: cookie, Origin: ORIGIN },
		});
		expect(doneRes.status).toBe(409);
		expect((await jobRow(done.jobId)).status).toBe("completed");

		const failed = await makeJob("video", "cancel-failed", "failed");
		const failedRes = await req(`/api/content/works/${failed.workId}/transcoding/${failed.jobId}`, {
			method: "DELETE",
			headers: { Cookie: cookie, Origin: ORIGIN },
		});
		expect(failedRes.status).toBe(409);
	});

	it("a stranger gets the same 404 an owner would for a job that is not there", async () => {
		const stranger = await createAccount(`cancel_other_${id}`);
		const { workId, jobId } = await makeJob("audio", "cancel-stranger");
		const res = await req(`/api/content/works/${workId}/transcoding/${jobId}`, {
			method: "DELETE",
			headers: { Cookie: stranger.cookie, Origin: ORIGIN },
		});
		expect(res.status).toBe(404);
		// And a job id belonging to a different Work is not addressable either.
		const other = await makeJob("audio", "cancel-cross");
		const cross = await req(`/api/content/works/${other.workId}/transcoding/${jobId}`, {
			method: "DELETE",
			headers: { Cookie: stranger.cookie, Origin: ORIGIN },
		});
		expect(cross.status).toBe(404);
		await db.delete(users).where(eq(users.id, stranger.userId));
	});

	it(
		"the redelivery guards leave a canceled row canceled, every handler",
		async () => {
			// A canceled row with no source is the sharpest shape for this: resurrecting it
			// would throw at the source check and mark it failed — silently overwriting the
			// creator's cancel with a failure the creator did not cause. So the assert is
			// status === "canceled" AND no resume spent, not merely "did not run".
			const { jobId: videoId } = await makeJob("video", "redelivery-video", "canceled");
			await transcodeVideo({ jobId: videoId });
			expect((await jobRow(videoId)).status).toBe("canceled");

			const { jobId: audioId } = await makeJob("audio", "redelivery-audio", "canceled");
			await processAudio({ jobId: audioId });
			const audioRow = await jobRow(audioId);
			expect(audioRow.status).toBe("canceled");
			expect(audioRow.resumeCount).toBe(0);

			const { jobId: pagedId } = await makeJob("ebook", "redelivery-paged", "canceled");
			await renderPaged({ jobId: pagedId });
			expect((await jobRow(pagedId)).status).toBe("canceled");

			const { jobId: ingestId } = await makeJob("ebook", "redelivery-ingest", "canceled");
			await ingestEbook({ jobId: ingestId });
			expect((await jobRow(ingestId)).status).toBe("canceled");

			// The fact itself, not only its consequences: a canceled row is settled, a
			// pending one is not.
			expect(await isTranscodeSettled(videoId)).toBe(true);
			const pending = await makeJob("video", "settled-pending", "pending");
			expect(await isTranscodeSettled(pending.jobId)).toBe(false);
		},
		DB_SETUP_TIMEOUT,
	);

	it("a canceled latest job refuses release as the creator's to fix, not something to wait for", async () => {
		const { workId } = await makeJob("video", "gate-canceled", "canceled", "video");
		await db
			.update(works)
			.set({ sourceKey: `creators/${creatorId}/media/gate.mp4` })
			.where(eq(works.id, workId));
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		const refusal = await releaseRefusal(row, { id: creatorId, creatorMode: true });
		expect(refusal?.body).toMatchObject({ code: "media_not_ready" });
		expect(refusal?.resolves).toBe("creator");
	});
});
