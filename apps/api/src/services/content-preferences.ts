// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content preferences — the only writer of what a reader has asked to meet: the Adult opt-in,
 * the adulthood verification behind it, and the per-rung display setting for each of them.
 *
 * Follows the one-writer pattern `services/content-rating.ts`, `services/moderation.ts` and
 * `services/quarantine.ts` establish. Every door into this state comes through here, so an
 * account cannot end up opted in to something it was never verified for.
 *
 * 🚨 **Every write here asks `maturityLocked` first, and that is the parental lock's only
 * enforcement point.** It used to sit at `PATCH /me/content-preferences` alone, which left the
 * two routes that write `adultOptIn` and `adultVerifiedAt` — the columns that actually decide
 * whether an account reaches Adult work — outside a lock a guardian had been told closed
 * exactly that gap. A check derived from the account rather than from the request belongs in
 * the writer, because the writer is the thing every door has to go through.
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
	MATURITY_RATINGS,
	type MaturityDisplay,
	requiresAdultVerification,
} from "@anthers/shared/content-rating";
import { eq, type SQL, sql } from "drizzle-orm";
import { getStripe } from "../lib/stripe.js";
import { ensureStripeCustomer } from "./billing.js";
import { maturityLocked } from "./parental-controls.js";

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

/**
 * Set a rung's display preference. The only writer of the two display columns.
 *
 * Refuses under a guardian's lock rather than writing, and the refusal is returned rather than
 * swallowed: a setting that appears to save and does not is worse than one that says no.
 */
export async function setMaturityDisplay(
	userId: number,
	input: { mature?: MaturityDisplay; adult?: MaturityDisplay },
	now: Date = new Date(),
): Promise<ContentPreferences | "parental_locked"> {
	if (await maturityLocked(userId)) return "parental_locked";

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
 * Every rung this viewer has asked to keep out of listings, as one condition.
 *
 * 🚨 **This is the ONLY maturity condition a listing composes, and there is deliberately no
 * narrower sibling.** An `adultHiddenFrom` covering the access half alone existed until
 * 2026-08-29 and emitted `maturity <> 'adult'` — a deny-list, admitting any rung it had not
 * been told about, which is the one direction this filter must never fail in. A second helper
 * doing most of one job is how that happened, so there is one.
 *
 * Two different reasons produce the same absence and they are not the same rule. A rung is
 * absent because the viewer **may not reach it** (the Adult opt-in and verification, which is
 * the platform's rule) or because the viewer **asked for it to be hidden** (their own
 * `hide` preference, which is theirs). Both end in a row missing from a listing, so both are
 * expressed here — but only the first is enforcement, and `resolveAccessSync` implements that
 * one independently. **A `hide` preference is never an access rule**: the Work stays reachable
 * by a direct link, which is exactly what separates hiding from opting out.
 *
 * 🚨 **Adult is INVISIBLE rather than merely inaccessible** — its existence, title and cover
 * art included — so this is a `WHERE` clause on every listing rather than a lock the reader
 * meets on arrival. Wiki 40.09: a signed-out visitor has no account-level setting for the
 * opt-in to consult, so Adult work is invisible to them entirely; and a signed-in account
 * that has not opted in meets the same absence on every other surface — creator profiles,
 * Catalog listings, the followed-creator feed, and search (Parker, 2026-08-28, settling
 * 40.09's open question). Following somebody is not the opt-in.
 *
 * ⭐ **One rule for everyone without the opt-in, which is what makes it testable as an
 * absence.** The alternative considered was an interstitial saying an Adult Work is here,
 * and it was rejected because the existence — and usually the title — is exactly the thing
 * the rung does not get. The accepted cost is that a creator's profile silently omits work
 * from a reader who has not opted in.
 *
 * ⭐ **`blur` produces no condition at all**, because a blurred Work is listed. The blur is
 * the client's job, from the `maturity` value that already travels with every Work.
 *
 * Always returns a condition — a viewer who may see everything gets `IN` over every rung
 * rather than nothing — and keeps `undefined` in its type so it composes into `and(...)`
 * alongside `notBlockedBy` and `parentalHiddenFrom`, which do drop out.
 */
export function maturityHiddenFrom(
	prefs: ContentPreferences,
	viewerId: number | null,
	creatorColumn: SQL | unknown = works.creatorId,
	maturityColumn: SQL | unknown = works.maturity,
): SQL | undefined {
	// 🚨 **An allow-list, not a deny-list, and the direction is the safety property.**
	// `NOT IN ('adult')` lets through any value it has not been told about — a rating from a
	// newer deployment mid-rollout, a rung added later, a corrupted row — which is the one
	// direction this filter must never fail in. Listing what a viewer MAY see means an
	// unrecognized rating is absent instead, and *"I'd rather have someone not see Adult
	// content when they should than see Adult content when they shouldn't"* (Parker,
	// 2026-08-28) is the rule that settles which of those two costs to take.
	//
	// ⭐ Derived from the vocabulary rather than typed out, so a rung added to
	// `MATURITY_RATINGS` is classified by `requiresAdultVerification` here automatically
	// instead of silently defaulting to visible.
	const visible = MATURITY_RATINGS.filter((rating) => {
		if (requiresAdultVerification(rating)) {
			return prefs.adultAccess.canReach && prefs.adult !== "hide";
		}
		return !(rating === "mature" && prefs.mature === "hide");
	});

	const list = sql.join(
		visible.map((rung) => sql`${rung}`),
		sql`, `,
	);
	// 🚨 A creator always sees their own, whatever they have asked to be shown. Somebody who
	// hid a rung is filtering what they browse, not deleting their own Catalog — and a reader
	// with no opt-in is not asking to be protected from the thing they made.
	if (viewerId == null) return sql`${maturityColumn} IN (${list})`;
	return sql`(${maturityColumn} IN (${list}) OR ${creatorColumn} = ${viewerId})`;
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
	| "funding_not_credit"
	/**
	 * A guardian has locked this account's content-rating settings.
	 *
	 * 🚨 **Checked before anything else, and it is the one refusal that is not about a card.**
	 * The borrowed-card scenario is the whole reason the pin exists: a parent's credit card
	 * passes the funding check, so a teenager holding one clears adulthood verification
	 * honestly. What stops them is that the account itself may not turn the rung on. Answering
	 * this before Stripe is consulted also means the lock holds on a deployment where the card
	 * check is unavailable, which is the direction it must fail in.
	 */
	| "parental_locked";

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

	// 🚨 A failure to reach Stripe is a failure to verify, never a pass. Letting the request
	// 500 would also have failed closed, but it reads to the person as a broken site rather
	// than a check that did not complete — and to whoever is watching, as an outage rather
	// than as the gate holding.
	let methods: Awaited<ReturnType<typeof stripe.paymentMethods.list>>;
	try {
		methods = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 10 });
	} catch {
		return "unavailable";
	}

	const cards = methods.data.filter((pm) => pm.card);
	if (cards.length === 0) return "no_card";

	// 🚨 Any credit-funded card on the account passes, and this reads every card rather than
	// the most recent one. The question is whether this accountholder holds a credit line
	// at all, and holding one is not undone by also having a debit card — checking only the
	// newest would make the answer depend on the order somebody happened to add them.
	//
	// ⭐ **An explicit equality against `credit`, so anything else fails.** `debit`,
	// `prepaid`, `unknown` and — the case worth naming — a response where `funding` is
	// missing entirely all land on the same side. Written as `=== "credit"` rather than as a
	// list of what to reject, because a rejection list has to be updated when the vendor adds
	// a value and this does not.
	const hasCredit = cards.some((pm) => pm.card?.funding === "credit");
	if (!hasCredit) return "funding_not_credit";

	// Nothing about the card is written. The verdict, the moment, and the method — see the
	// module note on why that list has no fourth entry.
	return { verifiedAt: now, method: CARD_FUNDING_METHOD };
}

/**
 * Start a card check for somebody who has never paid for anything.
 *
 * 🚨 **A `SetupIntent`, so no money moves and nothing appears on a statement.** The check
 * reads the card's `funding` and nothing else, and Stripe will attach a card and report its
 * funding type without charging for it — so an adult who wants to reach free Adult work is
 * asked to add a card, not to buy something. **Never turn this into a charge**: keeping the
 * money would make Anthers the seller of adult access, refunding it would still be a payment
 * whose only purpose was that access, and either reading is worse than the friction it
 * would buy.
 *
 * ⚠️ **Without this the whole rung is unreachable for its actual audience.** Verification
 * reads cards attached to a Stripe customer, a customer is only created inside a payment
 * flow, and a card is only attached when a payment confirms — so before this existed, an
 * account that had never paid could not verify, could not see that Adult work existed, and
 * therefore could not reach work that is now free.
 *
 * The card stays on file afterwards, which is a side effect rather than the point: it is the
 * same place a later purchase would have put it.
 */
export async function beginAdultVerification(
	userId: number,
	email: string,
): Promise<{ clientSecret: string } | AdultEnableRefusal> {
	// A card check whose only purpose is opening a rung this account may not open. Refusing
	// here rather than at the enable step keeps somebody from being walked through attaching a
	// card to an account that was never going to be allowed to use it.
	if (await maturityLocked(userId)) return "parental_locked";

	const stripe = getStripe();
	if (!stripe) return "unavailable";

	try {
		const customerId = await ensureStripeCustomer(userId, email);
		const intent = await stripe.setupIntents.create({
			customer: customerId,
			payment_method_types: ["card"],
			// Reusable later, so somebody who verifies and then supports a creator is not
			// asked for the same card twice.
			usage: "off_session",
			metadata: { purpose: "adult_verification", userId: String(userId) },
		});
		return intent.client_secret ? { clientSecret: intent.client_secret } : "unavailable";
	} catch {
		return "unavailable";
	}
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
 * an adult who has since canceled the credit card that verified them.
 *
 * 🚨 **A guardian's lock is checked first, and this is the route the lock exists for.** Wiki
 * 40.09 tells a parent that locking the content settings closes the borrowed-card gap, and it
 * only does so because of this line: a credit-funded card in a teenager's hand passes the
 * funding check honestly, so the thing that has to refuse is the account, not the card. The
 * lock deliberately sits *above* the already-verified shortcut described in the paragraph
 * before this one, because an account that verified before a pin was set is the likeliest one
 * of all to have been holding somebody else's card.
 */
export async function enableAdultAccess(
	userId: number,
	now: Date = new Date(),
): Promise<AdultAccess | AdultEnableRefusal> {
	if (await maturityLocked(userId)) return "parental_locked";

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
 *
 * ⭐ **A guardian's lock does not apply here, and that asymmetry is deliberate.** Opting back
 * out only makes the account stricter, so a lock that refused it would be stopping somebody
 * tightening their own settings, which protects nobody. The lock's job is to hold the door
 * shut, and this is somebody closing it further.
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
