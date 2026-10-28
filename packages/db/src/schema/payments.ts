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
import { badges, creatorCredits, invoices } from "./subscriptions.js";

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
		// Work in `0010`, and a permanent unlock has to name the thing it unlocks. Null only
		// once the Work is gone: the FK is `SET NULL`, so a receipt outlives what it names.
		//
		// SET NULL, not cascade (`0016`). It was cascade, which meant a creator deleting a
		// Work destroyed every row here that named it — the buyer's entitlement, the
		// financial record, and the `sales_tax` figure that makes remittance reportable.
		// A receipt is not a detail of the thing bought; it outlives it, the same way
		// moderation records outlive the account they concern.
		workId: integer("work_id").references(() => works.id, { onDelete: "set null" }),
		// Who was paid. Denormalised deliberately, because it used to be reachable ONLY by
		// joining `works` — so a deleted Work took the seller's identity with it and the
		// sale silently left that creator's own earnings. Null for charges with no creator
		// side (a support top-up).
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// A snapshot of what was bought, as it was at the time of sale. These are NOT a
		// cache of the Work — they are what the row still says after the Work is gone, and
		// they deliberately do not track later edits: a receipt records the transaction as
		// it happened, not the current state of the catalog.
		workTitle: text("work_title"),
		workType: text("work_type"),
		workPublicId: bigint("work_public_id", { mode: "number" }),
		type: text("type").notNull().default("digital"), // digital | physical | service
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
		/**
		 * The transfer that carried this row's creator's share of the charge, stamped at
		 * checkout COMPLETION — the same moment the tax and the intent re-key land.
		 *
		 * 🚨 **Purchases are platform charges, not destination charges** (Parker,
		 * 2026-10-15, the multi-creator basket decision): a charge can carry Works by
		 * several creators, and Stripe's `transfer_data.destination` names exactly one
		 * connected account, so the split runs as **one transfer per distinct creator
		 * at completion**, funded by the charge (`source_transaction`). Rows by the same
		 * creator on one charge share this id; a row with no creator to pay (a purchase
		 * Anthers makes itself) and any row whose transfer has not yet succeeded carry
		 * null.
		 *
		 * The null is load-bearing in two directions. **Refunds:** the reversal of the
		 * creator's share is an explicit call on this id, and a row with no transfer was
		 * never paid out — nothing to claw back and, critically, **no netting row**
		 * (`services/netting.ts` recovers a share that reached the creator, and this
		 * share never did). **The retry job:** completed rows with a null here and a
		 * live `creatorId` are the transfer debt the completion webhook left behind,
		 * re-attempted with the same idempotency key, never for rows that refunded or
		 * disputed in the window — a refunded-before-transfer row owes no transfer.
		 */
		stripeTransferId: text("stripe_transfer_id"),
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
		refundedAt: timestamp("refunded_at", { withTimezone: true }), // Who caused the refund, and it is NOT decoration: a platform-initiated
		// refund (a takedown, a defect, a charge the buyer never made) refunds
		// someone who may well have downloaded, and must not consume their cap.
		// Only `buyer` rows are counted. buyer | platform
		refundInitiator: text("refund_initiator"),
		refundReason: text("refund_reason"),
		stripeRefundId: text("stripe_refund_id"),
		// ── What a physical good's order carries (2026-10-26) ────────────────────
		/**
		 * How many of the good this row buys. One for everything else, because a digital
		 * Work is owned once and a service has no count.
		 *
		 * 🚨 **The goods price is `amount`, the count is here, and neither is derived from
		 * the other.** `amount` is what the buyer paid for the goods on this row already
		 * multiplied out, so every existing reader — earnings, refunds, the tax
		 * apportionment — keeps working without knowing a count exists. The count is what
		 * the creator reads when packing, and what a stock release puts back.
		 */
		quantity: integer("quantity").notNull().default(1),
		/**
		 * The option values the buyer chose, as `[{ name, label }]`, snapshotted at sale.
		 *
		 * A snapshot rather than a join to the listing for the same reason `workTitle` is:
		 * a creator who renames a value or drops it next month must not rewrite what
		 * somebody already bought, and the creator packing the parcel needs to know what
		 * came out of the picker at the moment the money moved.
		 */
		options: jsonb("options").$type<Array<{ name: string; label: string }>>(),
		/**
		 * What this row's shipping charge was, already multiplied into
		 * `creatorEarnings` — the creator pays the carrier, so the shipping is theirs to
		 * receive, and the platform only carries it through the charge.
		 *
		 * Zero for everything else, and zero on a good that ships free. Kept apart from
		 * `amount` because the tax remittance record has to show goods and delivery as the
		 * two lines the session charged.
		 */
		shippingAmount: numeric("shipping_amount").notNull().default("0.00"),
		/**
		 * The handling time the Work carried when this order was placed, in business days.
		 * The shipment row snapshots it again at completion (`shipments.handling_business_days`);
		 * this copy is what lets the shipment be opened after the listing changed or went
		 * away, without reading a row nobody owns any more.
		 */
		handlingBusinessDays: integer("handling_business_days"),
		/**
		 * When an abandoned order's reserved stock went back on the shelf. Null until the
		 * sweep or the sale itself settles it — see `releaseAbandonedStock` in
		 * `services/physical-stock.ts`. The stamp is what makes the release idempotent.
		 */
		stockReleasedAt: timestamp("stock_released_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	// resolveAccess treats a completed purchase as a permanent unlock, so (buyer, work)
	// is read on every gated view — and neither column was indexed until `0015`.
	(table) => [
		index("idx_purchases_buyer").on(table.buyerId),
		index("idx_purchases_work").on(table.workId),
		// creator_id arrives already indexed: earnings and refund sums read by it, and
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
// org — what Anthers owes the reader's own space after a purchase or a refund: the row is
// the worklist, and the space holds the signed record.
//
// ⭐ **The row is an issuance log, not a second entitlement.** `purchases` stays the live
// entitlement; this table answers only "was the receipt record written into the reader's
// space, and if not why". That is what lets the write be a background job rather than
// something the payment webhook blocks on: a completion inserts a `pending` row inside the
// same request that flips the purchase, and a sweep drains it a minute later. A row whose
// attempts run out stays `failed` with the server's message, so a receipt that never landed
// is visible rather than absent.
//
// ⚠️ **A receipt is immutable, so `written` is terminal.** The job reads the record back
// before writing; a valid record at the key means there is nothing to do. Reissuing after a
// PDS loss is an operator action that resets the row to `pending`, never an automatic
// overwrite of a record that already verifies.
//
// `kind` is `purchase` or `refund`: a refund is a second signed record that references the
// first, never an edit to it.
export const accessReceipts = pgTable(
	"access_receipts",
	{
		id: serial("id").primaryKey(),
		purchaseId: integer("purchase_id")
			.notNull()
			.references(() => purchases.id, { onDelete: "cascade" }),
		/** `purchase` or `refund`. */
		kind: text("kind").notNull(),
		/** The record key the signed statement lands under, stable across reissues. */
		receiptId: text("receipt_id").notNull(),
		/**
		 * `pending` → `written`, or `failed` once the attempts run out. `skipped` is a
		 * normal resting state: the reader has no hosted identity to write with, so the
		 * row waits for a reissue rather than consuming retries.
		 */
		state: text("state").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		/** Where it landed, once it has. */
		spaceUri: text("space_uri"),
		lastError: text("last_error"),
		writtenAt: timestamp("written_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One purchase receipt and one refund record per purchase; a redelivered webhook
		// inserts nothing.
		uniqueIndex("uq_access_receipts_purchase_kind").on(table.purchaseId, table.kind),
		// The sweep's query: whatever is still owed, oldest first.
		index("idx_access_receipts_state").on(table.state),
	],
);

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
 * org — the signed-in buyer's basket, one row per (user, item). A **scratchpad, not a
 * record** — nothing here is money and nothing is an entitlement — but it is the buyer's,
 * not the browser's (Parker, 2026-10-03): the basket is scoped to the account, so a second
 * account signing in on the same machine starts empty. It moved out of client-side
 * `localStorage` for exactly that reason, and the anonymous scratch basket that still lives
 * in the browser MERGES into this table at sign-in and is then cleared — once a session has
 * an account, this table is the only basket it reads.
 *
 * 🚨 **Never trusted.** The rows are ids, not facts: every id is re-resolved server-side
 * through `resolveBasket` at quote and checkout (price, release state, ownership, the
 * item cap — all the refusals that fired on the client-supplied list still fire on these
 * rows), and `list` returns only what still resolves — so an item that stopped being
 * buyable between add and checkout counts on no badge and charges in no checkout. A
 * tampered table buys nothing it shouldn't.
 *
 * ⚠️ **The rows do not self-clean.** An item that stops being buyable leaves its row here
 * until the buyer removes it or the basket clears at a completed checkout. That is
 * deliberate: resolution is what the reads are for, and a sweeper job is one more thing
 * that can disagree with them.
 *
 * 🚨 **The basket carries any number of creators** (Parker, 2026-10-15): `add` appends a
 * second creator's Work rather than replacing the rows — the replace-on-clash rule this
 * table used to document existed because a Stripe destination charge names exactly one
 * connected account, and the platform-charge split (`services/purchase-split.ts`) is
 * what removed it. See `resolveBasket` in `routes/payments.ts`.
 *
 * **Since the same day, a second item kind: a Badge's first Month** (the creator-page
 * purchase, Parker 2026-10-14/15). A line names a Work or a Badge rung, never both
 * (`basket_items_exactly_one_kind`); a second rung from one issuer replaces the first, the
 * one-holding-per-issuer rule's basket shape. Money columns live none here all the same:
 * a Badge line's price, its fee share and its settlement are `badge_charges`' business.
 *
 * Cascade on every side, like `library_items`: a basket is a preference, not a record —
 * it dies with the account, the Work, and the Badge, and never outlives any of them.
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
		//
		// Nullable since the basket grew a second item kind (the Badge purchase, 2026-10-15):
		// exactly one of `work_id`/`badge_id` is set on any row, the check below holds it.
		workId: integer("work_id").references(() => works.id, { onDelete: "cascade" }),
		// A Badge's first Month — the rung the buyer picked. Cascade for the same reason
		// as `work_id`: a basket entry is scratch, and a rung its creator deleted was
		// never bought. The money's record lives in `badge_charges`, not here.
		badgeId: integer("badge_id").references(() => badges.id, { onDelete: "cascade" }),
		// Insertion order is the basket's display order — the client's old array order —
		// and no column reorders it: newest item at the end, like a physical basket.
		addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
		/**
		 * How many of a physical good this line means to buy. Absent for everything else —
		 * a digital Work is owned once, and a Badge rung is one holding — so the column
		 * defaults to one and the resolution refuses a count on a kind that cannot carry
		 * one. Quantity lives on the LINE, not on the Work: two buyers wanting different
		 * counts is the ordinary case, and the listing says what may be bought, never how
		 * much of it.
		 */
		quantity: integer("quantity").notNull().default(1),
		/**
		 * The option values the buyer chose, as `[{ name, label }]` — the listing's names
		 * against the buyer's labels. Stored as the buyer's intent and re-validated
		 * against the listing at quote and checkout, exactly like every other field here:
		 * a price change or a sold-out value is caught at the door, not trusted from the
		 * row.
		 */
		options: jsonb("options").$type<Array<{ name: string; label: string }>>(),
	},
	(table) => [
		// Exactly one item kind per row — a basket line names a Work or a Badge, never
		// both and never neither. A CHECK, because the service cannot defend a shape the
		// table itself tolerates (the sign-in merge and the buy-now clear both write).
		check(
			"basket_items_exactly_one_kind",
			sql`(${table.workId} IS NOT NULL) <> (${table.badgeId} IS NOT NULL)`,
		),
		// An item sits in an account's basket once. Both uniques are PARTIAL (the plain
		// forms would let two NULLs collide the wrong way): a given Work may appear once,
		// and a given Badge rung once — adding a different rung from the same issuer is
		// the service-level replacement (the pick replaces, one holding per issuer).
		uniqueIndex("uq_basket_items_user_work")
			.on(table.userId, table.workId)
			.where(sql`${table.workId} IS NOT NULL`),
		uniqueIndex("uq_basket_items_user_badge")
			.on(table.userId, table.badgeId)
			.where(sql`${table.badgeId} IS NOT NULL`),
		// The cascades' read side: deleting a Work or a Badge finds its basket rows here.
		// The user list is covered by the uniques' leading column.
		index("idx_basket_items_work").on(table.workId),
		index("idx_basket_items_badge").on(table.badgeId),
	],
);

/**
 * org — a Badge first transaction's money record: the checkout's Badge line, from the
 * moment the charge exists to the moment the cycle settles it. The purchase of a Badge is
 * the raise's charge half (Parker, 2026-10-14: **a Badge is a purchase like any other** —
 * it is the monthly recurring subscription, but it starts with a first transaction, and
 * that first transaction is batchable with anything else in the basket) — so this table is
 * the payments-side sibling of `purchases`, kept SEPARATE from it deliberately:
 *
 * 🚨 **A Badge line never transfers at completion.** Purchase money moves out per creator
 * on the charge's completion (`splitChargeToCreators`); a Badge's money is SUPPORT, and it
 * settles through the cycle distribution, like every other month of directed support — the
 * holding the completion writes is one input, and `settle-cycle` feeds the charges into
 * `computeMonth` as their own `MonthCharge` entries. One table per money rail is what keeps
 * `purchases`' status/transfer/refund predicates from ever seeing a row they cannot settle.
 *
 * Money columns and FKs follow the `purchases` pattern: everything set null, a payment
 * record outlives the account, the rung and the issuer alike.
 */
// org — money. The buyer's charge record for a Badge's first Month; org-only by the
// treasury rule (it carries the settlement a creator's payout is worked off).
export const badgeCharges = pgTable(
	"badge_charges",
	{
		id: serial("id").primaryKey(),
		// SET NULL, not cascade — the reasoning at `purchases.buyerId` is verbatim this
		// row's: Anthers is the merchant of record and must be able to evidence what it
		// collected, which it cannot do from a row no longer there.
		buyerId: integer("buyer_id").references(() => users.id, { onDelete: "set null" }),
		// SET NULL + the snapshot columns: like `purchases.work_id` at `0016`, a charge
		// record outlives the rung its creator later deleted or re-priced.
		badgeId: integer("badge_id").references(() => badges.id, { onDelete: "set null" }),
		// The issuer the support is directed at, denormalized onto the row — it must
		// survive the rung's deletion (`purchases.creatorId`'s reasoning: reachable only
		// through the join once meant a deleted rung erased the payee's identity from the
		// row). The Anthers issuer's own line names the Anthers creator account exactly
		// like any other issuer's — one vocabulary, every destination a user id.
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// A snapshot of what was bought, as it was at the time of sale, for the same
		// reason a purchase row copies the Work's title: the receipt records the
		// transaction, not the catalog's later state.
		badgeLabel: text("badge_label"),
		// 🚨 **GROSS — the rung's monthly price.** The threshold the recurrence bills and
		// the holding is held at, never the first transaction's price alone.
		threshold: numeric("threshold").notNull(),
		// The first transaction's price: the full threshold for an issuer the buyer does
		// not back, the DELTA (threshold minus what they already give this issuer) for an
		// upgrade — the same split `planItemChange.started` records. This is what the
		// charge carried, and what settlement credits to the issuer through
		// `computeMonth`'s per-charge netting.
		chargedAmount: numeric("charged_amount").notNull(),
		// The line's PINNED share of the charge's card fee — apportioned pro-rata at
		// checkout over every line of the charge (Works and Badges alike, the last line
		// absorbing the rounding remainder), because the flat $0.30 is per charge. The
		// cycle's settlement credits the issuer this figure's complement of the
		// charged amount; the row is the record, never a recomputation.
		processingFee: numeric("processing_fee").notNull(),
		// Sales tax is the ONE thing added on top, and per-line tax share exists for the
		// same remittance reason `purchases.salesTax` exists: the charge's collected tax
		// must reconcile line by line, Badge lines included. Zero at checkout, stamped at
		// completion from the session once the buyer's address resolved it.
		salesTax: numeric("sales_tax").notNull().default("0.00"),
		// The calendar cycle the first Month covers — the current cycle at checkout. The
		// holding this charge writes is this cycle's, and settlement reads the row
		// against it.
		billingCycle: text("billing_cycle").notNull(),
		// The session that carried the charge, re-keyed to its PaymentIntent at
		// completion — the same shape the purchase rows use, for the same reason (the
		// session id does not exist when the intent's metadata is written).
		stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
		// pending → completed on the same latch the purchase rows use: only pending rows
		// move at completion, so a redelivered webhook event is a no-op.
		status: text("status").notNull().default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_badge_charges_buyer").on(table.buyerId),
		index("idx_badge_charges_cycle").on(table.billingCycle),
		index("idx_badge_charges_intent").on(table.stripePaymentIntentId),
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
