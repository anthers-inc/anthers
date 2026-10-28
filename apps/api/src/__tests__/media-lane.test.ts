// SPDX-License-Identifier: Apache-2.0
/**
 * The single-file media lane's shape, as configuration and as dispatch.
 *
 * 🚨 **The lane is the worker's whole concurrency policy for CPU-heavy media processing,
 * and nothing in the app can tell it apart from "the settings drifted" — so the shape is
 * a guard, not a hope.** The 2026-10-17 burst ran one video beside two audios on a
 * two-vCPU worker: six pinned ffmpeg threads, every measured benchmark outside its band,
 * the video ETA clamped to a figure reality never met, and pg-boss connection timeouts
 * filling the log — the shape QUEUES.MEDIA carries in its comment. This refuses the two
 * re-formations that drift naturally: the worker registering a second media handler
 * (which returns two lanes and re-doubles the peak), and the dispatch losing a media
 * type (which re-creates the misroute `resume-orphans.ts`'s ternary once made).
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { db } from "@anthers/db";
import { works, workTranscodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { DISPATCH, runMediaJob } from "../jobs/media-lane.js";
import { JOB_OPTIONS, QUEUES } from "../jobs/queue.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const ROOT = "apps/api/src";

/** The api's worker source, for asserting the registration's shape. */
const WORKER_SOURCE = join(ROOT, "jobs/worker.ts");
// Registered at the suite's top level, as fixture-hygiene's guard requires —
// a registration (the shared beforeAll/afterAll pair), not a teardown call.
purgeAccountsCreatedHere();

describe("the media lanes' configuration", () => {
	it("registers the two media lanes at their measured concurrencies in worker.ts", async () => {
		const source = await Bun.file(WORKER_SOURCE).text();
		// **Video single-file** — an encode saturates both vCPUs, and a second concurrent
		// encode finished no sooner, only peaked (the 2026-10-17 burst's measurement).
		// **Audio two at a time** — the jobs are light; one audio job held the worker at
		// ~24% CPU (2026-10-18's measurement), and the single-file lane idled three
		// quarters of the box. Each registration may carry only its own name — this was
		// the test the single-file experiment inverted and then repassed.
		expect(source).toContain(`QUEUES.TRANSCODE_VIDEO,\n\t\t{ localConcurrency: 1 }`);
		expect(source).toContain(`QUEUES.PROCESS_AUDIO,\n\t\t{ localConcurrency: 2 }`);
		// The retired lane's name must not ride any registration.
		expect(source).not.toContain(`QUEUES.MEDIA`);
	});

	it("carries the same generous budget in JOB_OPTIONS for both lanes", () => {
		for (const queueName of [QUEUES.TRANSCODE_VIDEO, QUEUES.PROCESS_AUDIO]) {
			const options = JOB_OPTIONS[queueName];
			// An expiry sized past real job runtimes (the transcode-guard's floor) so the
			// queue does not re-introduce a short window that expires a job queued behind
			// a long one, and the heartbeat that makes the long window safe.
			expect(options.expireInMinutes).toBeGreaterThan(60);
			expect(options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
		}
	});

	it("has a dispatch entry for every media type the lanes process", () => {
		expect(Object.keys(DISPATCH).sort()).toEqual(["audio", "video"]);
	});
});

describe("runMediaJob's dispatch", () => {
	it("records a row of an unknown media type failed, legibly, without throwing", async () => {
		const { userId: creatorId } = await createAccount(
			`media_lane_${crypto.randomUUID().slice(0, 8)}`,
		);
		const work = await insertWork({
			creatorId,
			type: "audio",
			sourceKey: `creators/${creatorId}/audio/originals/media-lane-test-source`,
		});
		const [job] = await db
			.insert(workTranscodingJobs)
			.values({ workId: work.id, mediaType: "holographic", status: "pending" })
			.returning();
		// The row that maps to nothing must not throw: a thrown run spends the queue's
		// retry budget re-reading a row that can never process. It fails once, with the
		// reason on the row.
		await runMediaJob(job.id);
		const [row] = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.id, job.id));
		expect(row.status).toBe("failed");
		expect(row.errorMessage).toContain("holographic");
		// The work row itself is untouched by a failed dispatch.
		const [w] = await db.select().from(works).where(eq(works.id, work.id));
		expect(w.sourceKey ?? "").not.toBe("");
		// The fixture must not leak into another suite.
		await db.delete(workTranscodingJobs).where(eq(workTranscodingJobs.id, job.id));
		await db.delete(works).where(eq(works.id, work.id));
	});
});
