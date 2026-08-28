// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Adult access — the only writer of an account's opt-in and its adulthood verification.
 *
 * Follows the one-writer pattern `services/content-rating.ts`, `services/moderation.ts` and
 * `services/quarantine.ts` establish. Two doors reach this state — a person turning the
 * setting on, and a person turning it off — and both come through here, so an account cannot
 * end up opted in to something it was never verified for.
 *
 * Wiki 40.09 § The funding type is the age signal owns the reasoning. The headline, because
 * it is the part most easily got wrong: **a payment proves nothing about age and the copy may
 * never describe it as an age check.** Debit and prepaid cards have no age floor at all —
 * teen debit programs, family cash accounts and Cash App from 13 all clear an undifferentiated
 * paywall — so a paywall on its own is friction and nothing more. What carries an age signal
 * is the funding *type*: card issuers require the primary accountholder to be 18, so a
 * credit-funded card is evidence of adulthood in a way that any payment is not. Ofcom draws
 * exactly this line, listing credit card checks among methods capable of being highly
 * effective while excluding *"online payments that do not require a person to be 18"*.
 *
 * 🚨 **What is kept is a boolean, a timestamp and a method name.** No date of birth crosses
 * our boundary on this path, and nothing about the card is stored — not the brand, not the
 * last four, not the funding value we just read. There is no verification database. That is
 * what makes the non-retention requirement state law imposes on verifiers satisfied by
 * construction rather than by policy.
 *
 * ⚠️ **Never add a biometric method.** Illinois BIPA, Texas CUBI and Washington's MHMDA all
 * penalize the collection rather than the purpose, and BIPA carries a private right of
 * action, so facial age estimation is out on legal grounds rather than on taste.
 *
 * 🚨 **There is ONE method and no fallback.** An ID-based alternate for adults who can only
 * fund by debit is worth exploring if and only if that turns out to be a real problem for
 * real users (Parker, 2026-08-27) — so this ships, we see whether anybody is actually shut
 * out, and only then is it raised. Do not build a fallback nobody has asked for, and do not
 * write one into user-facing copy as coming. **ID verification of any kind is never required
 * to use Anthers**, which wiki 62.03 carries as a hard rule.
 */

import { db } from "@anthers/db/client";
import { accounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { getStripe } from "../lib/stripe.js";

/** The only method there is. Stored rather than assumed, so a second one could not make the existing rows ambiguous. */
export const CARD_FUNDING_METHOD = "card_funding";

/**
 * What an account may currently do with Adult work.
 *
 * `canReach` is the predicate everything else asks for, and it is deliberately the AND of
 * both facts rather than either one. Wiki 40.09: reaching the rung requires the account-level
 * opt-in *and* a verification. Somebody who verified and later turned the setting off has
 * said they do not want to be shown this, and their old verification does not overrule that.
 */
export interface AdultAccess {
	optIn: boolean;
	verifiedAt: Date | null;
	method: string | null;
	canReach: boolean;
}

/** The account's state, or the closed-by-default answer for a signed-out visitor. */
export const NO_ADULT_ACCESS: AdultAccess = {
	optIn: false,
	verifiedAt: null,
	method: null,
	canReach: false,
};

export async function adultAccessFor(userId: number | null): Promise<AdultAccess> {
	// 🚨 A signed-out visitor has no account and therefore no setting for the opt-in to
	// consult, which is exactly why Adult work is invisible to them entirely rather than
	// merely locked. Answering `NO_ADULT_ACCESS` here rather than branching at every call
	// site is what makes that the default everywhere instead of something to remember.
	if (userId == null) return NO_ADULT_ACCESS;

	const [row] = await db
		.select({
			optIn: accounts.adultOptIn,
			verifiedAt: accounts.adultVerifiedAt,
			method: accounts.adultVerifiedMethod,
		})
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);
	if (!row) return NO_ADULT_ACCESS;

	return {
		optIn: row.optIn,
		verifiedAt: row.verifiedAt,
		method: row.method,
		canReach: row.optIn && row.verifiedAt != null,
	};
}

/**
 * Why enabling Adult access could not go through. Each is something a person can be told
 * plainly, and each has a different remedy — which is the whole reason they are separate
 * values rather than one failure.
 */
export type AdultEnableRefusal =
	/** Stripe is not configured on this deployment. Nothing the person did. */
	| "unavailable"
	/** No card has ever been attached to this account, so there is nothing to read. */
	| "no_card"
	/** A card is on file and it is not credit-funded. This is the honest, unmitigated exclusion. */
	| "funding_not_credit";

/**
 * Read the funding type of the card on file, and record adulthood if it is credit.
 *
 * 🚨 **Only `credit` passes, and `unknown` is not read generously.** Stripe returns
 * `credit`, `debit`, `prepaid` or `unknown`, and `unknown` is common on international cards.
 * Reading it as a pass would turn the one method that carries an age signal into a method
 * that sometimes does not, which is worse than having no method: it would let us keep
 * describing the gate as effective while it silently was not for a whole population.
 *
 * ⚠️ **The exclusion this ships with is real and nothing routes around it.** An adult whose
 * only card is debit or prepaid cannot reach the rung. That population skews younger,
 * lower-income and unbanked, and the `unknown` case makes part of it geographic. It is the
 * accepted price of refusing to verify everybody, and it is to be said plainly wherever the
 * gate is described rather than gestured past.
 *
 * Verification is once, at enablement, rather than per purchase — so this runs when somebody
 * turns the setting on and never again on the way to a Work.
 */
export async function verifyAdulthoodByCardFunding(
	customerId: string | null,
	now: Date = new Date(),
): Promise<{ verifiedAt: Date; method: string } | AdultEnableRefusal> {
	const stripe = getStripe();
	if (!stripe) return "unavailable";
	if (!customerId) return "no_card";

	const methods = await stripe.paymentMethods.list({
		customer: customerId,
		type: "card",
		limit: 10,
	});
	const cards = methods.data.filter((pm) => pm.card);
	if (cards.length === 0) return "no_card";

	// 🚨 Any credit-funded card on the account passes, and this reads every card rather than
	// the most recent one. The question is whether this accountholder holds a credit line
	// at all, and holding one is not undone by also having a debit card — checking only the
	// newest would make the answer depend on the order somebody happened to add them.
	const hasCredit = cards.some((pm) => pm.card?.funding === "credit");
	if (!hasCredit) return "funding_not_credit";

	// Nothing about the card is written. The verdict, the moment, and the method — see the
	// module note on why that list has no fourth entry.
	return { verifiedAt: now, method: CARD_FUNDING_METHOD };
}

/**
 * Turn Adult access on for an account: opt in, and verify, in one act.
 *
 * The two are set together because they are one decision from the person's side, and
 * splitting them into two requests would let an account sit opted-in-but-unverified — a
 * state that means nothing and that every reader of `canReach` would have to handle.
 *
 * ⚠️ **An already-verified account is not re-verified.** Verification is once, at
 * enablement; somebody turning the setting back on after turning it off is not being asked
 * to prove adulthood a second time, and re-reading their cards would make the gate fail for
 * an adult who has since cancelled the credit card that verified them.
 */
export async function enableAdultAccess(
	userId: number,
	now: Date = new Date(),
): Promise<AdultAccess | AdultEnableRefusal> {
	const [row] = await db
		.select({
			customerId: accounts.stripeCustomerId,
			verifiedAt: accounts.adultVerifiedAt,
			method: accounts.adultVerifiedMethod,
		})
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);
	if (!row) return "no_card";

	let verifiedAt = row.verifiedAt;
	let method = row.method;
	if (verifiedAt == null) {
		const result = await verifyAdulthoodByCardFunding(row.customerId || null, now);
		if (typeof result === "string") return result;
		verifiedAt = result.verifiedAt;
		method = result.method;
	}

	await db
		.update(accounts)
		.set({
			adultOptIn: true,
			adultVerifiedAt: verifiedAt,
			adultVerifiedMethod: method,
			updatedAt: now,
		})
		.where(eq(accounts.userId, userId));

	return { optIn: true, verifiedAt, method, canReach: true };
}

/**
 * Turn Adult access off.
 *
 * 🚨 **The verification is kept and only the opt-in is cleared**, which is the opposite of
 * what a privacy instinct suggests and is the right way round. What is stored is that this
 * account was shown to belong to an adult — a fact that does not expire and that says nothing
 * identifying — and clearing it would make somebody re-prove adulthood every time they
 * changed their mind about what they want to see. The setting is the thing they are changing,
 * so the setting is the thing that changes.
 */
export async function disableAdultAccess(
	userId: number,
	now: Date = new Date(),
): Promise<AdultAccess> {
	await db
		.update(accounts)
		.set({ adultOptIn: false, updatedAt: now })
		.where(eq(accounts.userId, userId));
	const state = await adultAccessFor(userId);
	return state;
}
