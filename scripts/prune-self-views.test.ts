// SPDX-License-Identifier: Apache-2.0
/**
 * The self-view cleanup's selection, against real rows.
 *
 * The predicate is the row alone (`user_id = creator_id`), so the test that matters is
 * that it takes the creator's own timed range and leaves every neighbouring shape: a
 * real viewer's range on the same Work, the creator's own zero-duration visit ping, and
 * the creator viewing somebody else's Work. The delete path is exercised too, because
 * this is the script's one write.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";
import { inArray } from "drizzle-orm";
import { createAccount } from "../apps/api/src/__tests__/account-fixture.js";
import { purgeAccountsCreatedHere } from "../apps/api/src/__tests__/cleanup.js";
import { DB_SETUP_TIMEOUT } from "../apps/api/src/__tests__/setup-timeouts.js";
import { insertWork } from "../apps/api/src/__tests__/work-fixtures.js";
import { deleteSelfViewRanges, findSelfViewRanges } from "./prune-self-views.js";

const rowIds: number[] = [];

afterAll(async () => {
	if (rowIds.length > 0) {
		await db.delete(attentionEvents).where(inArray(attentionEvents.id, rowIds));
	}
});

// Marks the account and Work high-water points at module load, so the file's own
// fixtures are swept even if a test bails early.
purgeAccountsCreatedHere();

let creator: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let ownWorkId: number;
let theirWorkId: number;
let selfTimed: number;
let otherTimed: number;
let selfZero: number;
let selfElsewhere: number;

async function seed(
	userId: number,
	creatorId: number,
	workId: number,
	durationSeconds: number,
): Promise<number> {
	const now = Date.now();
	const [row] = await db
		.insert(attentionEvents)
		.values({
			userId,
			creatorId,
			workId,
			eventType: "watch",
			durationSeconds,
			startedAt: new Date(now - 60_000),
			endedAt: new Date(now),
			clientId: `self-view-${crypto.randomUUID()}`,
			publicAccess: true,
		})
		.returning({ id: attentionEvents.id });
	rowIds.push(row.id);
	return row.id;
}

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	creator = await createAccount(`sv_creator_${stamp}`);
	other = await createAccount(`sv_other_${stamp}`);
	ownWorkId = (
		await insertWork({ creatorId: creator.userId, type: "video", title: "Their Own Film" })
	).id;
	theirWorkId = (
		await insertWork({ creatorId: other.userId, type: "video", title: "Somebody Else's Film" })
	).id;

	selfTimed = await seed(creator.userId, creator.userId, ownWorkId, 30);
	otherTimed = await seed(other.userId, creator.userId, ownWorkId, 40);
	selfZero = await seed(creator.userId, creator.userId, ownWorkId, 0);
	selfElsewhere = await seed(creator.userId, other.userId, theirWorkId, 50);
}, DB_SETUP_TIMEOUT);

describe("which ranges are a creator's own watching", () => {
	it("selects the creator's timed range and no neighbouring shape", async () => {
		const selected = await findSelfViewRanges();
		const ids = new Set(selected.map((range) => range.id));

		expect(ids.has(selfTimed), "the creator's own timed range was not selected").toBe(true);
		expect(ids.has(otherTimed), "a real viewer's range was selected").toBe(false);
		expect(ids.has(selfZero), "the creator's visit ping was selected").toBe(false);
		expect(ids.has(selfElsewhere), "the creator watching another Work was selected").toBe(false);
	});

	it("deletes exactly the ranges it is given", async () => {
		expect(await deleteSelfViewRanges([selfTimed])).toBe(1);
		const left = await db
			.select({ id: attentionEvents.id })
			.from(attentionEvents)
			.where(inArray(attentionEvents.id, [selfTimed, otherTimed, selfZero, selfElsewhere]));
		expect(new Set(left.map((row) => row.id))).toEqual(
			new Set([otherTimed, selfZero, selfElsewhere]),
		);
	});
});
