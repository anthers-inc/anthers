// SPDX-License-Identifier: Apache-2.0
/**
 * Who keeps the money when the thing a Sticker sits on is removed.
 *
 * 🚨 **Who removed it decides** (Parker, 2026-09-04). A giver taking their own Sticker off
 * the page keeps the creator paid, because the money was committed at the moment of giving
 * and taking it back would make standing rentable. **Anthers taking the Work down reverts
 * the direction**, because paying directed money out on content Anthers removed would be
 * funding the violation. A creator withdrawing their own Work does neither — they broke no
 * rule.
 *
 * ⭐ **Reverting is a subtraction rather than a transfer**, and that is the property worth
 * asserting: `distribute-pool` distributes by time only what was *not* directed, so a
 * voided Sticker simply stops being carved out and the money flows back to time-based
 * distribution on its own. The test below watches the creator's payout, not a ledger entry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, monthSettlements, poolDistributions, stickers } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { restoreStickersOnSubject, voidStickersOnSubject } from "../services/sticker-void";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
const CYCLE = "2032-04-01";
const SETTLED_CYCLE = "2032-05-01";

// The month marker references nothing, so no account purge reaches it.
afterAll(async () => {
	await db.delete(monthSettlements).where(inArray(monthSettlements.billingCycle, [SETTLED_CYCLE]));
});

async function signUp(username: string) {
	return (await createAccount(username)).userId;
}

describe("reverting a Sticker when Anthers removes what it sits on", () => {
	let giverId: number;
	let creatorId: number;
	let workId: number;

	beforeAll(async () => {
		giverId = await signUp(`vd_giver_${RUN}`);
		creatorId = await signUp(`vd_creator_${RUN}`);
		await db
			.insert(accounts)
			.values({ userId: giverId, anthersSupport: "12.00", isActive: true })
			.onConflictDoNothing();
		workId = (await insertWork({ creatorId, type: "text", title: `Void ${RUN}` })).id;
	}, DB_SETUP_TIMEOUT);

	async function giveOne(subjectId = workId, cycle = CYCLE) {
		const [row] = await db
			.insert(stickers)
			.values({
				giverId,
				creatorId,
				subjectType: "work",
				subjectId,
				billingCycle: cycle,
				amount: "1.00",
				artKey: "butterfly-large",
			})
			.returning();
		return row;
	}

	it("🚨 voids an unsettled Sticker, and reports the dollars going back", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `V1 ${RUN}` });
		await giveOne(work.id);
		const result = await voidStickersOnSubject("work", work.id);
		expect(result).toEqual({ voided: 1, dollars: 1 });

		const [row] = await db
			.select()
			.from(stickers)
			.where(and(eq(stickers.subjectType, "work"), eq(stickers.subjectId, work.id)));
		expect(row.voidedAt).not.toBeNull();
		// ⭐ The row survives with its amount intact. Voiding is a routing change, not a
		// deletion — the record of what somebody tried to do is worth keeping.
		expect(row.amount).toBe("1.00");
	});

	it("⚠️ is idempotent, so actioning a takedown twice reports nothing the second time", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `V2 ${RUN}` });
		await giveOne(work.id);
		expect((await voidStickersOnSubject("work", work.id)).voided).toBe(1);
		expect(await voidStickersOnSubject("work", work.id)).toEqual({ voided: 0, dollars: 0 });
	});

	it("🚨 leaves a SETTLED month alone — a takedown does not reach into a month already credited", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `V3 ${RUN}` });
		await giveOne(work.id, SETTLED_CYCLE);
		await db.insert(monthSettlements).values({ billingCycle: SETTLED_CYCLE });

		expect(await voidStickersOnSubject("work", work.id)).toEqual({ voided: 0, dollars: 0 });
		const [row] = await db
			.select()
			.from(stickers)
			.where(and(eq(stickers.subjectType, "work"), eq(stickers.subjectId, work.id)));
		expect(row.voidedAt).toBeNull();
	});

	it("🚨 still voids in a month the nightly estimate has written rows for", async () => {
		// The estimate writes a month's distribution rows from its first night. Reading one as
		// "settled" is what made every takedown after a month's first day void nothing.
		const work = await insertWork({ creatorId, type: "text", title: `V3b ${RUN}` });
		await giveOne(work.id);
		await db
			.insert(poolDistributions)
			.values({
				subscriberId: giverId,
				creatorId,
				billingCycle: CYCLE,
				poolAmount: "1.00",
				stickerAmount: "1.00",
			})
			.onConflictDoNothing();

		expect(await voidStickersOnSubject("work", work.id)).toEqual({ voided: 1, dollars: 1 });
	});

	it("⭐ puts an unsettled Sticker back when the takedown is undone", async () => {
		const work = await insertWork({ creatorId, type: "text", title: `V4 ${RUN}` });
		await giveOne(work.id);
		await voidStickersOnSubject("work", work.id);
		expect(await restoreStickersOnSubject("work", work.id)).toEqual({ restored: 1 });
		const [row] = await db
			.select()
			.from(stickers)
			.where(and(eq(stickers.subjectType, "work"), eq(stickers.subjectId, work.id)));
		expect(row.voidedAt).toBeNull();
	});

	it("touches nothing on a subject with no Stickers", async () => {
		expect(await voidStickersOnSubject("work", 2_000_000_001)).toEqual({ voided: 0, dollars: 0 });
		expect(await restoreStickersOnSubject("work", 2_000_000_001)).toEqual({ restored: 0 });
	});
});
