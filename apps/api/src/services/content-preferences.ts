// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content preferences — the only writer of what a reader has asked to meet: the Adult opt-in,
 * the adulthood verification behind it, and the per-rung display setting for each of them.
 *
 * Follows the one-writer pattern `services/content-rating.ts`, `services/moderation.ts` and
 * `services/quarantine.ts` establish. Every door into this state comes through here, so an
 * account cannot end up opted in to something it was never verified for.
 *
 * 🚨 **Every setting here belongs to the READER and reaches nobody else.** A reader hiding or
 * blurring a rung changes what *they* meet: the Work stays listed for everyone else, stays
 * searchable, stays earning, and is never demoted or paid less. Wiki 40.09 is explicit that
 * this is deliberately not platform-side suppression — the platform picks the default and
 * makes the choice explicit, rather than deciding what anybody sees. The one setting with a
 * consequence beyond its owner is the Adult opt-in, and even that only decides what its own
 * account reaches.
 *
 * ⚠️ **The two rungs get SEPARATE controls, and keeping them separate is the point.** A
 * reader who wants difficult work unblurred has said nothing about whether they want explicit
 * work at all, and one control covering both would make them say it.
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
import { accounts, works } from "@anthers/db/schema";
import {
	DEFAULT_MATURITY_DISPLAY,
	isMaturityDisplay,
	type MaturityDisplay,
} from "@anthers/shared/content-rating";
import { eq, type SQL, sql } from "drizzle-orm";
import { getStripe } from "../lib/stripe.js";

/** The only method there is. Stored rather than assumed, so a second one could not make the existing rows ambiguous. */
export const CARD_FUNDING_METHOD = "card_funding";

/**
 * Everything a reader has said about what they meet, with the defaults already applied.
 *
 * 🚨 **Never hand a caller a null display value.** A signed-out visitor has no row at all and
 * must still get the Mature blur, so the default is resolved here rather than at each call
 * site — a caller that had to remember `?? "blur"` is a caller that will one day forget, and
 * the failure mode is an unblurred cover rather than an error.
 */
export interface ContentPreferences {
	mature: MaturityDisplay;
	adult: MaturityDisplay;
	adultAccess: AdultAccess;
}

function displayOr(stored: string | null, fallback: MaturityDisplay): MaturityDisplay {
	return stored && isMaturityDisplay(stored) ? stored : fallback;
}

/** What this viewer has asked to meet. Defaults all the way down for a signed-out visitor. */
export async function contentPreferencesFor(userId: number | null): Promise<ContentPreferences> {
	const fallback = {
		mature: DEFAULT_MATURITY_DISPLAY.mature,
		adult: DEFAULT_MATURITY_DISPLAY.adult,
		adultAccess: NO_ADULT_ACCESS,
	};
	if (userId == null) return fallback;

	const [row] = await db
		.select({
			optIn: accounts.adultOptIn,
			verifiedAt: accounts.adultVerifiedAt,
			method: accounts.adultVerifiedMethod,
			mature: accounts.matureDisplay,
			adult: accounts.adultDisplay,
		})
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);
	if (!row) return fallback;

	return {
		mature: displayOr(row.mature, DEFAULT_MATURITY_DISPLAY.mature),
		adult: displayOr(row.adult, DEFAULT_MATURITY_DISPLAY.adult),
		adultAccess: {
			optIn: row.optIn,
			verifiedAt: row.verifiedAt,
			method: row.method,
			canReach: row.optIn && row.verifiedAt != null,
		},
	};
}

/** Set a rung's display preference. The only writer of the two display columns. */
export async function setMaturityDisplay(
	userId: number,
	input: { mature?: MaturityDisplay; adult?: MaturityDisplay },
	now: Date = new Date(),
): Promise<ContentPreferences> {
	const updates: Record<string, unknown> = { updatedAt: now };
	if (input.mature) updates.matureDisplay = input.mature;
	if (input.adult) updates.adultDisplay = input.adult;

	// ⚠️ Upserts rather than updates, because **signing up does not create an `accounts`
	// row** — one appears on first payment. A plain UPDATE would silently affect nothing and
	// report success, so a free account's preference would never save and nothing would say
	// so. This is the same trap the verification fixture hit.
	await db
		.insert(accounts)
		.values({ userId, matureDisplay: input.mature ?? null, adultDisplay: input.adult ?? null })
		.onConflictDoUpdate({ target: accounts.userId, set: updates });

	return contentPreferencesFor(userId);
}

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
 * The SQL condition that hides Adult work from a viewer who may not reach it.
 *
 * 🚨 **Adult is INVISIBLE rather than merely inaccessible** — its existence, title and cover
 * art included — so this is a `WHERE` clause on every listing rather than a lock the reader
 * meets on arrival. Wiki 40.09: a signed-out visitor has no account-level setting for the
 * opt-in to consult, so Adult work is invisible to them entirely; and a signed-in account
 * that has not opted in meets the same absence on the non-feed surfaces — creator profiles,
 * Catalog listings, and search (Parker, 2026-08-28, settling 40.09's open question).
 *
 * ⭐ **One rule for everyone without the opt-in, which is what makes it testable as an
 * absence.** The alternative considered was an interstitial saying an Adult Work is here,
 * and it was rejected because the existence — and usually the title — is exactly the thing
 * the rung does not get. The accepted cost is that a creator's profile silently omits work
 * from a reader who has not opted in.
 *
 * ⚠️ **A creator always sees their own**, which is why this takes the viewer's id and the
 * creator column rather than being a bare `maturity <> 'adult'`. Somebody who has not opted
 * in is not asking to be protected from the thing they made, and hiding it from them would
 * take their own Work out of their own Catalog.
 *
 * Returns `undefined` when nothing needs hiding, so it composes into `and(...)` exactly as
 * `notBlockedBy` does — Drizzle drops the undefined rather than needing a branch at the call
 * site.
 */
export function adultHiddenFrom(
	access: AdultAccess,
	viewerId: number | null,
	creatorColumn: SQL | unknown = works.creatorId,
	maturityColumn: SQL | unknown = works.maturity,
): SQL | undefined {
	if (access.canReach) return undefined;
	if (viewerId == null) return sql`${maturityColumn} <> 'adult'`;
	return sql`(${maturityColumn} <> 'adult' OR ${creatorColumn} = ${viewerId})`;
}

/**
 * Every rung this viewer has asked to keep out of listings, as one condition.
 *
 * Two different reasons produce the same absence and they are not the same rule. A rung is
 * absent because the viewer **may not reach it** (the Adult opt-in and verification, which is
 * the platform's rule) or because the viewer **asked for it to be hidden** (their own
 * `hide` preference, which is theirs). Both end in a row missing from a listing, so both are
 * expressed here — but only the first is enforcement, and `resolveAccessSync` implements that
 * one independently. **A `hide` preference is never an access rule**: the Work stays reachable
 * by a direct link, which is exactly what separates hiding from opting out.
 *
 * ⭐ **`blur` produces no condition at all**, because a blurred Work is listed. The blur is
 * the client's job, from the `maturity` value that already travels with every Work.
 */
export function maturityHiddenFrom(
	prefs: ContentPreferences,
	viewerId: number | null,
	creatorColumn: SQL | unknown = works.creatorId,
	maturityColumn: SQL | unknown = works.maturity,
): SQL | undefined {
	const hiddenRungs: string[] = [];
	if (!prefs.adultAccess.canReach || prefs.adult === "hide") hiddenRungs.push("adult");
	if (prefs.mature === "hide") hiddenRungs.push("mature");
	if (hiddenRungs.length === 0) return undefined;

	const list = sql.join(
		hiddenRungs.map((rung) => sql`${rung}`),
		sql`, `,
	);
	// 🚨 A creator always sees their own, whatever they have asked to be shown. Somebody who
	// hid a rung is filtering what they browse, not deleting their own Catalog — and a reader
	// with no opt-in is not asking to be protected from the thing they made.
	if (viewerId == null) return sql`${maturityColumn} NOT IN (${list})`;
	return sql`(${maturityColumn} NOT IN (${list}) OR ${creatorColumn} = ${viewerId})`;
}

/** Load the viewer's preferences and the listing condition that follows, in one step. */
export async function adultVisibility(viewerId: number | null): Promise<{
	access: AdultAccess;
	prefs: ContentPreferences;
	hidden: SQL | undefined;
}> {
	const prefs = await contentPreferencesFor(viewerId);
	return {
		access: prefs.adultAccess,
		prefs,
		hidden: maturityHiddenFrom(prefs, viewerId),
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

	// ⭐ **Opting in sets the display preference, if the reader has never set one.** The
	// stored default is `hide`, and leaving it there would mean somebody who just cleared a
	// card verification to reach the rung then saw nothing at all — a second gate they never
	// asked for, immediately after passing the first.
	//
	// The `hide` default is not being overridden, because it was never load-bearing: while an
	// account has not opted in, `canReach` is false and Adult work is hidden by the access
	// rule whatever this column says. The preference becomes operative at exactly this
	// moment, and at this moment the person has just said they want it. `blur` rather than
	// `show`, matching Mature — cautious, and one click from either.
	const [existing] = await db
		.select({ display: accounts.adultDisplay })
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);

	await db
		.update(accounts)
		.set({
			adultOptIn: true,
			adultVerifiedAt: verifiedAt,
			adultVerifiedMethod: method,
			adultDisplay: existing?.display ?? "blur",
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
