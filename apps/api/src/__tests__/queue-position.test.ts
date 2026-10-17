// SPDX-License-Identifier: Apache-2.0
/**
 * `queue-position.ts` — the lane's order as a record, not arithmetic.
 *
 * 🚨 **The position is consumed by a creator reading a screen**, so the failures to cover
 * are the ones that would read as a lie about how long they wait: a settled or canceled row
 * still holding a spot (the queue never empties from the front), an ebook row numbered into a
 * lane it never joined, and a row that moved (claimed, failed) dragging its old number around.
 * The renumber is wholesale because a leaked number is a creator waiting for a turn that never
 * comes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { transcodingJobs } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";
import { refreshQueuePositions } from "../jobs/queue-position.js";

let creatorId: number;
const workIds: number[] = [];
const rowIds: number[] = [];

beforeAll(async () => {
	({ userId: creatorId } = await createAccount(`queue_pos_${crypto.randomUUID().slice(0, 8)}`));
	// Three works on the lane plus one outside it. The works need no files: the lane's
	// order is over the job rows, and the rows exist the moment the fixture makes them.
	for (const type of ["video", "audio", "video"] as const) {
		const w = await insertWork({ creatorId, type, title: `Queue position ${type}` });
		workIds.push(w.id);
	}
	const outside = await insertWork({ creatorId, type: "ebook", title: "Not on the lane" });
	workIds.push(outside.id);

	const made = await db
		.insert(transcodingJobs)
		.values([
			// created_at ties broken by id: same source, so ordering is total either way.
			{ workId: workIds[0], mediaType: "video", status: "pending" },
			{ workId: workIds[1], mediaType: "audio", status: "pending" },
			{ workId: workIds[2], mediaType: "video", status: "pending" },
			{ workId: workIds[3], mediaType: "ebook", status: "pending" },
		])
		.returning({ id: transcodingJobs.id });
	for (const r of made) rowIds.push(r.id);
});

afterAll(async () => {
	// The rows cascade with their works; delete the works, then the account sweep above.
	if (workIds.length > 0) await db.delete(transcodingJobs).where(inArray(transcodingJobs.workId, workIds));
});

const positionOf = async (rowId: number): Promise<number | null> => {
	const [row] = await db
		.select({ queuePosition: transcodingJobs.queuePosition })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, rowId));
	return row?.queuePosition ?? null;
};

describe("refreshQueuePositions", () => {
	// Registered here rather than called in `afterAll`: the purge is hook-registration
	// (cleanup.ts's own beforeAll/afterAll pair), not a function to invoke on teardown.
	purgeAccountsCreatedHere();
	it("numbers the lane's pending rows by created order, and never the rows outside it", async () => {
		await refreshQueuePositions();
		expect(await positionOf(rowIds[0])).toBe(1);
		expect(await positionOf(rowIds[1])).toBe(2);
		expect(await positionOf(rowIds[2])).toBe(3);
		// The ebook row has no spot: its ingest is not the lane's work to wait behind.
		expect(await positionOf(rowIds[3])).toBeNull();
	});

	it("clears a claimed row's spot and pulls the rest forward", async () => {
		await db
			.update(transcodingJobs)
			.set({ status: "processing", progress: 10 })
			.where(eq(transcodingJobs.id, rowIds[0]));
		await refreshQueuePositions();
		expect(await positionOf(rowIds[0])).toBeNull();
		expect(await positionOf(rowIds[1])).toBe(1);
		expect(await positionOf(rowIds[2])).toBe(2);
	});

	it("clears a canceled row the same way — a cancel does not leave a hole in the queue", async () => {
		await db
			.update(transcodingJobs)
			.set({ status: "canceled" })
			.where(eq(transcodingJobs.id, rowIds[1]));
		await refreshQueuePositions();
		expect(await positionOf(rowIds[1])).toBeNull();
		expect(await positionOf(rowIds[2])).toBe(1);
	});

	it("holds the queue's counts across a settled row", async () => {
		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100 })
			.where(eq(transcodingJobs.id, rowIds[0]));
		await refreshQueuePositions();
		// The completed row keeps no spot (the Dashboard reads "recently finished" from its
		// updatedAt, not from a queue number).
		expect(await positionOf(rowIds[0])).toBeNull();
		expect(await positionOf(rowIds[2])).toBe(1);
	});

	it("prices the row ahead from recorded history, and totals the front wait with the row's own cost", async () => {
		// A completed donor row whose `timings` carry one real measured total — the shape
		// `transcode-video`/`process-audio` write — so history, not the fallback constants,
		// prices the pending rows.
		const [donor] = await db
			.insert(transcodingJobs)
			.values({
				workId: workIds[3],
				mediaType: "video",
				status: "completed",
				progress: 100,
				timings: { totalMs: 600_000 },
			})
			.returning({ id: transcodingJobs.id });
		try {
			await db
				.update(transcodingJobs)
				.set({ status: "pending" })
				.where(inArray(transcodingJobs.id, rowIds.slice(0, 3)));
			await refreshQueuePositions();
			// The lane's front is seconds away when nothing runs: the first pending row's
			// front figure is 0 and its total is exactly the history's cost.
			expect(await positionOf(rowIds[0])).toBe(1);
			const [rowA] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, rowIds[0]));
			expect(rowA.queueEtaSeconds).toBe(0);
			expect(rowA.etaSeconds).toBe(600);
			// The second row waits behind the first's cost (history-priced, 600) and adds
			// its own — its type's fallback until audio jobs record their own history,
			// which the assertion states rather than hard-codes: the total is the front
			// wait plus the row's cost, whatever the cost model said.
			const [rowB] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, rowIds[1]));
			expect(rowB.queueEtaSeconds).toBe(600);
			expect(rowB.etaSeconds!).toBeGreaterThan(rowB.queueEtaSeconds!);
		} finally {
			await db.delete(transcodingJobs).where(eq(transcodingJobs.id, donor.id));
		}
	});
});