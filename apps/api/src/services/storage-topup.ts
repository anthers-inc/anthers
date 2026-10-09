// SPDX-License-Identifier: Apache-2.0
/**
 * The at-cost storage top-up — the charging surface behind `estimateStorageCost`'s ruled
 * shape.
 *
 * **The ladder bills nothing; the top-up is the only place storage costs money** (the
 * ruling task's fourth pass, Parker 2026-10-07): at the provider's rate, no mark-up, and
 * only for an account holding a Badge at Root or above. An account at or under its
 * allowance is charged nothing — within-limits is the whole rule, and there is no
 * between-rungs case.
 *
 * 🚨 **The one stripe-shaped consumer of `storage_usage`, reading the cycle the overflow
 * belongs to, not the cycle it is noticed in.** A renewal invoice composed on the 1st
 * names, in its *lines' periods*, the month it pays FOR — which is the month whose bytes
 * were just held. The overflow metered during that month is what the top-up prices;
 * `cycleInvoicePaysFor` is the same read the reductions and the recorder run, so all
 * three of the invoice's consumers agree on what a renewal invoice is about.
 *
 * 🚨 **The line is added to the DRAFT renewal invoice** (`invoice.created`, the window
 * `applyReductionsToInvoice` already runs in — Stripe finalizes about an hour later) as
 * an invoice item priced against the Anthers Product. It is NOT a subscription item: a
 * subscription's items are its standing lines, and the top-up is a per-cycle fact that
 * must not outlive the cycle it prices — the next renewal re-reads the meter and adds
 * its own line, whatever this month's said.
 *
 * 🚨 **Idempotent by stamp lookup, not by memory.** A webhook is retried, and two
 * `invoice.created` deliveries about one draft must not add two lines. The item's
 * metadata carries `anthers: "storage-topup"`, and a draft already carrying an item
 * under that stamp is left alone: find-then-add, where the find is against Stripe's own
 * record and survives a process restart between the deliveries.
 *
 * ⚠️ **The recorded figure, not the Stripe one, is the audit.** When the invoice is
 * paid, `recordPaidInvoice` records its lines — an invoice-item line carries no
 * `subscription_item` id, so it is credited to Anthers (that function's documented
 * fallback for an unmapped line), which is right for an at-cost pass-through: the money
 * is Anthers' own reimbursement of its own vendor cost, never a creator's earnings.
 * What the overflow was measured FROM stays readable from the `storage_usage` snapshot
 * the line's metadata names (`meteredCycle`).
 */

import { db } from "@anthers/db/client";
import { badges, billingAccounts, storageUsage, userBadges, users } from "@anthers/db/schema";
import { previousCycleKey } from "@anthers/shared/billing-cycle";
import {
	STORAGE_LADDER_GIB,
	STORAGE_PER_GIB_MONTH,
	storageGibFor,
} from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { createInvoiceItem, listDraftInvoiceItems, paymentsConfigured } from "../lib/processor.js";
import { anthersUserId } from "./anthers-badges.js";
import { ensureAnthersProduct } from "./billing.js";
import { cycleInvoicePaysFor } from "./stripe-invoice.js";

/** The metadata stamp marking an invoice item as this module's own line. */
export const TOPUP_STAMP = "storage-topup";

/**
 * The overflow, in GiB and dollars, a metered snapshot names — the billing-shaped read of
 * a `storage_usage` row.
 *
 * Nothing here re-reads the upstream tables: the meter is the figure's author and this is
 * a reader, on the same one-writer rule the account-facing reading takes. The eligibility
 * rule is the ruling's, whole: allowance from the held Anthers Badge (`storageGibFor`,
 * the same read every other gate runs), charged only from Root. A cycle with no snapshot
 * row is an undercount by absence — the meter writes only accounts holding bytes — and
 * the honest cost of that absence is zero, because a row's absence says the account held
 * nothing.
 */
export function topUpFromSnapshot(params: {
	snapshot: { bytes: number } | undefined;
	anthersDollars: number;
}): { allowanceGiB: number; overflowGiB: Decimal; dollars: Decimal; eligible: boolean } {
	const allowanceGiB = storageGibFor(params.anthersDollars);
	const eligible = allowanceGiB > STORAGE_LADDER_GIB.free;
	let overflowGiB = new Decimal(0);
	if (eligible && params.snapshot) {
		const allowanceBytes = allowanceGiB * 1024 * 1024 * 1024;
		if (params.snapshot.bytes > allowanceBytes) {
			overflowGiB = new Decimal(params.snapshot.bytes - allowanceBytes).div(1024 * 1024 * 1024);
		}
	}
	return { allowanceGiB, overflowGiB, dollars: overflowGiB.mul(STORAGE_PER_GIB_MONTH), eligible };
}

/**
 * Add the top-up line to a draft renewal invoice, when the cycle it pays for carries a
 * chargeable overflow.
 *
 * Called from the Stripe webhook's `invoice.created` window, beside the reductions — the
 * two invoice mutators are deliberately independent, because a draft with a reduction but
 * no top-up is a normal month for a mid-month starter and a draft with a top-up but no
 * reduction is a normal month for a heavy keeper. Returns the dollars added, so the
 * caller logs a true figure; a run that added nothing (the overwhelming majority — every
 * invoice from every account under its allowance) answers 0.
 */
export async function addTopUpToInvoice(invoice: Stripe.Invoice): Promise<number> {
	if (!paymentsConfigured()) return 0;

	// The same narrow gate the reductions take: a draft, a renewal, an invoice Stripe is
	// still holding. Everything unrecognized is a silent no-op.
	if (invoice.status !== "draft" || invoice.billing_reason !== "subscription_cycle") return 0;
	if (!invoice.id) return 0;

	const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
	if (!customerId) return 0;

	const [acct] = await db
		.select({ userId: billingAccounts.userId })
		.from(billingAccounts)
		.where(eq(billingAccounts.stripeCustomerId, customerId))
		.limit(1);
	if (!acct) return 0;

	// Idempotence: the stamp IS the find. A draft carrying a top-up line is one a
	// previous delivery already priced, and pricing it again from today's meter would
	// double-charge on a redelivered webhook.
	const existing = await listDraftInvoiceItems({ invoice: invoice.id, limit: 100 });
	if (existing?.data.some((it) => it.metadata?.anthers === TOPUP_STAMP)) return 0;

	// A suspended supporter's renewal credits nobody — the recorder drops it — so a
	// top-up line on one would be a charge against money that settles into nothing. The
	// same posture `applyReductionsToInvoice` takes, mirrored for a charge, not a credit.
	const [holder] = await db
		.select({ suspendedAt: users.suspendedAt })
		.from(users)
		.where(eq(users.id, acct.userId))
		.limit(1);
	if (holder?.suspendedAt != null) return 0;

	// The cycle the invoice PAYS FOR, read from its lines — and the metered month is the
	// one BEFORE it: the invoice pays forward for the month starting now, and the bytes
	// charged for were held during the month just ended.
	const cycle = cycleInvoicePaysFor(invoice);
	const meteredCycle = previousCycleKey(cycle);
	const [snapshot] = await db
		.select({ bytes: storageUsage.bytes })
		.from(storageUsage)
		.where(and(eq(storageUsage.userId, acct.userId), eq(storageUsage.billingCycle, meteredCycle)))
		.limit(1);

	// The allowance resolves from the HELD Badge for the cycle being paid for — the rung
	// this very invoice is buying is the rung that prices the allowance past it. A $0 or
	// lapsed holding is free's floor, and free is never charged (the ruling's entry gate).
	const anthersId = await anthersUserId();
	const [held] = await db
		.select({ held: sql<string>`COALESCE(MAX(${badges.threshold}), '0.00')` })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(
			and(
				eq(userBadges.userId, acct.userId),
				eq(userBadges.billingCycle, cycle),
				sql`${badges.creatorId} = ${anthersId}`,
			),
		);
	const anthersDollars = Number(held?.held ?? 0);

	const { allowanceGiB, overflowGiB, dollars, eligible } = topUpFromSnapshot({
		snapshot,
		anthersDollars,
	});
	// $0.50 is Stripe's own minimum charge — a top-up under it would fail to compose, so
	// the boundary is the chargeability boundary and not a preference.
	if (!eligible || overflowGiB.lessThanOrEqualTo(0) || dollars.lessThan(0.5)) return 0;

	const product = await ensureAnthersProduct();
	if (!product) return 0;

	const cents = dollars.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
	const item = await createInvoiceItem({
		customer: customerId,
		invoice: invoice.id,
		currency: "usd",
		description: `Storage past your ${allowanceGiB} GiB allowance, at cost ($${STORAGE_PER_GIB_MONTH}/GiB)`,
		// `amount` (integer cents), not `price_data`: the top-up is billed once, now, on
		// this invoice — a `price_data` line would be a recurring-looking price shape for
		// what is a one-off line, and the typed SDK's `pricing` shape offers no decimal
		// unit amount to compose one from. The half-cent rounding this carries lands
		// inside the figure the metadata's `overflowGiB` can recompute exactly.
		amount: cents,
		quantity: 1,
		metadata: {
			anthers: TOPUP_STAMP,
			userId: String(acct.userId),
			meteredCycle,
			overflowGiB: overflowGiB.toFixed(4),
		},
	});
	if (!item) return 0;
	return dollars.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}
