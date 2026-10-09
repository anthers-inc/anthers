// SPDX-License-Identifier: Apache-2.0
/**
 * Payments schema — see auth.ts for the role-classification legend. All the tables here
 * are `org` by the treasury rule: payments, pools, payouts and KYC stay with the org, because a
 * treasury cannot be spread across machines other people run. No exceptions.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { adminAccounts } from "./admin.js";
import { users } from "./auth.js";
import { works } from "./content.js";
import { creatorCredits, invoices } from "./subscriptions.js";

// org — a creator's Stripe Connect account. Money; org-only.
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
	/**
	 * Whether this creator wants an email receipt for every transaction on their work —
	 * a sale, a refund — sent to their account address, on top of the buyer's own
	 * receipt. On by default (Parker, 2026-10-07): the platform and every creator on it
	 * are low-volume today, so the mail is welcome record-keeping rather than noise, and
	 * a creator who outgrows it flips one switch rather than writing to ask.
	 *
	 * Nullable rather than `notNull().default(true)`: null is "never answered", which is
	 * what lets the default move (or the mail be retired for a class of transactions)
	 * without rewriting stored rows — the same convention `userPreferences` states for
	 * its display preferences. Readers treat null as on.
	 */
	creatorReceiptEmails: boolean("creator_receipt_emails").default(true),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// org — a purchase is a financial record (the doc comment: "a receipt is not a detail
// of the thing bought; it outlives it"). All three FKs are set-null because money
// records outlive accounts. Money cannot federate.
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
		// the standard remedy rather than a loophole. Privacy Policy says so in the user's words.
		buyerId: integer("buyer_id").references(() => users.id, { onDelete: "set null" }),
		// What was bought. A purchase unlocks a **Work**, not a Post — access moved onto the
		// Work in `0010`, and a permanent unlock has to name the thing it unlocks. Null for
		// one-time charges that aren't a Work purchase (e.g. a support top-up, `type: "seeds"`).
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
		// through `works` to get here). Null for charges with no creator side (a support top-up).
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// A snapshot of what was bought, as it was at the time of sale. These are NOT a
		// cache of the Work — they are what the row still says after the Work is gone, and
		// they deliberately do not track later edits: a receipt records the transaction as
		// it happened, not the current state of the catalog.
		workTitle: text("work_title"),
		workType: text("work_type"),
		workPublicId: bigint("work_public_id", { mode: "number" }),
		type: text("type").notNull().default("digital"), // digital | physical | service | seeds
		amount: numeric("amount").notNull(),
		processingFee: numeric("processing_fee").notNull(),
		// Sales tax is the ONE thing added on top of the list price, so it is money we
		// collect and owe onward rather than money anyone here keeps. Recording it
		// per-transaction is what makes remittance reportable; without the column the tax
		// was charged inside `buyer_total` and then unrecoverable from the row. Defaults
		// to 0.00 for the charges that carry none (a support top-up).
		salesTax: numeric("sales_tax").notNull().default("0.00"),
		creatorEarnings: numeric("creator_earnings").notNull(),
		/**
		 * 🚨 **Stamped at checkout COMPLETION, never at quote time** — `salesTax` above is
		 * zero until Stripe Tax has actually resolved the buyer's address, which happens
		 * inside the Checkout Session. The webhook that flips a purchase `pending →
		 * completed` reads the session's `total_details.amount_tax` back and writes it
		 * here, because this row is the remittance record the return worksheets and the
		 * threshold forecast read, and retrofitting buyer location onto past charges is
		 * the expensive direction.
		 */
		buyerCountry: text("buyer_country"),
		/** State or subdivision code, as Stripe resolved it (e.g. "CO"). */
		buyerState: text("buyer_state"),
		/** Postal code — the grain home-rule city rates turn on. */
		buyerPostalCode: text("buyer_postal_code"),
		/** The buyer's street address as entered at checkout, for the record. */
		buyerAddressLine1: text("buyer_address_line1"),
		buyerAddressLine2: text("buyer_address_line2"),
		/** City as entered — null when the buyer's row predates the column. */
		buyerCity: text("buyer_city"),
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
		 * Every user of this column was already written to expect several rows, or was
		 * corrected in the same change: the webhook completes **all** pending rows, and
		 * `refunds.ts` settles **all** siblings because a refund with no `amount` returns
		 * the whole charge.
		 */
		stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
		// pending → completed by the webhook; failed when the charge never cleared.
		// `refunded` by the refund paths, and `disputed` by the dispute webhook — a
		// chargeback flips the row here to revoke the buyer's access (`resolveAccess`
		// counts only `completed`, so no code is needed to take the unlock away), and
		// a won dispute flips it back because the money came back.
		status: text("status").notNull().default("pending"), // pending | completed | failed | refunded | disputed
		// ── Delivery & refunds (`0018`) ──────────────────────────────────────────
		// When this buyer first pulled the actual payload down. Null = never
		// downloaded, and that distinction is what the refund policy turns on: the
		// cap applies only to refunds *after* download, because the un-sendable
		// bytes are the loss it exists to bound (Terms of Service § Refunds).
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

/**
 * org — a Stripe dispute (a chargeback) on a charge Anthers processed. Money; org-only by
 * the treasury rule, and the record exists at all because Anthers never contests one
 * (settled 2026-09-14): the money is treated as gone from the moment the dispute lands, so
 * the row is the record of money that left, not of a contest whose outcome we await.
 *
 * ⭐ **This module is the one writer of dispute rows** (`services/disputes.ts`, the same
 * writer-module rule `refunds.ts` follows). Routes and the admin app read it; nothing else
 * writes it.
 *
 * 🚨 **A dispute concerns a CHARGE, not a Work.** The row deliberately carries no `work_id`
 * or `creator_id` of its own: the charge's ties to a purchase (and through it to a Work) or
 * to an invoice are how everything else is found, so `purchase_id` and `invoice_id` are the
 * links — both nullable, both `set null`, because the dispute record outlives the purchase
 * or invoice it landed on the same way every other money record here outlives what it paid
 * for. At most one of the two is ever set: a charge is either a Work purchase or monthly
 * support, never both. The dispute-activity ratio the admin alert reads is disputes in a
 * period ÷ successful payments in that period, and the `disputes` rows here are its numerator
 * — see `disputeActivityRatio` in `services/disputes.ts` for the denominator's caveats.
 */
// org — the record of every receipt email Anthers has sent, and the idempotency latch
// that stops it sending twice. Money cannot federate.
export const receiptSends = pgTable(
	"receipt_sends",
	{
		id: serial("id").primaryKey(),
		/**
		 * The natural key naming one receipt, one recipient, once. Built from the
		 * transaction's own Stripe identity rather than hashed copy, the same rule
		 * `notify()`'s dedupeKey states: `purchase:<intentId>:buyer:<userId>`,
		 * `refund:<refundId>:<role>:<userId>`, `invoice:<stripeInvoiceId>:buyer:<userId>`,
		 * with `creator` replacing the role for the creator's copy. A key that already
		 * exists means the receipt was sent; the `.onConflictDoNothing` insert is the
		 * whole guard, so a redelivered webhook finds the row and changes nothing.
		 */
		dedupeKey: text("dedupe_key").notNull().unique(),
		/** `purchase` | `refund` | `invoice` — which kind of transaction the receipt is for. */
		kind: text("kind").notNull(),
		/**
		 * Who the receipt went to, and their address at send time. Both are kept because
		 * the FKs are `set null`: a receipt is evidence we told somebody, which has to
		 * outlive the account like every other money record here, and an address alone
		 * says who the evidence was about without claiming the account still exists.
		 */
		userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
		/** `buyer` | `creator` — which side of the transaction the recipient was on. */
		role: text("role").notNull(),
		email: text("email").notNull(),
		/** Whether the provider accepted the message. Delivery is Resend's to report. */
		sent: boolean("sent").notNull().default(false),
		messageId: text("message_id"),
		/**
		 * What the provider later told us became of the message — a Resend delivery event
		 * matched on {@link messageId}, recorded by the same webhook that reports
		 * escalation alerts. Null until an event arrives; `delivered` when the receiving
		 * server accepted it; `bounced`/`failed`/`complained` when it did not.
		 *
		 * ⚠️ **Accepted is not delivered** — that distinction is the whole reason the
		 * webhook exists (`services/delivery-events.ts`), and a receipt whose send was
		 * accepted but which then bounced is a person who was not told about their money.
		 * The failed-mail panel reads this column beside `sent`.
		 */
		deliveryEvent: text("delivery_event"),
		deliveryEventAt: timestamp("delivery_event_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_receipt_sends_user").on(table.userId),
		// The delivery webhook matches on the provider's id; without this every event is a
		// scan of the table the receipt rows live in.
		index("idx_receipt_sends_message").on(table.messageId),
	],
);

// org — the record of money the processor clawed back. Money cannot federate.
export const disputes = pgTable(
	"disputes",
	{
		id: serial("id").primaryKey(),
		/** The Stripe `dp_...` id. Unique: a redelivered `charge.dispute.created` finds the row and changes nothing. */
		stripeDisputeId: text("stripe_dispute_id").notNull().unique(),
		/** The Stripe `ch_...` id of the disputed charge. */
		stripeChargeId: text("stripe_charge_id").notNull(),
		/**
		 * The PaymentIntent the charge belongs to — how the purchase or invoice row is found,
		 * the same key `markInvoiceMoneyReturned` resolves an invoice by.
		 */
		stripePaymentIntentId: text("stripe_payment_intent_id"),
		/** Disputed amount in dollars, as Stripe reports the cents. */
		amount: numeric("amount").notNull(),
		currency: text("currency").notNull().default("usd"),
		/** Stripe's dispute reason code (`fraudulent`, `product_unacceptable`, …), verbatim. */
		reason: text("reason").notNull(),
		/**
		 * Stripe's own dispute status vocabulary, stored verbatim:
		 * `needs_response | under_review | won | lost | warning_needs_response |
		 * warning_under_review | warning_closed | unchallengeable`. Never translated — the
		 * admin list renders Stripe's word, and `outcome` below is what our own users key on.
		 */
		status: text("status").notNull(),
		/** The purchase this charge was, when it was one — null on a support charge. */
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		/** The invoice this charge paid, when it was a support charge — null on a purchase. */
		invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
		/** The buyer, from the purchase or invoice row — `set null`, the record outlives the account. */
		userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
		/**
		 * When evidence is due at Stripe (`evidence_details.due_by`, a Unix timestamp) — what
		 * the admin deadline list reads. Null once the dispute is closed, and always null on
		 * the statuses (`warning_*`, `unchallengeable`) that carry no evidence window.
		 */
		evidenceDueBy: timestamp("evidence_due_by", { withTimezone: true }),
		/**
		 * `won` or `lost` once Stripe closes the dispute, null until then. This is the column
		 * our own users key on rather than `status`, because it is ours: a `won` dispute is
		 * the money coming back (the purchase is restored), a `lost` one is it gone for good.
		 */
		outcome: text("outcome"),
		/**
		 * The admin account that chose to contest this dispute — set once, by the contest
		 * submission, never after. Contested is a person's explicit act (Parker, 2026-09-15:
		 * the deliberate exception for egregious/suspicious/large disputes; never the
		 * default), so the row names who made it the same way every operator action does.
		 * `set null`, because the dispute record outlives the admin account.
		 */
		contestedByAdminId: integer("contested_by_admin_id").references(() => adminAccounts.id, {
			onDelete: "set null",
		}),
		/**
		 * When that person submitted evidence to Stripe. Visa's CE3.0 rule is one attempt
		 * only, so this column is also the once-guard: a second submission finds it set and
		 * is refused before anything reaches Stripe.
		 */
		contestedAt: timestamp("contested_at", { withTimezone: true }),
		/**
		 * The evidence exactly as it was sent — the honest record of what Anthers told the
		 * bank, the same way `admin_account_events.detail` records an operator action.
		 * jsonb rather than one column per field, because Stripe's evidence object is
		 * Stripe's vocabulary and gains fields without our schema noticing; what we sent
		 * is history, not state something reads.
		 */
		contestedEvidence: jsonb("contested_evidence"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_disputes_purchase").on(table.purchaseId),
		index("idx_disputes_invoice").on(table.invoiceId),
	],
);

/**
 * org — the signed-in buyer's basket, one row per (user, Work). A **scratchpad, not a
 * record** — nothing here is money and nothing is an entitlement — but it is the buyer's,
 * not the browser's (Parker, 2026-10-03): the basket is scoped to the account, so a second
 * account signing in on the same machine starts empty. It moved out of client-side
 * `localStorage` for exactly that reason, and the anonymous scratch basket that still lives
 * in the browser MERGES into this table at sign-in and is then cleared — once a session has
 * an account, this table is the only basket it reads.
 *
 * 🚨 **Never trusted.** The rows are ids, not facts: every id is re-resolved server-side
 * through `resolveBasket` at quote and checkout (price, release state, ownership, the
 * one-creator rule, the item cap — all the refusals that fired on the client-supplied list
 * still fire on these rows), and `list` returns only what still resolves — so a Work that
 * stopped being buyable between add and checkout counts on no badge and charges in no
 * checkout. A tampered table buys nothing it shouldn't.
 *
 * ⚠️ **The rows do not self-clean.** A Work that stops being buyable leaves its row here
 * until the buyer removes it or the basket clears at a completed checkout. That is
 * deliberate: resolution is what the reads are for, and a sweeper job is one more thing
 * that can disagree with them.
 *
 * 🚨 **One creator per basket**, enforced at `add`: adding a second creator's Work
 * REPLACES the rows rather than rejecting them — the buyer's most recent intent wins, the
 * same courtesy the old client-side basket kept. The rule is enforced again at quote and
 * checkout (`mixed_creators`), because Stripe's `transfer_data.destination` names exactly
 * one connected account — see `resolveBasket` in `routes/payments.ts`.
 *
 * Cascade on both sides, like `library_items`: a basket is a preference, not a record —
 * it dies with the account and with the Work, and never outlives either.
 */
// org — a buyer's basket is the buyer's record (same reasoning as `libraryItems`: the
// user has no node in the current topology, so their preferences are org-side rows).
// It sits with the payments tables because only the payments routes read it, but note
// it is NOT money: no column here is a figure, and nothing downstream books from it.
export const basketItems = pgTable(
	"basket_items",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Cascade, not SET NULL (opposite of `purchases.work_id`): a purchase is money and
		// must outlive the Work; a basket entry is scratch and must not name a Work that
		// no longer exists. resolveBasket would refuse the row anyway — this just is not
		// in the business of remembering it.
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		// Insertion order is the basket's display order — the client's old array order —
		// and no column reorders it: newest Work at the end, like a physical basket.
		addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// A Work sits in an account's basket once. Both columns are NOT NULL, so unlike
		// `library_items`' partial uniques this one is plain.
		uniqueIndex("uq_basket_items_user_work").on(table.userId, table.workId),
		// The cascade's read side: deleting a Work finds its basket rows here. The user
		// list is covered by the uniques's leading column.
		index("idx_basket_items_work").on(table.workId),
	],
);

// org — the CRF (Creator Resilience Fund) ledger. Org money record.
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

// org — per-cycle CRF subsidy calculation. Org money record; the `isSelfHosting` flag
// it reads was closed to a 503 (PR #48) because the feature it prices does not exist.
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

/**
 * org — one transfer of a creator's held, settled money from Anthers' platform balance into
 * their connected-account balance. Money; org-only by the treasury rule, and doubly so:
 * the row is the platform's own record of a movement of the platform's own balance, which
 * no creator node has any business holding.
 *
 * ⭐ **Append-only, and deliberately has no `status` column.** A transfer row is written
 * once, after the Stripe call has succeeded, and is never updated — the coverage rows
 * below are likewise written once and never changed. There is no "pending" state to
 * reconcile because the idempotency mechanism does not need one (see
 * `jobs/transfer-held-credits.ts` for the crash-window reasoning): the Stripe
 * `idempotency_key` is derived deterministically from the coverage set, so a retry after a
 * Stripe-success/DB-failure replays the same key and Stripe returns the original transfer
 * rather than making a second one.
 *
 * 🚨 **The coverage rows ARE the link, not a denormalization.** A credit is "transferred"
 * exactly when a coverage row names it, and by nothing else — `creator_credits` carries no
 * transfer stamp precisely so this side stays append-only and a re-run can always find
 * what is still held by asking what no coverage row names. Money that comes back
 * (a refund or dispute after settlement) is other tasks' to move; they subtract from the
 * creator's balance on their own authority and never touch these rows, which is what keeps
 * this table a pure record of what left the platform balance and when.
 */
// org — a movement of the platform's own balance into a creator's connected account.
// Money; org-only, doubly so: the row is the platform's record of the platform's money.
export const creatorTransfers = pgTable(
	"creator_transfers",
	{
		id: serial("id").primaryKey(),
		/**
		 * Who the money went to. Set null on delete, for the same reason `creator_credits`
		 * is: the financial record outlives the account.
		 */
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		/** The Stripe `tr_...` id. Unique, because one transfer is one movement of money. */
		stripeTransferId: text("stripe_transfer_id").notNull().unique(),
		/** Dollars, as the sum of the credits this transfer covered. */
		amount: numeric("amount").notNull(),
		currency: text("currency").notNull().default("usd"),
		/** When Stripe accepted the transfer — stamped from the Stripe object, not from now. */
		transferredAt: timestamp("transferred_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The held-credits read: what has already left for each creator.
		index("idx_creator_transfers_creator").on(table.creatorId),
	],
);

/**
 * org — which credits one transfer covered. One row per credit id, never rewritten; the
 * pair (transfer, credit) is unique so a coverage set can never name a credit twice. This is
 * the "held vs transferred" split's only source of truth.
 */
// org — the coverage link between a transfer and the credits it moved. Money; org-only.
export const creatorTransferCredits = pgTable(
	"creator_transfer_credits",
	{
		id: serial("id").primaryKey(),
		transferId: integer("transfer_id")
			.notNull()
			.references(() => creatorTransfers.id, { onDelete: "cascade" }),
		creditId: integer("credit_id")
			.notNull()
			.references(() => creatorCredits.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_creator_transfer_credits_pair").on(table.transferId, table.creditId),
		// The held read's other half: which credits are covered, in one index.
		index("idx_creator_transfer_credits_credit").on(table.creditId),
	],
);

/**
 * org — the netting ledger: a record that a creator's share of returned money is to be
 * recovered from their later earnings (Parker, 2026-09-14, the collect-and-pay-out
 * decision's "Money That Comes Back").
 *
 * A purchase is a destination charge, so its creator's share reached them the moment the
 * charge cleared — the money is "after the transfer" by construction. When the buyer's
 * money later comes back (a refund or a chargeback), Anthers' own attempt to claw the
 * creator's share back is `refunds.ts`'s `reverse_transfer`, and that attempt works only
 * while the money still sits in the connected account's balance. Once the creator has
 * paid it out, Stripe does not carry creators' negative balances on destination charges
 * (the Tax and Compliance Plan's recorded finding, and Stripe's own docs — see
 * `services/netting.ts` for the sources), so the share is unrecovered at Stripe and
 * becomes this row: **the creator's earnings on the sale that came back, to be recovered
 * from what they earn next.**
 *
 * ⭐ **Why netting exists at all is a fraud route it closes.** Absorbing every chargeback
 * would let a creator buy their own Work with stolen cards, get paid, and leave the
 * chargebacks to Anthers — so Anthers absorbs its own share and anything it cannot
 * recover, but the creator's share is recovered from future earnings.
 *
 * 🚨 **Netting never sends a creator a bill** — the decision's own words, and the
 * invariant this table and its applications exist to hold. Recovery only ever comes from
 * future earnings (`creator_credits` the transfer step has not yet moved): if the open
 * netting exceeds what is held, the held sum transfers nothing and the netting stays
 * open. There is no account debit, no negative transfer, no state below zero.
 *
 * ⭐ **Append-only, no status column — remaining is derived.** A row is written once when
 * the money comes back, and how much of it is still open is always re-derivable:
 * `amount` minus the sum of its application rows (`creator_netting_applications` below),
 * exactly the way `creator_transfers`/`creator_transfer_credits` derive "held" from
 * coverage. A netting whose applications equal its amount is exhausted; one that never
 * gets there sits open indefinitely — **absorption is a bookkeeping fact on Anthers'
 * side, not a state change here**, because "the creator will never earn again" is not a
 * fact this system can know. (The books entry that records an absorbed remainder is the
 * Books milestone's to build; these rows are what it will read.)
 *
 * One row per (source event, creator). The source is at most one of: a purchase dispute
 * (`disputeId` — the `disputes` row's `purchaseId` names the sale) or a refunded purchase
 * (`purchaseId` + `stripeRefundId`, the (refund, purchase) pair — a basket refunds as a
 * basket, so one refund settles several siblings and each sibling's earnings are their
 * own netting under it). The check constraint
 * holds "at most one" rather than "exactly one" because both links are `set null` — the
 * row must survive its source's deletion, which is the money-record rule every table
 * here follows.
 */
// org — the platform's record of a creator's share of returned money, to be recovered
// from their later earnings. Money; org-only by the treasury rule, doubly so: the row is
// the platform's own receivable, which no creator node has any business holding.
export const creatorNettings = pgTable(
	"creator_nettings",
	{
		id: serial("id").primaryKey(),
		/**
		 * Whose share came back. Set null on delete, like `creator_credits`: the money record
		 * outlives the account, and an open netting against a deleted account is a fact about
		 * Anthers' books, not about the person.
		 */
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		/** The dispute whose chargeback returned the money — the dispute source's link. */
		disputeId: integer("dispute_id").references(() => disputes.id, { onDelete: "set null" }),
		/** The refunded purchase — the refund source's link to the sale. */
		purchaseId: integer("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		/**
		 * The Stripe `re_...` id of the refund that returned the money, on the refund source —
		 * the refund's own identity, which is what separates "a refund of this sale" from "a
		 * dispute on this sale" when both rows name the same purchase. Null on the dispute
		 * source, where the Stripe dispute id (on the `disputes` row) is the identity.
		 */
		stripeRefundId: text("stripe_refund_id"),
		/**
		 * 🚨 The creator's share that came back — the row's own `creator_earnings`, the earnings
		 * the creator received for a sale that has now been undone. NOT the buyer's full charge
		 * and NOT including the tax (money Anthers collected and owes onward, never the
		 * creator's) or the platform's share (Anthers' own to absorb, per the decision). Read
		 * off the purchase row at the moment the netting is written, because a receipt records
		 * the transaction as it happened.
		 */
		amount: numeric("amount").notNull(),
		/**
		 * When the money came back and this row was opened — the refund's or the dispute's
		 * landing, which is the moment recovery becomes owed. Kept distinct from
		 * `createdAt` only in principle; they are the same moment, and the column exists so
		 * a future source that opens a netting retroactively can say so honestly.
		 */
		openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
		/**
		 * When a won dispute reversed this netting — the money came back to Anthers, so
		 * whatever of it had been recovered goes back to the creator. Null until then, and
		 * written once (the predicate is its own latch), so a redelivered close event
		 * changes nothing.
		 *
		 * A reversal is a *compensation*, not a deletion: the applications that consumed held
		 * credits already happened and stay on the record (reversed, so they no longer count
		 * as recovery), and a compensating credit — a positive `creator_credits` row of kind
		 * `netting_reversal` — hands the creator back exactly what had been applied. Nothing
		 * was applied and the row is simply dead: its `reversedAt` says so, it derives as
		 * closed, and no application row will ever name it.
		 */
		reversedAt: timestamp("reversed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The netting read the transfer step and the earnings endpoint share: one creator's
		// open rows, in one index.
		index("idx_creator_nettings_creator").on(table.creatorId),
		index("idx_creator_nettings_dispute").on(table.disputeId),
		index("idx_creator_nettings_purchase").on(table.purchaseId),
		// One row per source event. The refund source's identity is the (refund, purchase)
		// pair — NOT the refund id alone, because a basket refunds as a basket: one
		// refund settles several sibling purchases, and each sibling's earnings are its
		// own netting under the same refund. The dispute source's identity is the dispute
		// row, which is itself unique on the Stripe dispute id.
		uniqueIndex("uq_creator_nettings_refund").on(table.stripeRefundId, table.purchaseId),
		uniqueIndex("uq_creator_nettings_dispute").on(table.disputeId),
		// At most one source. Not "exactly one": the `set null` on both links is what lets
		// the row outlive the purchase or dispute it names — the money-record rule — and a
		// row surviving its source's deletion has zero links left, which is a fact about
		// Anthers' books rather than an impossible state. The uniques below keep a row that
		// still HAS a source to one per source event.
		check(
			"ck_creator_nettings_one_source",
			sql`(CASE WHEN ${table.disputeId} IS NOT NULL THEN 1 ELSE 0 END) +
				(CASE WHEN ${table.purchaseId} IS NOT NULL THEN 1 ELSE 0 END) <= 1`,
		),
	],
);

/**
 * org — which credits one netting consumed, and for how much. One row per (netting,
 * credit), never rewritten: the pair is unique so a netting can never consume the same
 * credit twice, and the rows are the append-only record of what was recovered from
 * what, exactly the shape of `creator_transfer_credits` — with an amount, because a
 * netting can consume *part* of a credit and the remainder of that credit still moves.
 *
 * `reversedAt` is the won-dispute half: an application that was reversed no longer
 * counts as recovery (its amount is excluded from the applied sum), and the compensating
 * credit on `creator_credits` is what hands the creator their money back. The rows stay
 * on the record either way — a reversal is a fact that happened, not one that unhappened.
 */
// org — the application link between a netting and the credits it consumed. Money; org-only.
export const creatorNettingApplications = pgTable(
	"creator_netting_applications",
	{
		id: serial("id").primaryKey(),
		nettingId: integer("netting_id")
			.notNull()
			.references(() => creatorNettings.id, { onDelete: "cascade" }),
		creditId: integer("credit_id")
			.notNull()
			.references(() => creatorCredits.id, { onDelete: "cascade" }),
		/** How much of that credit this netting consumed, in dollars. */
		amount: numeric("amount").notNull(),
		/**
		 * When a won dispute reversed this application — null while it counts as recovery.
		 * The compensating credit carries the money back; this row stays as the record.
		 */
		reversedAt: timestamp("reversed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_creator_netting_applications_pair").on(table.nettingId, table.creditId),
		// The transfer step's read: which credits any open netting has already consumed.
		index("idx_creator_netting_applications_credit").on(table.creditId),
	],
);
