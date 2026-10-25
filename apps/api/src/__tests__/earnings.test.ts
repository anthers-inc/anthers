// SPDX-License-Identifier: Apache-2.0
/**
 * What a creator's earnings report, at the boundary a total can hide.
 *
 * 🚨 **A total that silently omits a column still renders as a plausible number.** Until
 * 2026-10-25 the read summed `pool_amount` and `badge_amount` and left `sticker_amount` out,
 * so a creator supported by Stickers saw a month short by exactly what was directed and had
 * nothing on the page to compare it against. That is the case this file exists for: Sticker
 * money alone must produce a non-zero total, and Sticker money beside the other two must add
 * into it.
 *
 * ⚠️ **A Sticker is part of the pool's own money rather than a fourth source** — the pool
 * distributes by time only what was not directed — but it is its own column, which is the
 * whole reason a total can be built wrongly from the row.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { poolDistributions } from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { inArray } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
const CYCLE = currentCycleKey();

let all: FixtureAccount;
let stickersOnly: FixtureAccount;
const rowIds: number[] = [];

async function earningsFor(account: FixtureAccount) {
	const res = await app.fetch(
		new Request(`http://localhost/api/subscriptions/earnings?cycle=${CYCLE}`, {
			headers: { Cookie: account.cookie },
		}),
	);
	expect(res.status).toBe(200);
	return (await res.json()) as {
		poolTotal: string;
		badgeTotal: string;
		stickerTotal: string;
		total: string;
	};
}

beforeAll(async () => {
	all = await createAccount(`ern_all_${RUN}`);
	stickersOnly = await createAccount(`ern_stick_${RUN}`);

	const rows = await db
		.insert(poolDistributions)
		.values([
			// Time, support and a Sticker on one row, then a second supporter who only gave a
			// Sticker — the two shapes the sum has to survive.
			{
				creatorId: all.userId,
				billingCycle: CYCLE,
				poolAmount: "1.00",
				badgeAmount: "0.50",
				stickerAmount: "0.25",
			},
			{
				creatorId: all.userId,
				billingCycle: CYCLE,
				poolAmount: "0.00",
				badgeAmount: "0.00",
				stickerAmount: "2.00",
			},
			// The creator whose month is Stickers alone.
			{
				creatorId: stickersOnly.userId,
				billingCycle: CYCLE,
				poolAmount: "0.00",
				badgeAmount: "0.00",
				stickerAmount: "1.75",
			},
		])
		.returning({ id: poolDistributions.id });
	for (const row of rows) rowIds.push(row.id);
}, DB_SETUP_TIMEOUT);

describe("creator earnings", () => {
	it("🚨 counts Sticker income into the total, not only pool and badge", async () => {
		const earnings = await earningsFor(all);
		expect(earnings.poolTotal).toBe("1.00");
		expect(earnings.badgeTotal).toBe("0.50");
		expect(earnings.stickerTotal).toBe("2.25");
		expect(earnings.total).toBe("3.75");
	});

	it("🚨 reports a month that is Stickers alone as a non-zero total", async () => {
		// The regression this file exists for: omitting the column made this read 0.00 while
		// $1.75 had been directed at the creator.
		const earnings = await earningsFor(stickersOnly);
		expect(earnings.stickerTotal).toBe("1.75");
		expect(earnings.total).toBe("1.75");
	});
});

// The distribution rows are this file's own; the accounts go with the shared purge.
afterAll(async () => {
	if (rowIds.length > 0) {
		await db.delete(poolDistributions).where(inArray(poolDistributions.id, rowIds));
	}
});
