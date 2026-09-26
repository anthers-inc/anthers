// SPDX-License-Identifier: Apache-2.0
/**
 * Whether a creator can be paid — the one place that question is answered.
 *
 * 🚨 **This became an ENFORCEMENT gate on 2026-08-28, and it was four separate copies of
 * one predicate before that.** `routes/payments.ts` asked it twice to decide whether to
 * take money, and `routes/content.ts` asked it twice to decide whether a buyer sees a live
 * checkout — each spelling out `onboardingComplete && payoutsEnabled` inline. Four readers
 * of one fact is how two of them quietly come to disagree, which this repo has now paid
 * for twice (a cookie-only `getOptionalUserId` beside a bearer-reading `requireAuth`, and
 * a private cookie-only copy in `routes/subscriptions.ts`). Releasing a Work is a fifth
 * caller and the strictest one, so the predicate moved here rather than being written out
 * a fifth time.
 *
 * **Both flags are required, and neither implies the other.** `onboardingComplete` says
 * Stripe finished collecting what it needed; `payoutsEnabled` says Stripe is willing to
 * send money. An account can finish onboarding and still be held — under review, missing a
 * document, in a restricted country — and paying such a creator would be booking an
 * obligation we cannot settle.
 *
 * **Why release is gated on it** (Parker, 2026-08-28), because it is not obvious and the
 * code said the opposite until then:
 *
 *   1. **It is what makes every creator on Anthers an adult.** Stripe runs identity
 *      verification and will not verify a minor. Anthers deliberately collects no date of
 *      birth and no ID of its own (the wiki's *Content Standards*; `/parents`), so this is the *only*
 *      structural check standing behind that claim — and while free publishing skipped it,
 *      Anthers could not make the claim at all.
 *   2. **It means no Work on Anthers is payout-ineligible.** Ungated work earns from the
 *      Time Pool by the time people spend with it, so a released Work with no way to be
 *      paid accrues a debt to somebody we cannot pay. There is no such thing here as work
 *      that only costs money.
 *
 * ⚠️ **The cost of this is real and was the reason it was not done sooner:** hosted Connect
 * onboarding only offers the countries Stripe supports for a platform like ours (~46 as of
 * 2026-09, a Dashboard-configured list rather than a constant — and not the "roughly 34" this
 * comment used to claim), so requiring it to publish shuts out creators in most of the world,
 * not merely creators who do not want money. That trade is now made deliberately rather than
 * by omission, and it is written down where a reader meets it — the Creator Terms, `/parents`,
 * the FAQ, and the release refusal below.
 */

import { db } from "@anthers/db/client";
import { creatorCredits, moderationActions, stripeAccounts, users } from "@anthers/db/schema";
import { PAYOUT_REVIEW_WINDOW_DAYS } from "@anthers/shared/constants";
import { MODERATION_NOTE_MAX, type ModerationActionType } from "@anthers/shared/moderation";
import Decimal from "decimal.js";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

/** A creator's payout standing, and enough of it to say what is missing. */
export interface PayoutStanding {
	/** Stripe has finished onboarding AND will send money. The only value callers gate on. */
	ready: boolean;
	/** A connected account exists at all — the difference between "not started" and "held". */
	connected: boolean;
}

/**
 * Nobody has connected an account.
 *
 * Exported because callers meet this case without a lookup — a Work whose `creatorId` is
 * null has nobody to pay, which is the same answer arrived at without asking Stripe.
 */
export const NO_PAYOUT_ACCOUNT: PayoutStanding = { ready: false, connected: false };

/**
 * Can this creator be paid?
 *
 * The columns are nullable `boolean`s defaulting to false, so both are coerced rather than
 * trusted — a `null` here means "Stripe has not told us yes", which is a no.
 */
export async function payoutStanding(userId: number): Promise<PayoutStanding> {
	const [row] = await db
		.select({
			payoutsEnabled: stripeAccounts.payoutsEnabled,
			onboardingComplete: stripeAccounts.onboardingComplete,
		})
		.from(stripeAccounts)
		.where(eq(stripeAccounts.userId, userId))
		.limit(1);

	if (!row) return NO_PAYOUT_ACCOUNT;
	return {
		ready: row.onboardingComplete === true && row.payoutsEnabled === true,
		connected: true,
	};
}

/** The short form, for callers that only need the verdict. */
export async function canBePaid(userId: number): Promise<boolean> {
	return (await payoutStanding(userId)).ready;
}

// ── The suspension payout hold ───────────────────────────────────────────────

/**
 * Money a suspended creator is owed does not move while the suspension stands —
 * and NOTHING here decides that it ever stops being owed.
 *
 * The hold is **investigative, never punitive** (Parker, 2026-09-22; the
 * anti-corruption principle in *Suspend an account as a moderation action*): it
 * exists to answer one question — was any of the suspended balance earned BY the
 * terms violation itself, or is it spoken for by a refund or dispute — and a "no"
 * is the answer that pays out. There is deliberately no branch in this module
 * that keeps the money: an operator's finding names what was *tainted* and that
 * figure is the review's conclusion, and a "termination forfeits payouts" path
 * would be a policy violation rather than a feature. 🚨 **Never create a ledger
 * line where withheld money accrues to Anthers** — a platform that keeps what it
 * suspends has priced every suspension.
 *
 * **The window concludes itself.** The review is open for
 * `PAYOUT_REVIEW_WINDOW_DAYS` from the suspension; a lapsed window with no finding
 * releases the hold automatically — `releaseStalePayoutHolds` is a sweep, not an
 * operator action, and "absence of a finding by the deadline" is itself the
 * default outcome. The stamp on the row is `users.payout_review_resolved_at`,
 * set by `releasePayoutHold` however the review ended, so the held amount and the
 * review's standing are a plain read for the admin Accounts view.
 *
 * 🚨 **Not gated by a legal hold.** `services/legal-hold.ts` constrains automated
 * DESTRUCTION — a hold suspends deletion of what it names so evidence survives a
 * sweep. A payout is money the other way; preserving an account's records has
 * nothing to say about whether its holder is paid, and a preservation order that
 * could stop payment would be a forfeiture mechanism wearing a preservation hat.
 * The two paths meet nowhere.
 *
 * 🚨 **Never in the way of reinstatement.** A hold rides the suspension; it must
 * never extend one, so neither `unsuspendAccount` nor the expiry sweep reads or
 * blocks on a hold's state, and a reinstatement with the review still open keeps
 * the stamp pending rather than clearing it — the window runs from the suspension
 * and a reinstatement is not a finding.
 */

/** What the admin Accounts view reads for one creator's payout standing under review. */
export interface SuspensionPayoutReview {
	/** What settlement has credited the creator, in dollars — the suspended balance. */
	heldAmount: string;
	/** Null while the review stands open; stamped when it concluded, however it concluded. */
	resolvedAt: Date | null;
	/** The moment the window lapses and the automatic release fires, while the review stands open. */
	releasesAt: Date | null;
}

/**
 * The review standing of a suspended creator's payout hold — for the admin
 * Accounts view. Returns null for an account that is not suspended or has no
 * review in play; the balance is read whether or not the review has concluded.
 */
export async function suspensionPayoutReview(
	userId: number,
): Promise<SuspensionPayoutReview | null> {
	const [row] = await db
		.select({
			suspendedAt: users.suspendedAt,
			resolvedAt: users.payoutReviewResolvedAt,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row?.suspendedAt) return null;

	const [owed] = await db
		.select({ total: sql<string>`COALESCE(SUM(${creatorCredits.amount}), 0)` })
		.from(creatorCredits)
		.where(eq(creatorCredits.creatorId, userId));

	return {
		heldAmount: new Decimal(owed?.total ?? 0).toFixed(2),
		resolvedAt: row.resolvedAt,
		releasesAt: row.resolvedAt
			? null
			: new Date(row.suspendedAt.getTime() + PAYOUT_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000),
	};
}

/**
 * Conclude a suspension's payout review — an operator's finding with the tainted
 * amount named, an operator's clear, or the lapsed window reaching it. Stamps the
 * row; the hold is the *un-stamped* state, so this is the single write that ends
 * it. Returns false where there was no open hold to resolve (a reinstatement
 * ahead of the window, a double run of the sweep) rather than throwing, because
 * the sweep's "release" and an operator's "clear" are the same write and a race
 * between them is the ordinary case.
 *
 * `taintedAmount` is what a finding names as earned by the violation itself, in
 * dollars. The finding is recorded as a `payout_review` row in `moderation_actions`
 * — the same append-only log every other moderation decision lands in, so an
 * appeal reads one sequence — and this module never moves money: it ends the hold
 * and writes the reasoning.
 */
export async function releasePayoutHold(input: {
	userId: number;
	/** The operator who concluded the review, or null for the lapsed-window sweep. */
	adminId?: number | null;
	/** What a finding found tainted, in dollars; omitted on a clear. */
	taintedAmount?: string;
	/** The operator's own note on the conclusion, on a finding and a clear alike. */
	note?: string;
}): Promise<boolean> {
	const rows = await db
		.update(users)
		.set({ payoutReviewResolvedAt: new Date() })
		.where(
			and(
				eq(users.id, input.userId),
				isNotNull(users.suspendedAt),
				isNull(users.payoutReviewResolvedAt),
			),
		)
		.returning({ id: users.id });
	if (rows.length === 0) return false;

	// The reasoning, appended rather than edited, exactly like every other decision in the
	// log. A finding names its tainted amount; a clear says the hold released everything;
	// the lapsed-window sweep names itself as the release with no operator behind it.
	const tainted = input.taintedAmount != null ? new Decimal(input.taintedAmount).toFixed(2) : null;
	const noteParts = [
		tainted != null
			? `Finding: ${tainted} of the held balance was earned by the violation itself.`
			: input.adminId == null
				? "The review window lapsed with no finding recorded, so the held amount released automatically."
				: "Review concluded with no tainted-earnings finding, so the held amount pays out in full.",
		(input.note ?? "").trim(),
	];
	await db.insert(moderationActions).values({
		subjectType: "user",
		subjectId: input.userId,
		action: "payout_review" satisfies ModerationActionType,
		adminActorId: input.adminId ?? null,
		actorRole: "operator",
		reason: "",
		note: noteParts.filter(Boolean).join(" — ").slice(0, MODERATION_NOTE_MAX),
	});
	return true;
}

/**
 * Release every suspension payout hold whose review window has lapsed with no
 * finding recorded. The sweep's job; returns how many released.
 *
 * The predicate is *suspended, review open, suspension older than the window* —
 * the deadline is derived from `suspended_at` rather than stored, so a window
 * that moves moves for every open hold at once rather than for the ones written
 * after the move.
 */
export async function releaseStalePayoutHolds(now: Date = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - PAYOUT_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
	const stale = await db
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				isNotNull(users.suspendedAt),
				isNull(users.payoutReviewResolvedAt),
				lt(users.suspendedAt, cutoff),
			),
		);

	let released = 0;
	for (const row of stale) {
		if (await releasePayoutHold({ userId: row.id })) released += 1;
	}
	if (released > 0) console.log(`payouts: released ${released} lapsed payout hold(s)`);
	return released;
}

/**
 * The word a refusal uses for what was refused. A Work is *released*; a post or a project is
 * *published*. Nothing else differs between them.
 */
export type PublishAct = "release" | "publish";

/**
 * What to tell a creator whose release was refused.
 *
 * Two messages rather than one, because the two states need different actions from
 * different people: nobody has started, or Stripe is holding an account that exists. A
 * single "set up payouts" would send somebody already waiting on Stripe back to a form
 * they have already filled in.
 *
 * ⚠️ **The first one names a place, so the place has to be real.** It said *"Open Payouts in
 * the Studio"* until 2026-08-29, and the Studio has no Payouts — the section is Payouts under
 * Studio settings, which is also where Connect's own return leg now lands. A sentence sending
 * somebody somewhere is a route reference that no test can follow, exactly like the
 * `return_url` this was wrong alongside, so it is worth re-reading whenever either moves.
 */
export function payoutRefusalMessage(
	standing: PayoutStanding,
	act: PublishAct = "release",
): string {
	return standing.connected
		? `Your payout setup isn't finished — Stripe still needs something from you. Open Payouts under Studio settings to see what, and you'll be able to ${act} once it clears.`
		: act === "release"
			? "Set up payouts before releasing your first Work. It's how you get paid, and it takes a few minutes — Anthers takes no cut, so it all comes to you. One limit worth knowing: Stripe's setup reaches only the countries Stripe supports for a platform like ours, so if yours is not among them it can't be completed yet."
			: "Set up payouts before publishing. It's how you get paid, and it takes a few minutes — Anthers takes no cut, so it all comes to you. One limit worth knowing: Stripe's setup reaches only the countries Stripe supports for a platform like ours, so if yours is not among them it can't be completed yet.";
}
