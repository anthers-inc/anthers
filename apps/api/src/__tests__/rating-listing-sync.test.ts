// SPDX-License-Identifier: Apache-2.0
/**
 * Every door that changes a Work's rating asks for its network listing to be re-synced.
 *
 * 🚨 **The operator's correction is the one that matters.** A rating decides whether a listing
 * may exist at all, and an Adult Work is never published — so a correction into Adult that
 * asked for nothing left the Work's title and description public on the network until the
 * nightly reconcile got to it. Creator edits, quarantine and takedowns already asked; the
 * rating service was the one writer of a publishability-deciding field that did not.
 *
 * ⚠️ **`queue.send` is replaced for the duration**, so nothing is enqueued and no worker is
 * needed — the same arrangement as `record-enqueues.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { moderationActions, users } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { QUEUES, queue } from "../jobs/queue";
import {
	correctRating,
	declareRating,
	fileRatingAppeal,
	resolveRatingAppeal,
} from "../services/content-rating.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
let sent: { name: string; data: Record<string, unknown> }[] = [];
let sendSpy: ReturnType<typeof spyOn>;
let creatorId = 0;
let operatorId = 0;
const created: number[] = [];

/** A general-rated Work belonging to this suite's creator, tracked for teardown. */
async function work() {
	const row = await insertWork({ creatorId, type: "video", maturity: "general" });
	created.push(row.id);
	return row;
}

function listingSyncs(): unknown[] {
	return sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING).map((s) => s.data);
}

beforeAll(async () => {
	const [creator] = await db
		.insert(users)
		.values({ username: `rls_c_${run}`, email: `rls_c_${run}@example.com`, isCreator: true })
		.returning();
	const [operator] = await db
		.insert(users)
		.values({ username: `rls_o_${run}`, email: `rls_o_${run}@example.com` })
		.returning();
	creatorId = creator.id;
	operatorId = operator.id;

	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
});

// Works and their appeals go with the creator's account, and the moderation log does not — its
// subject is polymorphic and carries no key — so the log rows this suite wrote go by hand.
afterAll(async () => {
	sendSpy.mockRestore();
	if (created.length > 0) {
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "work"),
					inArray(moderationActions.subjectId, created),
				),
			);
	}
});

describe("a rating change asks for the listing to be re-synced", () => {
	it("🚨 when an operator corrects a Work into Adult", async () => {
		const w = await work();
		sent = [];
		await correctRating({ workId: w.id, maturity: "adult", actorId: operatorId });
		expect(listingSyncs()).toContainEqual({ workId: w.id });
	});

	it("when the creator declares a rating", async () => {
		const w = await work();
		sent = [];
		await declareRating(w, { maturity: "mature" });
		expect(listingSyncs()).toContainEqual({ workId: w.id });
	});

	it("when an appeal against a correction is granted", async () => {
		const w = await work();
		const corrected = await correctRating({ workId: w.id, maturity: "adult", actorId: operatorId });
		const appeal = await fileRatingAppeal({
			work: corrected!,
			creatorId,
			requestedMaturity: "mature",
			statement: "Nothing here is explicit.",
		});
		if (typeof appeal === "string") throw new Error(`appeal refused: ${appeal}`);

		sent = [];
		await resolveRatingAppeal({ appealId: appeal.id, actorId: operatorId, outcome: "granted" });
		expect(listingSyncs()).toContainEqual({ workId: w.id });
	});

	it("asks for nothing when an appeal is upheld, because nothing about the Work changed", async () => {
		const w = await work();
		const corrected = await correctRating({ workId: w.id, maturity: "adult", actorId: operatorId });
		const appeal = await fileRatingAppeal({
			work: corrected!,
			creatorId,
			requestedMaturity: "mature",
			statement: "Nothing here is explicit.",
		});
		if (typeof appeal === "string") throw new Error(`appeal refused: ${appeal}`);

		sent = [];
		await resolveRatingAppeal({ appealId: appeal.id, actorId: operatorId, outcome: "upheld" });
		expect(listingSyncs()).toEqual([]);
	});
});
