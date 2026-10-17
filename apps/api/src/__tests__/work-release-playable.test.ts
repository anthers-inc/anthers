// SPDX-License-Identifier: Apache-2.0
/**
 * The release gate's playable arm — `unreadyWorks`, where the processing wait lives.
 *
 * Publish-early (2026-10-18) opened the gate to a video whose ladder still fills in:
 * the one fact that makes that safe is `transcoding_jobs.playable_at`, written at the
 * first rung's upload. These pin the whole shape: playable-in-progress releases, an
 * un-playable in-progress row still waits as before, and a failed or canceled row is
 * unready through its own branch (`creatorStalled`) rather than the wait.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { inArray } from "drizzle-orm";
import { unreadyWorks } from "../services/work-release.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const workIds: number[] = [];
const rowIds: number[] = [];

let creatorId: number;
const created = (async () => {
	creatorId = (await createAccount(`playable_gate_${crypto.randomUUID().slice(0, 8)}`)).userId;

	for (const title of [
		"playable in progress",
		"unplayable in progress",
		"failed after playable",
		"canceled",
	]) {
		const w = await insertWork({
			creatorId,
			type: "video",
			title,
			visibility: "private",
		});
		workIds.push(w.id);
	}

	const [playableRow] = await db
		.insert(transcodingJobs)
		.values({
			workId: workIds[0],
			mediaType: "video",
			status: "processing",
			progress: 34,
			// The tree plays: written at the first rung's upload.
			playableAt: new Date(),
			etaSeconds: 2460,
		})
		.returning({ id: transcodingJobs.id });
	const [bareRow] = await db
		.insert(transcodingJobs)
		.values({ workId: workIds[1], mediaType: "video", status: "processing", progress: 12 })
		.returning({ id: transcodingJobs.id });
	const [failedRow] = await db
		.insert(transcodingJobs)
		.values({ workId: workIds[2], mediaType: "video", status: "failed", playableAt: new Date() })
		.returning({ id: transcodingJobs.id });
	const [canceledRow] = await db
		.insert(transcodingJobs)
		.values({ workId: workIds[3], mediaType: "video", status: "canceled" })
		.returning({ id: transcodingJobs.id });
	for (const r of [playableRow, bareRow, failedRow, canceledRow]) rowIds.push(r.id);
})();

// Wait for the fixture work above before any test runs.
beforeAll(async () => {
	await created;
});

afterAll(async () => {
	if (workIds.length > 0)
		await db.delete(transcodingJobs).where(inArray(transcodingJobs.workId, workIds));
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
});

describe("the release gate's playable arm", () => {
	it(
		"a video whose playable tree is up is no longer the gate's problem while the rungs fill in",
		async () => {
			const unready = await unreadyWorks(workIds);
			const byId = new Map(unready.map((u) => [u.workId, u.status]));
			expect(byId.has(workIds[0])).toBe(false);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"an in-progress row without a playable tree waits for the processing to finish, exactly as before",
		async () => {
			const unready = await unreadyWorks(workIds);
			const byId = new Map(unready.map((u) => [u.workId, u.status]));
			expect(byId.get(workIds[1])).toBe("processing");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"a failed or canceled row is unready whatever playable said — the creator's own branch resolves it",
		async () => {
			const unready = await unreadyWorks(workIds);
			const byId = new Map(unready.map((u) => [u.workId, u.status]));
			expect(byId.get(workIds[2])).toBe("failed");
			expect(byId.get(workIds[3])).toBe("canceled");
			// And exactly those two carry the creatorStalled shape the refusal builds on.
			expect(unready.some((u) => u.status === "failed")).toBe(true);
			expect(unready.some((u) => u.status === "canceled")).toBe(true);
		},
		DB_SETUP_TIMEOUT,
	);
});
