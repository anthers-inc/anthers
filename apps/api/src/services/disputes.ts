// SPDX-License-Identifier: Apache-2.0
/**
 * Disputes — the one writer of `disputes` rows, and the record of a chargeback's effect
 * on the buyer's access.
 *
 * A dispute is what a cardholder's bank does when it takes the money back. Anthers never
 * contests one by default (Parker, 2026-09-14): the money is treated as gone from the moment the
 * dispute lands, which is why this module *records* rather than *responds* — nothing automatic
 * here submits evidence, opens a case, or decides to fight. A person can choose to contest an
 * *exceptional* dispute (Parker, 2026-09-15), and `submitDisputeEvidence` below is the one path
 * that choice takes: the admin route's call, through the processor boundary, recorded on the row.
 *
 * Access follows the money (Parker, 2026-10-02): a buyer who keeps the Work while the
 * creator's share is clawed back was given the Work free, so a dispute on a **purchase**
 * ends the buyer's access the same way a refund does — and a won dispute restores it,
 * because the money came back. The mechanism is free (`services/refunds.ts` states the
 * same): `resolveAccess` counts only `purchases.status = 'completed'`, so flipping the
 * status is the whole revocation, and flipping it back is the whole restoration. Monthly
 * support has no "access" to revoke; the invoice path keeps its existing
 * `markInvoiceMoneyReturned` behavior.
 *
 * Invariants this module exists to hold:
 *
 *   • **One writer.** `disputes` rows are written here and nowhere else — the same rule
 *     `refunds.ts` follows. The webhook route stays thin and the admin app reads.
 *   • **Idempotent on Stripe's dispute id.** Stripe redelivers, and a redelivered
 *     `charge.dispute.created` finds the row and changes nothing — the unique constraint
 *     is the mechanism, not a lookup beforehand (the same reasoning as
 *     `recordPaidInvoice`).
 *   • **Access revocation is a STATUS FLIP.** Only `completed` purchases move to
 *     `disputed`, so the flip is its own latch: a purchase that was refunded before the
 *     dispute arrived is left alone, and a redelivered event is a no-op.
 *
 * ⚠️ **Scope — what this module deliberately does NOT do**, so the netting task
 * (*Net a Dispute or Refund after a Transfer*) and the admin app (child 2) know what they
 * inherit:
 *
 *   • **No creator-share reversal here.** A dispute claws the creator's transfer back on
 *     Stripe's side, and reversing or netting that share against held credits is the
 *     netting task's, which reads the dispute rows this module writes. Money-that-came-back
 *     on a *support* charge is `markInvoiceMoneyReturned`'s existing job and stays there.
 *   • **A `disputed` purchase does not consume the buyer's refund cap.** The cap counts
 *     `status = 'refunded'` rows only (`refundsAfterDownloadInWindow`), so a `disputed`
 *     row is invisible to it by construction — and this module never writes the
 *     `refund_initiator`/`refunded_at` columns, so a later refund of the same purchase is
 *     not confused with the dispute.
 *   • **The contest records, and that is all this half does.** `submitDisputeEvidence`
 *     below is the one contest path: it checks the window, submits through the processor
 *     boundary (`lib/processor.ts` — the only module that talks to Stripe), and records
 *     the act on the row. The webhook half stays record-only because it has no choice —
 *     nothing automatic ever contests, and the only caller of the contest path is the
 *     admin route where a person chose to.
 *     The **processor calls it makes are the one exception** to this module's record-only
 *     posture, and they exist only on that person-initiated path.
 */
import { db } from "@anthers/db/client";
import { disputes, invoices, purchases } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { retrieveDispute, updateDisputeEvidence } from "../lib/processor.js";

/** The id half of a Stripe reference, which arrives as either a string or an object. */
function refId(ref: string | { id: string } | null | undefined): string | null {
	if (ref == null) return null;
	return typeof ref === "string" ? ref : ref.id;
}

/**
 * Record a dispute the moment it lands — `charge.dispute.created`.
 *
 * Writes the row (linked to the purchase or invoice the charge belongs to, when it belongs
 * to either), and on the **purchase** path flips the purchase to `disputed`, which is the
 * access revocation. On the **invoice** path the caller keeps its existing
 * `markInvoiceMoneyReturned(intentId, "disputed")` behavior; this function does not touch
 * invoices, so the money-record half stays where it already lived. A charge Anthers has no
 * purchase and no invoice for still writes its row — a dispute on a charge is a record of
 * money that left, whether or not we know what it was for.
 *
 * Idempotent on the Stripe dispute id: a redelivered event finds the row and no-ops
 * (`onConflictDoNothing`), and the purchase flip's `completed` predicate is its own latch.
 */
export async function recordDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
	const intentId = refId(dispute.payment_intent);
	const chargeId = refId(dispute.charge);

	/**
	 * The purchase path. 🚨 **Every** row on the intent, not the first — a basket puts
	 * several purchases on one charge, and a chargeback takes the whole charge, so every
	 * item's access goes. The `completed` predicate is the idempotency latch: a refunded
	 * sibling is left alone, and a redelivered event finds nothing to flip.
	 */
	const purchaseRows = intentId
		? await db.select().from(purchases).where(eq(purchases.stripePaymentIntentId, intentId))
		: [];
	const purchase = purchaseRows[0] ?? null;

	// The invoice path is a lookup only — the caller marks the money returned, because
	// that half already lived there (`markInvoiceMoneyReturned`).
	const invoiceRow = purchase
		? null
		: intentId
			? await db
					.select()
					.from(invoices)
					.where(eq(invoices.stripePaymentIntentId, intentId))
					.limit(1)
					.then((rows) => rows[0] ?? null)
			: null;

	// The buyer, from whichever row the charge belonged to. Null when neither exists —
	// the dispute record still does.
	const userId = purchase?.buyerId ?? invoiceRow?.userId ?? null;

	// Stripe reports cents; the column holds dollars, the same conversion every amount
	// here takes (`dollars` in `services/invoices.ts`).
	const amount = new Decimal(dispute.amount ?? 0).dividedBy(100).toFixed(2);

	// `due_by` is a Unix timestamp. Null once closed and on the statuses that carry no
	// evidence window (`warning_*`, `unchallengeable`), which is exactly when Stripe
	// sends null.
	const dueBy = dispute.evidence_details?.due_by
		? new Date(dispute.evidence_details.due_by * 1000)
		: null;

	// A redelivered created event finds the row already there and changes nothing — the
	// unique constraint is the mechanism, so two concurrent deliveries cannot both insert.
	await db
		.insert(disputes)
		.values({
			stripeDisputeId: dispute.id,
			stripeChargeId: chargeId ?? "",
			stripePaymentIntentId: intentId,
			amount,
			currency: dispute.currency ?? "usd",
			reason: dispute.reason ?? "",
			// Stored verbatim — Stripe's vocabulary, never translated. See the schema note.
			status: dispute.status,
			purchaseId: purchase?.id ?? null,
			invoiceId: invoiceRow?.id ?? null,
			userId,
			evidenceDueBy: dueBy,
		})
		.onConflictDoNothing({ target: disputes.stripeDisputeId });

	if (purchaseRows.length > 0) {
		await db
			.update(purchases)
			.set({ status: "disputed", updatedAt: new Date() })
			.where(
				and(
					eq(purchases.stripePaymentIntentId, intentId as string),
					eq(purchases.status, "completed"),
				),
			);
	}
}

/**
 * Record a dispute's closing — `charge.dispute.closed`, which Stripe sends with
 * `status: "won" | "lost"`.
 *
 * **Won: the money came back, so the purchase is restored to `completed`** — the buyer
 * keeps the Work, and the `disputed` predicate is the flip's own latch, so a redelivered
 * close is a no-op. **Lost: the purchase stays `disputed`** — Anthers never contested, the
 * buyer has their money back and not the Work. Any other status is recorded and nothing
 * else moves: Stripe's close event is `won` or `lost`, but an unexpected value is a
 * Stripe-side change to *read*, not one to guess at.
 */
export async function recordDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
	const outcome = dispute.status === "won" || dispute.status === "lost" ? dispute.status : null;

	// The row may not exist if the created event was never delivered (or predates this
	// table) — the close is then recorded as a row of its own, so the dispute still leaves
	// a trace. Amount and charge are read off the event for that path; when the row
	// exists, only the status columns move.
	const amount = new Decimal(dispute.amount ?? 0).dividedBy(100).toFixed(2);
	await db
		.insert(disputes)
		.values({
			stripeDisputeId: dispute.id,
			stripeChargeId: refId(dispute.charge) ?? "",
			stripePaymentIntentId: refId(dispute.payment_intent),
			amount,
			currency: dispute.currency ?? "usd",
			reason: dispute.reason ?? "",
			status: dispute.status,
			outcome,
		})
		.onConflictDoUpdate({
			target: disputes.stripeDisputeId,
			// A closed dispute has no evidence window left, so the deadline column goes
			// null with the close — the admin deadline list reads it, and a stale date on a
			// closed dispute would tell a person to submit evidence to a bank that already
			// ruled.
			set: { status: dispute.status, outcome, evidenceDueBy: null, updatedAt: new Date() },
		});

	if (outcome !== "won") return;

	// Won: restore the buyer's access. Only `disputed` rows move, so a purchase that was
	// refunded after the dispute is not resurrected by the dispute's closing.
	const intentId = refId(dispute.payment_intent);
	if (!intentId) return;
	await db
		.update(purchases)
		.set({ status: "completed", updatedAt: new Date() })
		.where(and(eq(purchases.stripePaymentIntentId, intentId), eq(purchases.status, "disputed")));
}

/**
 * The plain evidence fields a contest submits — what Anthers can honestly fill from what
 * it holds. Deliberately this short list and not `Stripe.DisputeUpdateParams.Evidence`:
 * the file-upload fields (`receipt`, `customer_communication`, …) need a Stripe file id
 * this path does not create, and the CE3.0 half is Stripe's to autofill (the confirmed
 * 2026-10-02 finding recorded in `lib/processor.ts`). Everything here is a text field the
 * admin app assembles from the dispute's own record.
 */
export interface DisputeContestEvidence {
	/** What was sold — the Work's title and what buying it gave the buyer. */
	product_description: string;
	/** The buyer's email address, as Anthers holds it. */
	customer_email_address?: string;
	/** When the buyer received the purchase, in a clear human-readable format. */
	service_date?: string;
	/** Anything else worth saying to the bank, in the field Stripe leaves open. */
	uncategorized_text?: string;
}

/** Why a contest was refused, for the route to turn into its own words. */
export type DisputeContestRefusal =
	| "not_found"
	| "closed"
	| "past_deadline"
	| "already_contested"
	| "unconfigured";

export class DisputeContestError extends Error {
	constructor(readonly reason: DisputeContestRefusal) {
		super(reason);
		this.name = "DisputeContestError";
	}
}

/**
 * Submit contest evidence to Stripe, and record the act — the one contest path, called
 * only by the admin route.
 *
 * Contested is a person's explicit choice, never the default (Parker, 2026-09-15): the
 * deliberate exception for egregious/suspicious/large disputes, and nothing automatic
 * ever reaches this function. Refusals come back as `DisputeContestError` rather than a
 * boolean, so the route can answer each reason with its own words:
 *
 *   • **closed** — `outcome` set means the bank already ruled; there is nothing to submit.
 *   • **past_deadline** — the evidence window closed; Stripe would refuse it too.
 *   • **already_contested** — Visa's CE3.0 rule is one attempt only, so a second
 *     submission is refused before anything reaches Stripe.
 *   • **unconfigured** — payments are not configured, so there is no processor to submit
 *     through; the row is not marked contested.
 *
 * The record is written only after Stripe accepts the submission: the columns say *this
 * evidence is at the bank*, not *a person intended to send it*, which is why a processor
 * failure leaves the dispute uncontested and the once-guard unlatched. The evidence is
 * stored verbatim in `contested_evidence` — the honest record of what Anthers told the
 * bank, the same way `admin_account_events.detail` records an operator action.
 */
export async function submitDisputeEvidence(input: {
	disputeId: number;
	adminId: number;
	evidence: DisputeContestEvidence;
}): Promise<typeof disputes.$inferSelect> {
	const [row] = await db.select().from(disputes).where(eq(disputes.id, input.disputeId)).limit(1);

	if (!row) throw new DisputeContestError("not_found");
	if (row.outcome !== null) throw new DisputeContestError("closed");
	if (row.contestedAt !== null) throw new DisputeContestError("already_contested");
	if (row.evidenceDueBy === null || row.evidenceDueBy.getTime() <= Date.now()) {
		throw new DisputeContestError("past_deadline");
	}

	// `submit: true` — the evidence goes to the bank, not to the Dashboard's staging area.
	// A staged submission would read as contested while nothing reached the issuer.
	const submitted = await updateDisputeEvidence(row.stripeDisputeId, {
		evidence: input.evidence,
		submit: true,
	});
	if (!submitted) throw new DisputeContestError("unconfigured");

	// The read-back. A submitted dispute moves from `needs_response` to `under_review` on
	// Stripe's side, and the webhook layer records `created` and `closed` only — so without
	// this, the admin list would keep reading `needs_response` for a bank that is already
	// looking at our evidence. The row adopts Stripe's own word, the same verbatim rule
	// every status write here follows.
	const readBack = await retrieveDispute(row.stripeDisputeId);

	// The once-latch is the write's predicate, not a check beforehand: two concurrent
	// submissions both pass the read above, but only the first satisfies
	// `contested_at IS NULL`, and the second changes zero rows. (In practice the once-rule
	// is held by the read for a person double-clicking; the predicate is what holds it
	// against a race.)
	const updated = await db
		.update(disputes)
		.set({
			...(readBack ? { status: readBack.status } : {}),
			contestedByAdminId: input.adminId,
			contestedAt: new Date(),
			contestedEvidence: input.evidence,
			updatedAt: new Date(),
		})
		.where(and(eq(disputes.id, row.id), sql`${disputes.contestedAt} IS NULL`))
		.returning();
	if (updated.length === 0) throw new DisputeContestError("already_contested");
	return updated[0];
}

/**
 * The dispute-activity ratio for a period — disputes ÷ successful payments, both as
 * Anthers recorded them. This is the number the admin threshold alert compares against
 * Stripe's network guidance (0.9% is the commonly cited line); the alert threshold itself
 * is the admin surface's to own.
 *
 * ⚠️ **The denominator is Anthers' own record, and the honest caveat:** Stripe computes its
 * network-wide number on its side, from every charge it processed, counting a dispute by
 * its own date and including activity our tables cannot see (a dispute on a charge
 * `payment_intent.succeeded` never covered, or arriving for a period before this table
 * existed). Ours counts `purchases.status` reaching `completed` plus invoices recorded as
 * paid, over the same window the disputes are counted in. The two can differ slightly in
 * either direction, which is why this is an **early warning, not an audit** — a person who
 * needs Stripe's own figure reads it from Stripe.
 *
 * Returns null when the denominator is zero: no successful payments in the window means
 * there is nothing for a ratio to be *of*, and 0/0 reported as 0% would read as "healthy"
 * rather than "empty".
 */
export async function disputeActivityRatio(
	windowStart: Date,
	windowEnd: Date,
): Promise<Decimal | null> {
	const [disputed] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(disputes)
		.where(
			and(
				gte(disputes.createdAt, windowStart),
				lte(disputes.createdAt, windowEnd),
				// A warning_* entry is Stripe's radar flag, not a dispute that landed; it must
				// not inflate the activity count. `charge.dispute.created` rows carry the
				// regular statuses only, but a close event for a warning carries `warning_closed`,
				// and the row here is the record either way.
				sql`${disputes.status} NOT LIKE 'warning_%'`,
			),
		);

	const [paid] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(purchases)
		.where(
			and(
				gte(purchases.createdAt, windowStart),
				lte(purchases.createdAt, windowEnd),
				// Successful payments only — a charge that never completed is not activity a
				// dispute could land on, and counting it would understate the ratio.
				sql`${purchases.status} IN ('completed', 'refunded', 'disputed')`,
			),
		);
	const [invoiced] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(invoices)
		.where(
			and(
				gte(invoices.paidAt, windowStart),
				lte(invoices.paidAt, windowEnd),
				// An uncollectible renewal was never money in; refunded and disputed ones were,
				// and stay in the denominator — the dispute that came back for one of them is
				// in the numerator, so removing it here would double-count the badness.
				sql`${invoices.status} <> 'uncollectible'`,
			),
		);

	const denominator = (paid?.n ?? 0) + (invoiced?.n ?? 0);
	if (denominator === 0) return null;
	return new Decimal(disputed?.n ?? 0).dividedBy(denominator);
}
