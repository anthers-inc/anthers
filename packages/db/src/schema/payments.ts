// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	bigint,
	boolean,
	index,
	integer,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { works } from "./content.js";

export const stripeAccounts = pgTable("stripe_accounts", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	stripeAccountId: text("stripe_account_id").notNull().unique(),
	chargesEnabled: boolean("charges_enabled").default(false),
	payoutsEnabled: boolean("payouts_enabled").default(false),
	onboardingComplete: boolean("onboarding_complete").default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Decimal columns are stored as numeric to preserve decimal.js precision (app owns rounding).
export const purchases = pgTable(
	"purchases",
	{
		id: serial("id").primaryKey(),
		// Nullable + SET NULL (settled 2026-08-10, replacing the cascade). Deleting an
		// account detaches the buyer and KEEPS the financial row: Anthers is a
		// marketplace facilitator and must be able to evidence the sales tax it collected
		// and remitted, which it cannot do from a row that no longer exists.
		//
		// This is not a walk-back of "deletion should mean deletion" — that ruling put
		// the safety earlier in the flow (informed consent, a cancel window, no
		// hoarding), all of which still hold. What survives here is not personal data
		// once detached: an amount, a tax figure, a Stripe reference and a snapshot of
		// what was sold, with no route back to a person. GDPR Art. 17(3)(b) exempts
		// erasure where processing is required by law, and severing the identity link is
		// the standard remedy rather than a loophole. 51.05 says so in the user's words.
		buyerId: integer("buyer_id").references(() => users.id, { onDelete: "set null" }),
		// What was bought. A purchase unlocks a **Work**, not a Post — access moved onto the
		// Work in `0010`, and a permanent unlock has to name the thing it unlocks. Null for
		// one-time charges that aren't a Work purchase (e.g. a Seed buy).
		//
		// SET NULL, not cascade (`0016`). It was cascade, which meant a creator deleting a
		// Work destroyed every row here that named it — the buyer's entitlement, the
		// financial record, and the `sales_tax` figure that makes remittance reportable.
		// A receipt is not a detail of the thing bought; it outlives it, the same way
		// moderation records outlive the account they concern.
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		// Who was paid. Denormalised deliberately, because it used to be reachable ONLY by
		// joining `works` — so a deleted Work took the seller's identity with it and the
		// sale silently left that creator's own earnings maths (`calculate-crf` joined
		// through `works` to get here). Null for charges with no creator side (a Seed buy).
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// A snapshot of what was bought, as it was at the time of sale. These are NOT a
		// cache of the Work — they are what the row still says after the Work is gone, and
		// they deliberately do not track later edits: a receipt records the transaction as
		// it happened, not the current state of the catalogue.
		workTitle: text("work_title"),
		workType: text("work_type"),
		workPublicId: bigint("work_public_id", { mode: "number" }),
		type: text("type").notNull().default("digital"), // digital | physical | service | seeds
		amount: numeric("amount").notNull(),
		processingFee: numeric("processing_fee").notNull(),
		// The first download's delivery, at cost, on a digital sale. Always "0.00" since
		// 2026-08-12 — egress is free — but historical rows carry real values and the
		// refund path reads them, so the column stays. Dropping it is its own migration.
		deliveryFee: numeric("delivery_fee").notNull().default("0.00"),
		crfFee: numeric("crf_fee").notNull(), // Legacy column name; stores the retired purchase fee; always 0 since 2026-08-03
		// Sales tax is the ONE thing added on top of the list price, so it is money we
		// collect and owe onward rather than money anyone here keeps. Recording it
		// per-transaction is what makes remittance reportable; without the column the tax
		// was charged inside `buyer_total` and then unrecoverable from the row. Defaults
		// to 0.00 for the charges that carry none (a Seed buy).
		salesTax: numeric("sales_tax").notNull().default("0.00"),
		creatorEarnings: numeric("creator_earnings").notNull(),
		/**
		 * 🚨 **Indexed, not UNIQUE** (changed 2026-08-13, migration `0033`).
		 *
		 * It was unique while one charge could only ever mean one purchase, and that
		 * assumption is exactly what a basket breaks: buying five Works on one card charge
		 * writes five rows sharing this id — which is the entire point, since the fixed
		 * $0.30 is per charge. The constraint didn't guard idempotency (the `pending` →
		 * `completed` status predicate does that, and still does); it encoded a
		 * one-purchase-per-charge model that no longer holds.
		 *
		 * Every reader of this column was already written to expect several rows, or was
		 * corrected in the same change: the webhook completes **all** pending rows, and
		 * `refunds.ts` settles **all** siblings because a refund with no `amount` returns
		 * the whole charge.
		 */
		stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
		status: text("status").notNull().default("pending"), // pending | completed | failed | refunded
		// ── Delivery & refunds (`0018`) ──────────────────────────────────────────
		// When this buyer first pulled the actual payload down. Null = never
		// downloaded, and that distinction is what the refund policy turns on: the
		// cap applies only to refunds *after* download, because the un-sendable
		// bytes are the loss it exists to bound (51.06 § Refunds).
		//
		// Stamped by the asset-download route only — not by streaming. `works.
		// download_count` is a Work-wide counter and cannot answer "did *this*
		// buyer download it", which is the question the cap needs.
		downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
		refundedAt: timestamp("refunded_at", { withTimezone: true }),
		// Who caused the refund, and it is NOT decoration: a platform-initiated
		// refund (a takedown, a defect, a charge the buyer never made) refunds
		// someone who may well have downloaded, and must not consume their cap.
		// Only `buyer` rows are counted. buyer | platform
		refundInitiator: text("refund_initiator"),
		refundReason: text("refund_reason"),
		stripeRefundId: text("stripe_refund_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	// resolveAccess treats a completed purchase as a permanent unlock, so (buyer, work)
	// is read on every gated view — and neither column was indexed until `0015`.
	(table) => [
		index("idx_purchases_buyer").on(table.buyerId),
		index("idx_purchases_work").on(table.workId),
		// creator_id arrives already indexed: it is what calculate-crf now sums by, and
		// an unindexed FK is the exact debt `0015` was written to clear.
		index("idx_purchases_creator").on(table.creatorId),
		// Replaces the UNIQUE constraint the column carried until `0033`. The lookup is
		// hot on both webhook branches and on every refund, and it now returns a SET.
		index("idx_purchases_payment_intent").on(table.stripePaymentIntentId),
	],
);

export const crfLedger = pgTable(
	"crf_ledger",
	{
		id: serial("id").primaryKey(),
		amount: numeric("amount").notNull(),
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		description: text("description").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_crf_ledger_purchase").on(table.purchaseId)],
);

// billingCycle is stored as an ISO date string (YYYY-MM-DD) — first of the month.
export const crfSubsidies = pgTable(
	"crf_subsidies",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		billingCycle: text("billing_cycle").notNull(),
		estimatedHostingCost: numeric("estimated_hosting_cost").notNull(),
		creatorEarnings: numeric("creator_earnings").notNull(),
		subsidyAmount: numeric("subsidy_amount").notNull(),
		// Byte counts can exceed 2^31 — bigint, not integer.
		storageBytes: bigint("storage_bytes", { mode: "number" }).default(0),
		projectCount: integer("project_count").default(0),
		postCount: integer("post_count").default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_crf_subsidies_creator_cycle").on(table.creatorId, table.billingCycle),
	],
);
