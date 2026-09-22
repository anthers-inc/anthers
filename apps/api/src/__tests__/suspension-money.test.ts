// SPDX-License-Identifier: Apache-2.0
/**
 * The money halves of account suspension.
 *
 * Two settled behaviors, one file:
 *
 * 1. **A suspended supporter's renewal is paused, never cancelled and never settled.**
 *    `recordPaidInvoice` books a `subscription_cycle` charge against the books with
 *    status `paused`, settlement never reads it, and reinstatement re-keys it against
 *    the month the suspension lifts so the withheld months credit from there.
 * 2. **A suspended creator's accrued balance is held behind a review that lapses.**
 *    Settlement credits nothing to a suspended creator — including corrections that
 *    would claw back what was already credited — and `PAYOUT_REVIEW_WINDOW_DAYS` from
 *    the suspension, the hold releases with no person acting.
 *
 * 🚨 The figures here are asserted against `timePoolFor` rather than typed, exactly
 * as `settle-cycle.test.ts` does, because the failure this exists to catch is money
 * moving where suspension said it must not.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accounts,
	creatorCredits,
	crfLedger,
	invoiceLines,
	invoices,
	monthSettlements,
	supportReductions,
	users,
} from "@anthers/db/schema";
import { PAYOUT_REVIEW_WINDOW_DAYS, timePoolFor } from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { and, eq, inArray, like } from "drizzle-orm";
import type Stripe from "stripe";
import { settleCycle } from "../jobs/settle-cycle";
import { setStripeClient } from "../lib/stripe";
import { recordPaidInvoice, resumePausedRenewals } from "../services/invoices";
import {
	releasePayoutHold,
	releaseStalePayoutHolds,
	suspensionPayoutReview,
} from "../services/payouts";
import { applyReductionsToInvoice } from "../services/support-reductions";
import { createAccount } from "./account-fixture";
import { insertAttentionRange } from "./attention-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

/** A month far enough out that it cannot collide with fixture or dev data. */
const MONTH = "2031-07-01";
const WATCHED_AT = new Date("2031-07-15T12:00:00Z");
/** The run on the 2nd after the month ends. */
const AFTER = new Date("2031-08-02T02:00:00Z");

const tag = `susp_${Date.now().toString(36)}`;
const madeUserIds: number[] = [];
let n = 0;

afterAll(async () => {
	// The ledger rows reference no user, so they are found by the marker they carry; the
	// month marker references nothing. Both go before the accounts do — and the paused
	// invoices ride the account purge, which deletes invoices by `user_id`.
	for (const userId of madeUserIds) {
		await db.delete(crfLedger).where(like(crfLedger.description, `[settle u${userId} %`));
	}
	await db.delete(monthSettlements).where(eq(monthSettlements.billingCycle, MONTH));
});

async function makeUser(kind: string): Promise<number> {
	n += 1;
	const account = await createAccount(`${tag}_${kind}_${n}`);
	madeUserIds.push(account.userId);
	return account.userId;
}

async function suspend(userId: number): Promise<void> {
	await db
		.update(users)
		.set({ suspendedAt: new Date("2031-07-10T00:00:00Z") })
		.where(eq(users.id, userId));
}

async function unsuspend(userId: number, at: Date) {
	// The service's own write — clearing the state — is done by hand here so the test
	// isolates the follow-up: re-keying the paused renewals is `resumePausedRenewals`'s
	// job, called from `unsuspendAccount`.
	await db
		.update(users)
		.set({ suspendedAt: null, suspendedUntil: null })
		.where(eq(users.id, userId));
	return resumePausedRenewals(userId, at);
}

/** A renewal invoice in the shape the webhook carries. */
function renewalInvoice(
	customerId: string,
	cycleStartUnix: number,
	status: "paid" | "draft" = "paid",
): Stripe.Invoice {
	return {
		id: `in_${crypto.randomUUID().slice(0, 12)}`,
		object: "invoice",
		status,
		billing_reason: "subscription_cycle",
		customer: customerId,
		created: cycleStartUnix,
		status_transitions: { paid_at: cycleStartUnix },
		total: 600,
		total_discount_amounts: [],
		total_taxes: [],
		parent: { subscription_details: { subscription: `sub_${customerId}` } },
		lines: {
			object: "list",
			data: [
				{
					id: "il_1",
					object: "line_item",
					amount: 600,
					discount_amounts: [],
					// 🚨 The period is what `cycleInvoicePaysFor` reads — an invoice-level
					// `period_start` on a renewal names the month BEFORE, so a fixture without
					// one lands a month early and discounts nothing. This is the half of the
					// fixture that is load-bearing rather than cosmetic.
					period: { start: cycleStartUnix, end: cycleStartUnix + 31 * 24 * 60 * 60 },
					parent: { subscription_item_details: { subscription_item: "si_1" } },
				},
			],
			has_more: false,
			url: "",
		},
	} as unknown as Stripe.Invoice;
}

describe("a suspended supporter's renewal", () => {
	it("is booked as paused and settles nobody until reinstatement re-keys it", async () => {
		const creatorId = await makeUser("creator");
		const supporterId = await makeUser("supporter");

		// The account row `recordPaidInvoice` resolves the renewal against. Stripe is not
		// configured in the suite, so `paymentOf`/`processingFeeFor` return their zero
		// fallbacks — which is fine, because what is under test is the row's status and
		// cycle, not the fee.
		await db.insert(accounts).values({
			userId: supporterId,
			stripeCustomerId: `cus_${tag}_paused`,
			anthersSupport: "6.00",
			isActive: true,
		});

		const invoice = renewalInvoice(`cus_${tag}_paused`, Date.parse("2031-07-01T00:00:00Z") / 1000);
		await suspend(supporterId);
		const recorded = await recordPaidInvoice(invoice);
		expect(recorded).not.toBeNull();

		const [row] = await db.select().from(invoices).where(eq(invoices.id, recorded!)).limit(1);
		expect(row.status).toBe("paused");

		// Settlement reads `paid` only, so the paused renewal credits nothing.
		await insertAttentionRange({
			userId: supporterId,
			creatorId,
			eventType: "watch",
			seconds: 1800,
			publicAccess: true,
			viaShareLink: false,
			endsAt: WATCHED_AT,
		});
		await settleCycle({ userId: supporterId, now: AFTER });
		const credits = await db
			.select()
			.from(creatorCredits)
			.where(
				and(eq(creatorCredits.subscriberId, supporterId), eq(creatorCredits.billingCycle, MONTH)),
			);
		expect(credits).toHaveLength(0);

		// Reinstatement re-keys the paused renewal against the month it lands in, and the
		// next settle credits it from there. A second resume is a no-op, which is the
		// property a redelivered unsuspend path needs.
		await unsuspend(supporterId, new Date("2031-08-05T00:00:00Z"));
		const [resumed] = await db.select().from(invoices).where(eq(invoices.id, recorded!)).limit(1);
		expect(resumed.status).toBe("paid");
		expect(resumed.billingCycle).toBe("2031-08-01");
		expect(await resumePausedRenewals(supporterId, new Date("2031-08-05T00:00:00Z"))).toBe(0);
	});

	it("reductions owed against a paused renewal are settled without minting a coupon", async () => {
		const supporterId = await makeUser("supporter");
		await db.insert(accounts).values({
			userId: supporterId,
			stripeCustomerId: `cus_${tag}_reduction`,
			anthersSupport: "6.00",
			isActive: true,
		});
		await db.insert(supportReductions).values({
			userId: supporterId,
			billingCycle: MONTH,
			destination: "anthers",
			amount: "2.00",
		});
		await suspend(supporterId);

		const invoice = renewalInvoice(
			`cus_${tag}_reduction`,
			Date.parse("2031-07-01T00:00:00Z") / 1000,
			"draft",
		);
		// The apply path takes Stripe for the spend it is refusing, so the suite has to
		// offer one — the real gate under test is the suspension read, not the client.
		// Nothing on it is ever called: the suspended branch returns before the coupon
		// half runs, and a `null` client would return 0 without stamping anything.
		const previous = setStripeClient({} as Stripe);
		const applied = await applyReductionsToInvoice(invoice);
		setStripeClient(previous);

		// No coupon was minted and nothing was spent, but the rows are settled — applied
		// against the invoice they reached, so the discarded renewal cannot spend them a
		// second time after reinstatement.
		expect(applied).toBe(0);
		const owed = await db
			.select()
			.from(supportReductions)
			.where(
				and(eq(supportReductions.userId, supporterId), eq(supportReductions.billingCycle, MONTH)),
			);
		expect(owed[0]?.appliedAt).not.toBeNull();
		expect(owed[0]?.appliedInvoiceId).toBe(invoice.id);
	});
});

describe("a suspended creator's payout hold", () => {
	it("credits nothing while the suspension stands, and credits on reinstatement", async () => {
		const creatorId = await makeUser("creator");
		const supporterId = await makeUser("supporter");

		// A paid month with time on the suspended creator.
		const [inv] = await db
			.insert(invoices)
			.values({
				userId: supporterId,
				stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 12)}`,
				billingCycle: MONTH,
				status: "paid",
				subtotal: "6.00",
				total: "6.00",
				processingFee: "0.47",
				paidAt: new Date("2031-07-01T03:00:00Z"),
			})
			.returning({ id: invoices.id });
		await db.insert(invoiceLines).values({ invoiceId: inv.id, creatorId: null, amount: "6.00" });
		await insertAttentionRange({
			userId: supporterId,
			creatorId,
			eventType: "watch",
			seconds: 1800,
			publicAccess: true,
			viaShareLink: false,
			endsAt: WATCHED_AT,
		});

		await suspend(creatorId);
		await settleCycle({ userId: supporterId, now: AFTER });

		let credits = await db
			.select()
			.from(creatorCredits)
			.where(
				and(eq(creatorCredits.subscriberId, supporterId), eq(creatorCredits.billingCycle, MONTH)),
			);
		expect(credits.filter((r) => r.creatorId === creatorId)).toHaveLength(0);

		// Reinstatement makes the creator earnable again. The withheld month is still on
		// the books — its invoice was never settled, because stamping it would close the
		// month with part of what it owed recorded nowhere — so the next scoped run finds
		// it and credits it normally rather than re-opening a closed month.
		await db
			.update(users)
			.set({ suspendedAt: null, suspendedUntil: null })
			.where(eq(users.id, creatorId));
		await settleCycle({ userId: supporterId, now: new Date("2031-08-03T02:00:00Z") });

		credits = await db
			.select()
			.from(creatorCredits)
			.where(
				and(eq(creatorCredits.subscriberId, supporterId), eq(creatorCredits.billingCycle, MONTH)),
			);
		const pool = credits
			.filter((r) => r.creatorId === creatorId && r.kind === "time_pool")
			.reduce((sum, r) => sum.plus(r.amount), new Decimal(0));
		expect(pool.toFixed(2)).toBe(new Decimal(timePoolFor(6)).toFixed(2));
	});

	it("reads the held balance and the review's standing for the admin Accounts view", async () => {
		const creatorId = await makeUser("creator");
		await db.insert(creatorCredits).values([
			{
				creatorId,
				subscriberId: creatorId,
				billingCycle: MONTH,
				kind: "support",
				fundedBy: "supporter",
				amount: "4.00",
				settledAt: new Date("2031-07-02T00:00:00Z"),
			},
			{
				creatorId,
				subscriberId: creatorId,
				billingCycle: MONTH,
				kind: "time_pool",
				fundedBy: "supporter",
				amount: "1.50",
				settledAt: new Date("2031-07-02T00:00:00Z"),
			},
		]);
		await suspend(creatorId);

		const review = await suspensionPayoutReview(creatorId);
		expect(review).not.toBeNull();
		expect(review!.heldAmount).toBe("5.50");
		expect(review!.resolvedAt).toBeNull();
		expect(review!.releasesAt).not.toBeNull();

		// An operator's clear stamps the row; the balance it released is untouched, which
		// is the whole of the anti-forfeiture rule — the release moves nothing, it ends
		// the hold.
		expect(await releasePayoutHold({ userId: creatorId })).toBe(true);
		const after = await suspensionPayoutReview(creatorId);
		expect(after!.resolvedAt).not.toBeNull();
		expect(after!.releasesAt).toBeNull();
		expect(after!.heldAmount).toBe("5.50");
	});

	it("releases itself when the review window lapses with no finding recorded", async () => {
		const creatorId = await makeUser("creator");
		await db.insert(creatorCredits).values({
			creatorId,
			subscriberId: creatorId,
			billingCycle: MONTH,
			kind: "support",
			fundedBy: "supporter",
			amount: "2.00",
			settledAt: new Date("2031-07-02T00:00:00Z"),
		});
		// Suspended exactly at the window's edge, so the sweep's cutoff arithmetic is the
		// thing under test rather than a large margin.
		await db
			.update(users)
			.set({ suspendedAt: new Date("2031-07-10T00:00:00Z") })
			.where(eq(users.id, creatorId));

		const justBefore = new Date(
			Date.parse("2031-07-10T00:00:00Z") + (PAYOUT_REVIEW_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000,
		);
		await releaseStalePayoutHolds(justBefore);
		let [row] = await db
			.select({ resolved: users.payoutReviewResolvedAt })
			.from(users)
			.where(eq(users.id, creatorId));
		expect(row.resolved).toBeNull();

		const justAfter = new Date(
			Date.parse("2031-07-10T00:00:00Z") + (PAYOUT_REVIEW_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000,
		);
		// Other tests on this creator suspended the same day and resolved by hand; the
		// sweep releases what is still open, so the assertion is on THIS account's row
		// rather than a count across the shared database.
		await releaseStalePayoutHolds(justAfter);
		[row] = await db
			.select({ resolved: users.payoutReviewResolvedAt })
			.from(users)
			.where(eq(users.id, creatorId));
		expect(row.resolved).not.toBeNull();
		// And the release never touches the balance it freed: a stale window paying out
		// is the default outcome, not a person deciding, and nothing here moves money.
		const review = await suspensionPayoutReview(creatorId);
		expect(review!.resolvedAt).not.toBeNull();
	});

	it("does not re-release a hold whose review already concluded", async () => {
		const creatorId = await makeUser("creator");
		// Earlier than the other fixtures, so this account is the one the sweep should
		// already find resolved even after the lapse test above has been run anywhere.
		await db
			.update(users)
			.set({ suspendedAt: new Date("2031-07-10T00:00:00Z"), payoutReviewResolvedAt: new Date() })
			.where(eq(users.id, creatorId));
		expect(await releasePayoutHold({ userId: creatorId })).toBe(false);
	});
});
