// SPDX-License-Identifier: Apache-2.0
/**
 * The payout receipt — the one money movement that told nobody on any channel until
 * this existed (Parker, 2026-10-08: money stays receipts, not feed entries).
 *
 * The transfer job's own economics and crash-window cases live in
 * `transfer-held-credits.test.ts`; what this file adds is the receipt that ride along:
 *
 *   • **A real transfer earns exactly one payout receipt, however many times the job
 *     re-runs.** The dedupe key is the transfer's own Stripe id, and a retry replays
 *     the same key — Stripe returns the original transfer, the row conflict no-ops,
 *     and the mail goes once.
 *
 *   • **A zero-sum close earns nothing.** The `tr_local_zerosum_` close is a movement
 *     of nothing; mailing it would be an email announcing that nothing happened.
 *     Guarded twice — the job by prefix, the receipt by amount — and the refusal is a
 *     quiet return, not an error, because the close itself succeeded.
 *
 *   • **The creator's receipt preference is honored**, read where it is defined on
 *     their Stripe account row (`creatorWantsReceiptEmails`), the same latch the sale
 *     receipt reads.
 *
 * `sendEmail` refuses under the test runner by design, so a send records `sent: false`
 * and no message goes anywhere — the honest surface is the `receipt_sends` row. The
 * copy is pinned where the copy lives, in the senders' module.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	creatorCredits,
	creatorTransferCredits,
	creatorTransfers,
	receiptSends,
	stripeAccounts,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { HOLD_DAYS, transferHeldCredits } from "../jobs/transfer-held-credits";
import { getStripe, setStripeClient } from "../lib/stripe";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const SETTLED_AT = new Date("2031-05-15T02:00:00Z");
const AT_15_DAYS = new Date(SETTLED_AT.getTime() + (HOLD_DAYS + 1) * 24 * 60 * 60 * 1000);

const tag = `prc_${Date.now().toString(36)}`;
const madeCreatorIds: number[] = [];
const madeTransferIds: number[] = [];
const madeReceiptDedupeKeys: string[] = [];
let n = 0;

afterAll(async () => {
	// Receipt rows outlive their user by design (set null); the transfers and credits
	// follow the dependency order transfer-held-credits.test.ts documents. The receipts
	// go by their own dedupe keys rather than a table wipe, because this suite shares its
	// database with every other suite in the run.
	if (madeReceiptDedupeKeys.length > 0) {
		await db.delete(receiptSends).where(inArray(receiptSends.dedupeKey, madeReceiptDedupeKeys));
	}
	if (madeTransferIds.length > 0) {
		await db
			.delete(creatorTransferCredits)
			.where(inArray(creatorTransferCredits.transferId, madeTransferIds));
	}
	for (const transferId of madeTransferIds) {
		await db.delete(creatorTransfers).where(eq(creatorTransfers.id, transferId));
	}
	for (const creatorId of madeCreatorIds) {
		await db.delete(creatorCredits).where(eq(creatorCredits.creatorId, creatorId));
	}
});

/** A payout-enabled creator fixture. */
async function makeCreator(opts: { receiptsOff?: boolean } = {}): Promise<number> {
	n += 1;
	const account = await createAccount(`${tag}_creator_${n}`, { fields: { isCreator: true } });
	madeCreatorIds.push(account.userId);
	await enablePayoutsFor(account.userId);
	if (opts.receiptsOff) {
		await db
			.update(stripeAccounts)
			.set({ creatorReceiptEmails: false })
			.where(eq(stripeAccounts.userId, account.userId));
	}
	return account.userId;
}

/** A settled credit, as `settleCycle` would have written it. */
async function credit(creatorId: number, amount: string) {
	const [row] = await db
		.insert(creatorCredits)
		.values({
			creatorId,
			subscriberId: creatorId, // the transfer step never reads the subscriber side
			billingCycle: "2031-05-01",
			kind: "time_pool",
			fundedBy: "supporter",
			amount,
			settledAt: SETTLED_AT,
		})
		.returning({ id: creatorCredits.id });
	return row.id;
}

/** The transfer rows written for one creator, claimed for teardown. */
async function transfersFor(creatorId: number) {
	const rows = await db
		.select()
		.from(creatorTransfers)
		.where(eq(creatorTransfers.creatorId, creatorId));
	for (const row of rows) madeTransferIds.push(row.id);
	return rows;
}

/** The receipt rows a run wrote, claimed for teardown. */
async function receiptRows(creatorId: number) {
	const rows = await db.select().from(receiptSends).where(eq(receiptSends.userId, creatorId));
	for (const row of rows) madeReceiptDedupeKeys.push(row.dedupeKey);
	return rows;
}

// ── The fake Stripe client — the transfer-held-credits suite's recording stand-in ──

function fakeStripe() {
	const byKey = new Map<string, Stripe.Transfer>();
	const client = {
		transfers: {
			create: (...args: unknown[]) => {
				const [params, options] = args as [Stripe.TransferCreateParams, Stripe.RequestOptions?];
				const key = options?.idempotencyKey ?? `nokey_${byKey.size}`;
				if (byKey.has(key)) return Promise.resolve(byKey.get(key));
				const transfer = {
					id: `tr_${crypto.randomUUID().slice(0, 16)}`,
					object: "transfer",
					amount: params.amount,
					currency: params.currency ?? "usd",
					created: Math.floor(AT_15_DAYS.getTime() / 1000),
				} as Stripe.Transfer;
				byKey.set(key, transfer);
				return Promise.resolve(transfer);
			},
		},
	} as unknown as Stripe;
	return { client, created: () => byKey.size };
}

let fake: ReturnType<typeof fakeStripe>;
let realClient: Stripe | null;

beforeAll(() => {
	realClient = getStripe();
});

beforeEach(() => {
	fake = fakeStripe();
	setStripeClient(fake.client);
});

afterAll(async () => {
	setStripeClient(realClient);
});

describe("the payout receipt", () => {
	it("a real transfer earns exactly one receipt", async () => {
		const creatorId = await makeCreator();
		await credit(creatorId, "10.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(creators).toBe(1);

		const [transfer] = await transfersFor(creatorId);
		expect(transfer.amount).toBe("10.00");
		const receipts = await receiptRows(creatorId);
		expect(receipts).toHaveLength(1);
		// The key latches on the transfer's own Stripe id, the identifier the Studio
		// Payments page shows, so email and page name the same movement.
		expect(receipts[0].dedupeKey).toBe(`payout:${transfer.stripeTransferId}:creator:${creatorId}`);
		expect(receipts[0].kind).toBe("payout");
		expect(receipts[0].role).toBe("creator");
		// `sendEmail` refuses under the test runner; the row records it honestly.
		expect(receipts[0].sent).toBe(false);
	});

	it("a re-run of the same coverage set sends no second receipt", async () => {
		const creatorId = await makeCreator();
		await credit(creatorId, "8.00");

		await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		const afterFirst = await receiptRows(creatorId);
		expect(afterFirst).toHaveLength(1);

		// The re-run finds nothing uncovered, so it neither transfers nor mails — the
		// whole latch, from the other side.
		await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(await receiptRows(creatorId)).toHaveLength(1);
		expect(fake.created()).toBe(1);
	});

	it("a zero-sum close earns no receipt", async () => {
		const creatorId = await makeCreator();
		// A correction of exactly its credit: the sum closes at 0.00 with no Stripe call.
		await credit(creatorId, "5.00");
		await credit(creatorId, "-5.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		// The close still counted — money questions were asked and answered — but the
		// mail box stays silent, because nothing moved and a receipt would say nothing.
		expect(creators).toBe(1);
		expect(fake.created()).toBe(0);
		const transfers = await transfersFor(creatorId);
		expect(transfers).toHaveLength(1);
		expect(transfers[0].stripeTransferId.startsWith("tr_local_zerosum_")).toBe(true);
		expect(await receiptRows(creatorId)).toHaveLength(0);
	});

	it("the creator's receipt-off preference leaves no row", async () => {
		const creatorId = await makeCreator({ receiptsOff: true });
		await credit(creatorId, "12.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(creators).toBe(1); // the money moved; only the mail is off
		const [transfer] = await transfersFor(creatorId);
		expect(transfer.amount).toBe("12.00");
		expect(await receiptRows(creatorId)).toHaveLength(0);
	});
});
