// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's dispute read surface — the list a person evaluates a chargeback
 * against, and the platform's dispute standing.
 *
 * Anthers never contests by default; a person can evaluate and perhaps contest an
 * *exceptional* one (Parker, 2026-09-15). This module is what that person looks
 * at: the row Stripe's webhook wrote (`services/disputes.ts` is the one writer) with
 * the Work, creator and buyer joined on, and the flags that say a dispute deserves
 * attention before any human has looked at it (Parker, 2026-09-14: repeated
 * disputes on one creator's sales, a single large dispute, and any pattern that
 * looks like a creator paying themselves).
 *
 * ⭐ **Flags are computed at read time, never stored.** A flag is an answer to "what
 * deserves attention right now", which changes as rows age out of the window and as
 * new disputes land — a stored flag is a stale one, and the moment a repeat dispute
 * arrives is exactly the moment a stored one would be oldest. No dispute row carries
 * a flag column, and nothing here writes anything.
 *
 * ⚠️ **No contest action lives here, deliberately.** Contesting an exceptional
 * dispute is its own task (*Contest an Exceptional Dispute from the Admin App*); the
 * list's job is to show what a person needs to *decide*, and it leaves the submission
 * to that task.
 *
 * 🚨 **Creator attribution is only clean on the purchase path.** A purchase row
 * carries `creator_id` (denormalized so the seller's identity survives the Work's
 * deletion), but a support-charge dispute names an invoice whose lines may span
 * several creators — and a chargeback takes the whole charge, so which line it was
 * "really" about is not something the tables can say. The repeat and self-pay flags
 * therefore scope to purchase disputes, and the list says so rather than pretending
 * at an attribution it cannot make.
 */
import { db } from "@anthers/db/client";
import { adminAccounts, disputes, invoices, purchases, users } from "@anthers/db/schema";
import {
	cents,
	DISPUTE_LARGE_AMOUNT,
	DISPUTE_VAMP_COUNT,
	DISPUTE_VAMP_RATIO,
	DISPUTE_WINDOW_DAYS,
} from "@anthers/shared/constants";
import type Decimal from "decimal.js";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { disputeActivityRatio } from "./disputes.js";

/** How the dispute's charge was connected to Anthers, as the list labels it. */
export type DisputeKind = "purchase" | "support" | "unlinked";

/** Which line a dispute crossed, in the sense the alert's states are named. */
export type DisputeFlag = "repeat" | "large" | "self-pay";

/** One dispute for the admin list, with everything the evaluation reads joined on. */
export interface DisputeRow {
	id: number;
	stripeDisputeId: string;
	/** Which of purchase, support or unlinked the charge was — the label the row prints. */
	kind: DisputeKind;
	amount: string;
	currency: string;
	reason: string;
	/** Stripe's own status vocabulary, verbatim — never translated (the schema note). */
	status: string;
	/** `won` | `lost` once closed, null while open — our column, not Stripe's. */
	outcome: string | null;
	evidenceDueBy: string | null;
	createdAt: string;
	/** The Work's title snapshot, which survives the Work's deletion by design. */
	workTitle: string | null;
	workSlug: string | null;
	workPublicId: number | null;
	/** `true` when the purchased Work still exists to link to; false once deleted. */
	workExists: boolean;
	creator: { id: number; handle: string; displayName: string } | null;
	buyer: { id: number; handle: string; displayName: string } | null;
	/** The admin account that contested this dispute, when a person did. */
	contestedBy: { id: number; displayName: string } | null;
	/** When that person submitted evidence to Stripe; null when never contested. */
	contestedAt: string | null;
	/**
	 * Which attention lines this dispute crossed, computed at read time — the whole
	 * flag mechanism, and empty for an ordinary dispute.
	 */
	flags: DisputeFlag[];
}

/** The platform's dispute standing for the trailing window, as the admin home panel reads it. */
export interface DisputeStanding {
	/** Dispute rows in the window, excluding `warning_*` (radar, not a dispute that landed). */
	count: number;
	/**
	 * Disputes ÷ successful payments over the window, or **null when the window is
	 * empty** — an account with no charges has no ratio, and null is "nothing to say"
	 * rather than 0%. Never rendered as 0%.
	 */
	ratio: number | null;
	openCount: number;
	/** Which threshold line the standing has crossed, and none below it. */
	state: "quiet" | "approaching" | "early-warning";
}

/**
 * Which side of the two lines a standing sits on.
 *
 * Pure and exported so the tests pin the states rather than the reads: the lines are
 * Visa's VAMP rule (non-compliant at a 0.5% dispute+EFW ratio or a count of 5 in a
 * month — Parker, 2026-10-02), applied as an **early warning** at the full line and an
 * "approaching" state at half of it. Both halves are checked every time, because a
 * small account trips the count before the ratio and a large one the reverse — a
 * state computed from the ratio alone would stay quiet through the count line.
 *
 * `ratio: null` (an empty window) is quiet, NOT 0%: no successful payments means
 * nothing for a ratio to be *of*, and reporting 0/0 as healthy is the exact lie the
 * null return exists to prevent.
 */
export function disputeStandingState(
	count: number,
	ratio: Decimal | number | null,
): DisputeStanding["state"] {
	const asNumber = ratio === null ? null : typeof ratio === "number" ? ratio : ratio.toNumber();
	const crossedCount = count >= DISPUTE_VAMP_COUNT;
	const crossedRatio = asNumber !== null && asNumber >= DISPUTE_VAMP_RATIO;
	if (crossedCount || crossedRatio) return "early-warning";
	const halfCount = count >= DISPUTE_VAMP_COUNT / 2;
	const halfRatio = asNumber !== null && asNumber >= DISPUTE_VAMP_RATIO / 2;
	if (halfCount || halfRatio) return "approaching";
	return "quiet";
}

/**
 * The dispute list, newest first — open and closed together, flagged rows first.
 *
 * The flags are computed per row at read time:
 *
 * - **repeat** — the dispute's creator has 2+ purchase disputes in the trailing window.
 * - **large** — the amount crosses `DISPUTE_LARGE_AMOUNT`, in cents.
 * - **self-pay** — the dispute's buyer is the creator whose Work it is.
 *
 * The last two read the joined creator/buyer of this row; the repeat flag needs a
 * second pass over the window's disputes (one grouped count), so the list is two
 * reads rather than one. Both are reads of rows `services/disputes.ts` wrote — this
 * module never writes.
 */
export async function loadDisputes(now: Date = new Date()): Promise<DisputeRow[]> {
	const windowStart = new Date(now.getTime() - DISPUTE_WINDOW_DAYS * 86_400_000);

	const creator = alias(users, "creator");
	const buyer = alias(users, "buyer");
	const contestedByAdmin = alias(adminAccounts, "contested_by_admin");

	const rows = await db
		.select({
			dispute: disputes,
			purchase: purchases,
			invoice: invoices,
			workTitle: purchases.workTitle,
			workSlug: sql<string | null>`(SELECT slug FROM works WHERE works.id = ${purchases.workId})`,
			workPublicId: purchases.workPublicId,
			workExists: sql<boolean>`EXISTS (SELECT 1 FROM works WHERE works.id = ${purchases.workId})`,
			creatorId: creator.id,
			creatorHandle: creator.atprotoHandle,
			creatorDisplayName: creator.displayName,
			buyerId: buyer.id,
			buyerHandle: buyer.atprotoHandle,
			buyerDisplayName: buyer.displayName,
			contestedByAdminId: contestedByAdmin.id,
			contestedByAdminName: contestedByAdmin.displayName,
		})
		.from(disputes)
		.leftJoin(purchases, eq(disputes.purchaseId, purchases.id))
		.leftJoin(invoices, eq(disputes.invoiceId, invoices.id))
		.leftJoin(creator, eq(purchases.creatorId, creator.id))
		.leftJoin(buyer, eq(disputes.userId, buyer.id))
		.leftJoin(contestedByAdmin, eq(disputes.contestedByAdminId, contestedByAdmin.id))
		.orderBy(sql`${disputes.createdAt} DESC`);

	// The repeat flag's second read: purchase disputes per creator in the window. One
	// grouped count, joined the same way the list is, so the flag and the list can never
	// disagree about who a dispute's creator is.
	const repeats = await db
		.select({ creatorId: purchases.creatorId, n: sql<number>`COUNT(*)::int` })
		.from(disputes)
		.innerJoin(purchases, eq(disputes.purchaseId, purchases.id))
		.where(
			and(
				gte(disputes.createdAt, windowStart),
				// The same exclusions `disputeActivityRatio` makes: a `warning_*` row is
				// radar, not a dispute that landed, and counting it here would flag a
				// creator for an alert Stripe raised rather than a chargeback a buyer made.
				sql`${disputes.status} NOT LIKE 'warning_%'`,
			),
		)
		.groupBy(purchases.creatorId);
	const repeatByCreator = new Map(
		repeats.map((r) => [r.creatorId, r.n] as const).filter(([id]) => id !== null),
	);

	const mapped = rows.map((r) => {
		const kind: DisputeKind = r.purchase ? "purchase" : r.invoice ? "support" : "unlinked";
		const flags: DisputeFlag[] = [];
		if (kind === "purchase" && (repeatByCreator.get(r.purchase!.creatorId) ?? 0) >= 2) {
			flags.push("repeat");
		}
		if (cents(r.dispute.amount) >= cents(DISPUTE_LARGE_AMOUNT)) {
			flags.push("large");
		}
		if (
			kind === "purchase" &&
			r.dispute.userId !== null &&
			r.dispute.userId === r.purchase!.creatorId
		) {
			flags.push("self-pay");
		}
		return {
			id: r.dispute.id,
			stripeDisputeId: r.dispute.stripeDisputeId,
			kind,
			amount: r.dispute.amount,
			currency: r.dispute.currency,
			reason: r.dispute.reason,
			status: r.dispute.status,
			outcome: r.dispute.outcome,
			evidenceDueBy: r.dispute.evidenceDueBy?.toISOString() ?? null,
			createdAt: r.dispute.createdAt.toISOString(),
			workTitle: r.workTitle,
			workSlug: r.workSlug,
			workPublicId: r.workPublicId,
			workExists: r.workExists,
			creator:
				r.creatorId != null
					? {
							id: r.creatorId,
							handle: r.creatorHandle ?? "",
							displayName: r.creatorDisplayName ?? "",
						}
					: null,
			buyer:
				r.buyerId != null
					? {
							id: r.buyerId,
							handle: r.buyerHandle ?? "",
							displayName: r.buyerDisplayName ?? "",
						}
					: null,
			contestedBy:
				r.contestedByAdminId != null
					? { id: r.contestedByAdminId, displayName: r.contestedByAdminName ?? "" }
					: null,
			contestedAt: r.dispute.contestedAt?.toISOString() ?? null,
			flags,
		};
	});

	// Flagged rows first, then newest — the order a person triages in, and the whole
	// extent of what a flag does: a sort position and an emphasis, never a state change.
	return mapped.sort((a, b) => b.flags.length - a.flags.length);
}

/**
 * One dispute, in the list's own shape — the contest route's read-back.
 *
 * The route could return the service's raw row, but the admin app would then meet the
 * same dispute in two shapes on one screen: the list's `DisputeRow` and whatever this
 * returned. Reading back through the list's own join (contested-by and all) keeps one
 * shape, and the call happens after the submission so the row already carries the act.
 *
 * The repeat flag needs the window's other rows to compute, so a single dispute's read is
 * the same two queries the list runs, scoped to one row — the honest cost of not forking
 * the mapping, which is where a second serialization shape would drift from the first.
 */
export async function loadDispute(id: number, now: Date = new Date()): Promise<DisputeRow | null> {
	const rows = await loadDisputes(now);
	return rows.find((r) => r.id === id) ?? null;
}

/**
 * The platform's dispute standing over the trailing window — the admin home panel's data.
 *
 * The ratio is `disputeActivityRatio`'s (child 1's export), with its null preserved: null
 * is "nothing to say", and the panel says there is no ratio rather than rendering 0%. The
 * count is the same window's dispute rows, counted here because the ratio's own read
 * does not expose it — and the count is what a small account trips first, which is why
 * it is a separate line and not a derived figure.
 */
export async function disputeStanding(now: Date = new Date()): Promise<DisputeStanding> {
	const windowStart = new Date(now.getTime() - DISPUTE_WINDOW_DAYS * 86_400_000);

	const ratio = await disputeActivityRatio(windowStart, now);

	const [counted] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(disputes)
		.where(
			and(
				gte(disputes.createdAt, windowStart),
				lte(disputes.createdAt, now),
				sql`${disputes.status} NOT LIKE 'warning_%'`,
			),
		);
	const count = counted?.n ?? 0;

	const [open] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(disputes)
		.where(and(isNull(disputes.outcome), sql`${disputes.status} NOT LIKE 'warning_%'`));

	return {
		count,
		ratio: ratio === null ? null : Number(ratio),
		openCount: open?.n ?? 0,
		state: disputeStandingState(count, ratio),
	};
}
