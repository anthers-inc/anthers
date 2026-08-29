// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access & entitlement resolution — the one place that answers
 * "may this user consume this Work, and if not, what does it cost?"
 *
 * The subject is a **Work**, not a Post (migration `0010`). Gates used to hang off the
 * Post, but a Work could be referenced from any number of Posts and inherited each one's
 * gates independently — so the same bytes were genuinely free via one Post and gated via
 * another, resolved per URL. A gate belongs to the thing being gated. A Post's reference
 * to a Work is inert and confers nothing; see `40.08 Catalog and Posts` in the vault.
 *
 * Access is expressed by **one** per-Work table (see `packages/db/src/schema/content.ts`),
 * whose rows are `{ threshold, allow, price }` with `threshold` in **monthly dollars given
 * to this Work's creator this cycle**. `threshold: 0` is the baseline — everyone — and is
 * not a gate at all.
 *
 * A viewer *qualifies* for a row when they meet its threshold. Among the rows they
 * qualify for AND that are allowed, the cheapest price wins. price 0 = free; a positive
 * price = a one-time purchase that unlocks the Work's enabled delivery (stream and/or
 * download — one price unlocks both). No qualifying allowed row is a hard gate. Works
 * ship "free but fully locked" (baseline row, allow=false).
 *
 * 🚨 **There were two tables, OR-ed together, until 2026-08-12.** The second read the
 * viewer's *Anthers* Badge — "Sprout and above" — and **Anthers Gates are retired**,
 * because they stratified the commons: better public content behind a higher Badge beside
 * worse public content that was actually free. So a Work is now either gated by its
 * creator or it is **Public Access** — ungated and streaming, free to everyone — and
 * `ANTHERS_BADGES` no longer participates in resolution at all. A Badge is standing.
 * Reasoning: `30.01 Creator Content Gates` § 4.1b. Migration `0029` folded the column in.
 *
 * ⚠️ The OR *within* this table survives and is the interesting one: a creator may gate on
 * **another creator's** support level, which is the seed of collabs and bundles. There is
 * still no AND.
 *
 * Resolution reads two viewer facts — per-creator dollars this cycle and prior purchases —
 * which `buildAccessContext` loads once so a batch (a Catalog page) resolves without an N+1.
 *
 * Note a gate need not sit on a Badge. Thresholds are amounts, not Badge identities, so a
 * creator may gate at $3 whether or not they have named a Badge there.
 */

import { db } from "@anthers/db/client";
import type { AccessRow, SeedAccessRow } from "@anthers/db/schema";
import { accounts, purchases, seedAllocations } from "@anthers/db/schema";
import { amountMeets, supportAmount } from "@anthers/shared/constants";
import { requiresAdultVerification } from "@anthers/shared/content-rating";
import {
	NO_PARENTAL_CONTROLS,
	type ParentalPolicy,
	parentalRefusal,
} from "@anthers/shared/parental-controls";
import { and, eq, inArray } from "drizzle-orm";
import { adultAccessFor } from "./content-preferences.js";
import { parentalPolicyFor } from "./parental-controls.js";

/** The Work fields access resolution depends on (structurally satisfied by a full work row). */
export interface AccessibleWork {
	id: number;
	/**
	 * Null on a Work whose creator deleted their account — it was WITHDRAWN rather than
	 * destroyed so its buyers keep it. No creator means no creator gate can be
	 * cleared (there is nobody to have given to) and no owner bypass, both of
	 * which fall out of the null comparisons below rather than needing a branch.
	 */
	creatorId: number | null;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	seedAccess: SeedAccessRow[] | null;
	/**
	 * The Work's DMCA takedown state — `active` or `taken_down`. A taken-down Work
	 * stops delivery to EVERYONE, including the creator and buyers, because
	 * continuing to serve infringing bytes to buyers is continuing to infringe.
	 * Checked before every other rule in `resolveAccessSync`, so every delivery
	 * route that calls `resolveAccess` gets the denial for free — one predicate,
	 * not seven routes remembering. See `services/dmca.ts`.
	 */
	takedownStatus: string;
	/**
	 * The Work's content rating — `unrated`, `general`, `mature` or `adult`.
	 *
	 * 🚨 **Only `adult` reaches resolution, and `mature` deliberately does not.** A mature
	 * rating is a warning and a filter input carrying no access consequence at all — the
	 * Work stays Public Access if its creator left it ungated, stays earning, and stays
	 * reachable by a signed-out visitor. Teaching this resolver to read `mature` would
	 * silently paywall the work wiki 40.13 draws its rows to protect. See 40.09 § How
	 * Access Works When It Opens.
	 */
	maturity: string;
	/**
	 * The Work's child-safety quarantine state — `none` or `quarantined`.
	 *
	 * 🚨 **The only denial in this resolver that reaches everybody without exception**, the
	 * creator included. A takedown already stops serving buyers; this also stops serving
	 * the person who uploaded it, because the material may not be delivered to anyone at
	 * all. Checked before the takedown for no reason other than reading order — the two
	 * cannot disagree about whether to serve, only about why.
	 *
	 * ⚠️ **This is the second of two independent denials and neither is redundant.**
	 * Reading it here means every delivery route that resolves a Work inherits the refusal;
	 * `assertServableKey` in the storage layer catches a route that signs a key without
	 * resolving one. See `services/quarantine.ts`.
	 */
	quarantineStatus: string;
	/**
	 * The Work's medium — `video`, `audio`, `text`, `game`, `ebook`, `image`, `software`.
	 *
	 * Read only by the **parental** rules, which are the one viewer-side restriction that
	 * cares what something *is* rather than what it costs or who made it. Nothing else in this
	 * resolver has ever needed the type, and adding it here rather than passing it alongside
	 * keeps a Work one argument.
	 */
	type: string;
}

/** Viewer facts needed to resolve access, loaded once and reused across a batch of Works. */
export interface AccessContext {
	userId: number | null;
	/** creatorId → monthly dollars the viewer has directed at that creator this cycle */
	supportByCreator: Map<number, number>;
	/** Work ids the viewer has a completed purchase for */
	purchasedWorkIds: Set<number>;
	/**
	 * May this viewer reach Works rated `adult`? The AND of the account-level opt-in and a
	 * one-time adulthood verification — `services/content-preferences.ts` owns both.
	 *
	 * 🚨 **False for a signed-out visitor, always, and that is a property of the model
	 * rather than a default.** Somebody with no account has no setting for the opt-in to
	 * consult, which is why Adult work is invisible to them entirely rather than merely
	 * locked. The same holds for a share link: it tells somebody where a Work is and never
	 * what they may reach, so entitlement stays here.
	 */
	adultAccess: boolean;
	/**
	 * Whose allowance this viewing spends, when it arrived through a **share link** — the
	 * single exception to the rule that consuming a Work requires an account.
	 *
	 * 🚨 **Read at exactly one line of `resolveAccessSync`**, the branch where access would
	 * otherwise be granted to universally-free work, and nowhere else. That is not tidiness;
	 * it is what makes "a share link is a locator and never an entitlement" a property of the
	 * code rather than a rule somebody has to keep obeying. Every refusal above that line —
	 * quarantine, takedown, **Adult**, the gates, a price — runs on the ordinary rules against
	 * a null viewer, so a link can carry nothing but free work out.
	 *
	 * ⚠️ **Only consulted when `userId` is null.** A share link followed by somebody who has
	 * an account does nothing at all: they resolve on their own standing and spend their own
	 * allowance. A link that granted access would bypass that person's own Adult opt-in
	 * exactly as it bypasses an anonymous visitor's absent one, which is the half of 40.13's
	 * rule that is easiest to get wrong.
	 */
	sharedBy: number | null;
	/**
	 * A guardian's controls on this account — see `@anthers/shared/parental-controls`.
	 *
	 * 🚨 **Sits on the VIEWER and never on the Work**, which is what makes it safe to put in a
	 * resolver that a whole Catalog page runs through. A blocked creator is not less rated and
	 * a limited household's Work is not less free; what changes is what reaches one account, so
	 * no answer here can leak into anybody else's catalogue.
	 *
	 * ⚠️ **Time limits are deliberately NOT here.** They need a query — how long has this
	 * account consumed today — and this resolver is pure and synchronous precisely so a batch
	 * resolves without an N+1. The same reason the Public Access meter lives at delivery, and
	 * the same shape: what runs out belongs to the account, not to the Work.
	 */
	parental: ParentalPolicy;
}

/**
 * The stand-in identity a **creator preview** resolves as.
 *
 * 🚨 Negative on purpose, and named rather than inlined. `resolveAccessSync` branches on
 * two properties of `ctx.userId` and nothing else: `null` means logged out (→
 * `login_required`), and `=== work.creatorId` means owner (→ full access). A preview needs
 * *neither* — it is asking "what would a signed-in stranger see?" — so it needs a value
 * that is non-null and can never equal a real `users.id`. Serial ids are positive, so a
 * negative one is exactly that, and it never reaches a query: a preview context is built
 * in memory and read only by the pure resolver.
 */
export const PREVIEW_VIEWER_ID = -1;

/**
 * An access context that answers "what would somebody else see?", for a creator looking at
 * their own work.
 *
 * 🚨 **A preview can only ever SUBTRACT access, and that is a property of where it is
 * applied rather than of this function.** Callers must apply it only to Works the
 * requesting user *created* — who already sees everything of theirs — so every substituted
 * answer is less permissive than the real one. Applied to somebody else's Work it would be
 * a way to ask for a better answer than you are entitled to, which is why the route guards
 * per Work rather than per request.
 *
 * It deliberately drives the same `resolveAccessSync` everything else does. Reimplementing
 * gate logic for a preview would let the preview drift from reality and start lying in
 * exactly the situation it exists to clarify.
 */
export function buildPreviewContext(opts: {
	/** Whose ladder is being previewed — the creator's own. */
	creatorId: number;
	/** Monthly $ the imagined viewer gives that creator, or null for "signed out". */
	given: number | null;
	/** Whether the imagined viewer has bought the Work outright. */
	owned: boolean;
	/** Works the `owned` toggle applies to. */
	workIds: number[];
}): AccessContext {
	const signedOut = opts.given === null;
	return {
		userId: signedOut ? null : PREVIEW_VIEWER_ID,
		// A signed-out viewer has given nobody anything and owns nothing — both maps stay
		// empty rather than being special-cased in the resolver.
		supportByCreator: signedOut ? new Map() : new Map([[opts.creatorId, opts.given ?? 0]]),
		purchasedWorkIds: !signedOut && opts.owned ? new Set(opts.workIds) : new Set(),
		// The imagined signed-in viewer has opted in and verified; the signed-out one cannot
		// have, because there is no account to hold the setting.
		//
		// (see below for the parental note)
		// ⭐ **Not a shortcut — it is what keeps the preview answering the question it was
		// asked.** A preview exists to show a creator their own access ladder at $N given,
		// and an imagined viewer with no opt-in would answer `adult_gated` at every rung,
		// telling them nothing about the ladder they came to look at. The signed-out case
		// still shows the invisibility correctly, which is where a creator actually needs to
		// see it. This stays inside the "a preview can only ever SUBTRACT access" rule
		// because it is applied to the creator's own Works, and the creator already reaches
		// them by the owner branch.
		adultAccess: !signedOut,
		// A preview asks what a viewer with a given standing would see, and arriving by a
		// share link is not a standing — it is how somebody got here. Nothing to imagine.
		sharedBy: null,
		// Likewise: a creator previewing their ladder is asking about their gates, and
		// answering "blocked" because some imagined household restricted them would tell them
		// nothing about the thing they came to look at.
		parental: NO_PARENTAL_CONTROLS,
	};
}

export type AccessReason =
	| "owner"
	| "free"
	| "purchased"
	| "entitled"
	| "payment_required"
	| "gated"
	| "login_required"
	| "takedown"
	| "quarantined"
	| "adult_gated"
	| "blocked_creator"
	| "blocked_type";

/**
 * One way a denied viewer could open this Work, stated in the gate's own terms.
 *
 * `moreNeeded` is the point of this type: the UI must be able to say what the viewer
 * still needs, not what the gate abstractly requires, and it must not compute that
 * itself. The client used to derive its own label from the threshold and got it wrong —
 * naming the highest Badge at-or-below the gate, which by definition does *not* clear a
 * gate that sits above it. Resolution owns the thresholds, so resolution owns this.
 */
export interface UnlockRoute {
	/** Monthly dollars this gate requires. */
	threshold: number;
	/** Dollars the viewer still has to add — the marginal ask. */
	moreNeeded: number;
	/** `threshold` rendered as a money string. */
	price: string;
	/**
	 * The Badge sitting EXACTLY at this threshold, or null when the gate sits between
	 * Badges (which is legal — a gate needn't sit on a Badge). Never the nearest Badge:
	 * naming one the viewer would still be short of is the bug this type exists to kill.
	 *
	 * ⚠️ **Always null today.** It was populated from `ANTHERS_BADGES` for the Anthers
	 * route, and that route is retired; a creator's own Badges are their rows, not carried
	 * on the Work. The field stays because creator Badges are what will fill it, and it is
	 * a plain `string` rather than `BadgeKey` because a creator names theirs whatever they
	 * like.
	 */
	badge: string | null;
}

/**
 * How a gated Work could be opened.
 *
 * `creator` is null when there is no path in at all — a Work whose only allowed rows
 * carry a price cannot be opened by climbing, because reaching the threshold would still
 * leave a purchase in the way.
 *
 * ⚠️ This was a two-field type until 2026-08-12, with an `anthers` route beside this one.
 * Anthers Gates are retired, so there is one destination left. It stays an object rather
 * than collapsing to `UnlockRoute | null` because a creator gating on **another
 * creator's** support level is a live case, and that is where a second route would reappear.
 */
export interface UnlockOffer {
	/** Climb by giving more to this creator. */
	creator: UnlockRoute | null;
}

export interface AccessResult {
	/** May the viewer consume the Work now? */
	canAccess: boolean;
	reason: AccessReason;
	/**
	 * Present only when the viewer is shut out by a gate (`gated`), and only for routes
	 * that genuinely open the Work. Absent for purchase (ProjectPricing owns that) and,
	 * necessarily, for a logged-out viewer, whose standing we don't know.
	 */
	unlock?: UnlockOffer;
	/** Accessible to everyone at no cost. */
	isFree: boolean;
	/** A (one-time) purchase is the path to access. */
	requiresPurchase: boolean;
	/** Minimum price to unlock via purchase (money string), or null when free/gated. */
	price: string | null;
	/** Viewer qualifies via an allowed access row (a gate), even if a price still applies. */
	isEntitled: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
}

/** First day of the current month, `YYYY-MM-DD` — the billing-cycle key used across the app. */
export function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Monthly dollars a user currently gives Anthers.
 *
 * ⚠️ **This no longer decides access to any Work.** It compared against Anthers Gates
 * until 2026-08-12; those are retired, and what money given to Anthers now governs is
 * the account-level Public Access limit and the size of the user's Time Pool — neither of
 * which is a property of a Work. Kept because both of those read it, and because it is
 * the Badge.
 *
 * A raw amount, not a Badge name: a Badge is the highest threshold you meet, so collapsing
 * to it first rounds someone giving $9 down to a $6 Badge. Name the Badge only for
 * display.
 */
export async function heldAnthersSupport(userId: number): Promise<number> {
	const [row] = await db
		.select({ anthersSupport: accounts.anthersSupport })
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);
	// ⚠️ NOT floored. It rounded down to a whole Seed until 2026-08-16, which is right for
	// a count and destroys a real amount: $2.50 became $2 and stopped clearing its own gate.
	return supportAmount(row?.anthersSupport);
}

function money(n: number): string {
	return (Math.round(n * 100) / 100).toFixed(2);
}

/** An allowed row the viewer qualifies for: its numeric price and whether it's a baseline (everyone) row. */
interface Offer {
	price: number;
	baseline: boolean;
}

/** The allowed rows a viewer giving `given` a month to this creator qualifies for. */
function offersFor(rows: AccessRow[], given: number): Offer[] {
	const offers: Offer[] = [];
	for (const row of rows) {
		if (!row.allow) continue;
		const threshold = Number(row.threshold ?? 0);
		if (!amountMeets(given, threshold)) continue;
		offers.push({ price: Number(row.price ?? "0"), baseline: threshold <= 0 });
	}
	return offers;
}

/**
 * The cheapest rung in one table that would actually OPEN the Work for this viewer.
 *
 * "Actually open" is the whole subtlety: only a row that is both allowed **and free**
 * qualifies. An allowed row carrying a price doesn't become access when you reach its
 * threshold — it becomes a purchase — so offering it as an unlock route would promise
 * something climbing cannot deliver. Returns null when the table offers no such rung.
 */
export function unlockRoute(
	rows: AccessRow[],
	given: number,
	badges: readonly { name: string; threshold: number }[],
): UnlockRoute | null {
	let best: number | null = null;
	for (const row of rows) {
		if (!row.allow) continue;
		if (Number(row.price ?? "0") > 0) continue;
		const threshold = Number(row.threshold ?? 0);
		if (amountMeets(given, threshold)) continue; // already met — not a route in
		if (best === null || threshold < best) best = threshold;
	}
	if (best === null) return null;
	// Exact match only. The nearest Badge at-or-below would not clear this gate, and
	// naming it is precisely the error this replaces.
	const badge = badges.find((b) => b.threshold === best) ?? null;
	return {
		threshold: best,
		moreNeeded: Math.max(0, best - given),
		price: money(best),
		badge: badge?.name ?? null,
	};
}

/**
 * Resolve access for a single Work against an already-loaded viewer context.
 * Pure and synchronous, so a Catalog page resolves a batch cheaply.
 */
export function resolveAccessSync(work: AccessibleWork, ctx: AccessContext): AccessResult {
	const base = {
		isFree: false,
		requiresPurchase: false,
		price: null as string | null,
		isEntitled: false,
		streamEnabled: work.streamEnabled,
		downloadEnabled: work.downloadEnabled,
	};

	// 🚨 A quarantine stops delivery to EVERYONE, and unlike every other rule here it has
	// no exception for the person who uploaded it. Reported or detected child-safety
	// material may not be delivered to anybody — a purchase does not survive it, the
	// creator's own ownership does not survive it, and there is no route in. Checked
	// first so that no rule below can be read as an escape from it, and so every delivery
	// route that resolves a Work inherits the denial without remembering to. The object
	// itself has also been moved somewhere no signer will touch; see `services/quarantine.ts`.
	if (work.quarantineStatus === "quarantined") {
		return { ...base, canAccess: false, reason: "quarantined" };
	}

	// A DMCA takedown stops delivery to EVERYONE — the creator, buyers, and entitled
	// viewers — before any other rule is considered. Continuing to serve infringing
	// bytes to buyers is continuing to infringe, which is the precise distinction from
	// `withdrawn` (which deliberately keeps serving buyers). This is checked first so
	// every delivery route that calls `resolveAccess` gets the denial for free, and no
	// route has to remember to check it separately. See `services/dmca.ts`.
	if (work.takedownStatus === "taken_down") {
		return { ...base, canAccess: false, reason: "takedown" };
	}

	// Creators always see their own content.
	if (ctx.userId != null && ctx.userId === work.creatorId) {
		return { ...base, canAccess: true, reason: "owner" };
	}

	// 🚨 A guardian has put this creator or this medium out of reach for this account.
	//
	// **Above the adult gate, the purchase and the gates, and below the owner check** — the
	// same place the Adult rung sits, for the same reason. A household's rules are not
	// something money undoes: a Work the account already bought is still blocked, because what
	// a guardian restricted was the reaching rather than the paying, and a purchase that
	// overrode the panel would make it mean "except for things you already own".
	//
	// ⚠️ Below the owner check so a young creator always reaches their own work. Locking
	// somebody out of the thing they made would be a strange way to protect them, and it would
	// make their own Work un-editable.
	const blocked = parentalRefusal(ctx.parental, {
		creatorId: work.creatorId,
		workType: work.type,
	});
	if (blocked) return { ...base, canAccess: false, reason: blocked };

	// 🚨 A Work rated `adult` is reachable only by an account that has both opted in and
	// verified an adult. Wiki 40.09 § How Access Works When It Opens.
	//
	// **Above the purchase check on purpose, and it is the only rule here besides the two
	// denials above that outranks a receipt.** A purchase outlives everything on Anthers, so
	// this needs a reason: the viewer bought this while opted in and has since opted out, and
	// what they are being refused is something they asked not to be shown. That is honoring
	// their setting rather than taking their purchase away — nothing is lost, the Work
	// returns the moment they turn it back on, and a purchase that overrode the setting would
	// make the setting mean "except for things you already own", which nobody would expect.
	//
	// ⚠️ **Below the owner check, so a creator always reaches their own work.** A creator who
	// has never opted in is not asking to be protected from the thing they made, and locking
	// them out of their own Work would make it un-editable and un-previewable.
	if (requiresAdultVerification(work.maturity) && !ctx.adultAccess) {
		return { ...base, canAccess: false, reason: "adult_gated" };
	}

	// A prior purchase unlocks it permanently.
	if (ctx.purchasedWorkIds.has(work.id)) {
		return { ...base, canAccess: true, reason: "purchased" };
	}

	const given = work.creatorId == null ? 0 : (ctx.supportByCreator.get(work.creatorId) ?? 0);
	const offers = offersFor(work.seedAccess ?? [], given);

	// No qualifying allowed row → hard gate. Report what would open it, from here.
	if (offers.length === 0) {
		if (ctx.userId == null) return { ...base, canAccess: false, reason: "login_required" };
		return {
			...base,
			canAccess: false,
			reason: "gated",
			unlock: {
				// No Badge set: a creator's Badges are their own rows, not carried on the Work
				// (thresholds are levels, not Badge identities — migration 0007). The creator's
				// name is the identity the UI shows here, so it needs no Badge.
				creator: unlockRoute(work.seedAccess ?? [], given, []),
			},
		};
	}

	// Qualifies via a non-baseline (a creator's gate) row → "entitled" for display.
	const isEntitled = offers.some((o) => !o.baseline);

	// Free when any qualifying allowed row is priced at/below 0.
	if (offers.some((o) => o.price <= 0)) {
		const universallyFree = offers.some((o) => o.baseline && o.price <= 0);

		/**
		 * 🚨 **Consuming a Work requires an account, and this is the line that says so.**
		 *
		 * A signed-out visitor resolved `free` here until 2026-08-28, which is the single
		 * fact the whole anonymous-viewing model rested on. It was never a decision: no
		 * delivery route carried `requireAuth`, and a justification for the absence
		 * ("anonymous streaming of the commons is the shop window") was written down
		 * afterwards and propagated into 21.01, the Roadmap and this layer's own comments.
		 * Parker's correction on 2026-08-14 is that an account is how terms are accepted,
		 * how 13+ is asserted, and above all how attention is attributed — **the Time Pool
		 * cannot pay a creator for time it cannot attribute to anyone.** So the commons was
		 * being watched for free by nobody in particular, and the creator earned nothing.
		 *
		 * ⚠️ **`isFree` stays true, and that is the point of putting the refusal here rather
		 * than at the top of the resolver.** What is public is the Work's *page* — title,
		 * cover, duration, and the verdict itself — and what requires an account is
		 * **delivery**. A signed-out visitor still learns that this Work is free to everyone,
		 * which is what makes the page worth sharing and worth unfurling; they simply are not
		 * handed the bytes. `serializeWorkForViewer` reads `canAccess` for the deliverable and
		 * `isFree` for the Public Access badge, so both halves of that sentence land.
		 *
		 * **`payment_required` and `gated` are deliberately left alone below and above.**
		 * Both already refuse a signed-out visitor, and both tell them something true and
		 * useful about the price of entry. Collapsing them into `login_required` would
		 * subtract the price from a public page in order to state a rule that page is already
		 * obeying.
		 */
		//
		// ⚠️ **The share-link exception is this one clause, and it is placed here rather than
		// anywhere earlier for a reason that is worth stating.** Everything above still runs
		// against a null viewer, so a link can only ever emerge from *this* branch — the one
		// reached exclusively by work that is free to everyone. Gated work never gets here
		// (no qualifying allowed row), priced work never gets here, and Adult work is refused
		// two checks above because a share context carries no opt-in and cannot be given one.
		// That is what makes "ungated only" a property of the control flow instead of a rule
		// somebody has to remember; see `services/share-links.ts`.
		if (ctx.userId == null && ctx.sharedBy == null) {
			return { ...base, canAccess: false, reason: "login_required", isFree: universallyFree };
		}

		return {
			...base,
			canAccess: true,
			reason: universallyFree ? "free" : "entitled",
			isFree: universallyFree,
			isEntitled,
		};
	}

	// Purchasable: cheapest qualifying allowed price unlocks the enabled delivery.
	const min = Math.min(...offers.map((o) => o.price));
	return {
		...base,
		canAccess: false,
		reason: "payment_required",
		requiresPurchase: true,
		price: money(min),
		isEntitled,
	};
}

/**
 * Load the viewer facts needed to resolve access. Pass the Work ids in view to
 * scope the purchase lookup; omit for "all of the viewer's purchases".
 */
export async function buildAccessContext(
	userId: number | null,
	opts: {
		workIds?: number[];
		/**
		 * The sharer whose allowance a **share-link** view spends. Ignored when `userId` is
		 * set — see `AccessContext.sharedBy`.
		 */
		sharedBy?: number | null;
	} = {},
): Promise<AccessContext> {
	if (userId == null) {
		return {
			userId: null,
			supportByCreator: new Map(),
			purchasedWorkIds: new Set(),
			// A signed-out visitor has no account and therefore no opt-in to read. Stated
			// here rather than left to a default so the closed answer is visible at the one
			// place the logged-out context is built.
			adultAccess: false,
			// Set by `viewerFor` in routes/content.ts when a request carries a live
			// share token. Null here because this is the ordinary logged-out context, and a
			// default that guessed otherwise would hand out an allowance nobody offered.
			sharedBy: opts.sharedBy ?? null,
			// A visitor with no account has no guardian's controls to read. Note this makes a
			// **share link** carry none either — correct, because the controls belong to the
			// sharer's account and the person watching is not them. The relay budget is what
			// bounds a link; a household's rules are not transitive.
			parental: NO_PARENTAL_CONTROLS,
		};
	}

	const cycle = currentBillingCycle();
	const scoped = opts.workIds && opts.workIds.length > 0;

	const [seedRows, purchaseRows, adult, parental] = await Promise.all([
		db
			.select({ creatorId: seedAllocations.creatorId, amount: seedAllocations.amount })
			.from(seedAllocations)
			.where(and(eq(seedAllocations.userId, userId), eq(seedAllocations.billingCycle, cycle))),
		db
			.select({ workId: purchases.workId })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, userId),
					eq(purchases.status, "completed"),
					...(scoped ? [inArray(purchases.workId, opts.workIds as number[])] : []),
				),
			),
		adultAccessFor(userId),
		parentalPolicyFor(userId),
	]);

	// `seed_allocations.amount` is MONEY and stays money — it is the payment ledger, not a
	// gate. Gates are denominated in money too now, so nothing is converted here; the map
	// carries the ledger's own dollars straight through to every threshold comparison.
	const supportByCreator = new Map<number, number>();
	for (const s of seedRows) {
		// 🚨 Dollars straight off the ledger, with NO conversion. This read
		// `seedsFromDollars(s.amount)` until 2026-08-16 — dividing a recorded payment by
		// the CURRENT Seed price — so moving that price silently reinterpreted every
		// in-flight allocation, retroactively changing which gates a supporter cleared for
		// money they had already paid. Retiring the unit removed the conversion and the
		// hazard together; do not reintroduce one.
		supportByCreator.set(s.creatorId, supportAmount(s.amount));
	}

	return {
		userId,
		supportByCreator,
		// Seed one-time charges have a null workId — only real Work purchases unlock.
		purchasedWorkIds: new Set(
			purchaseRows.map((p) => p.workId).filter((id): id is number => id !== null),
		),
		adultAccess: adult.canReach,
		parental,
		// Deliberately null even if a share token rode along on this request. Somebody with
		// an account resolves on their own standing and spends their own allowance; a link
		// they followed tells them where a Work is and nothing more.
		sharedBy: null,
	};
}

// `isPubliclyFree(post)` used to live here, documented as driving storage-ACL decisions
// in the media jobs. It never had a call site and never could: the jobs run when a Work
// is uploaded to the Catalog, before it is released or gated, so there is no access table
// to evaluate — and a Work's access can change after the transcode anyway, which would
// leave a baked-in ACL wrong. The settled answer is the opposite shape: store every
// derived media object private, and sign per request at the delivery endpoints, where
// access is re-resolved live. See `deliveryCtxFor` in routes/content.ts.

/** Convenience: resolve access for a single Work (loads its own context). */
export async function resolveAccess(
	work: AccessibleWork,
	userId: number | null,
): Promise<AccessResult> {
	const ctx = await buildAccessContext(userId, { workIds: [work.id] });
	return resolveAccessSync(work, ctx);
}

/**
 * The access table a freshly created Work ships with: the baseline row alone, locked —
 * "free but fully locked". The creator opts access in, and adds ladder rungs above it.
 *
 * A companion `defaultAnthersAccess()` seeded rows at [0,1,2,3,4] until 2026-08-12, one
 * per Anthers Badge. Anthers Gates are retired and it is gone with them.
 */
export function defaultSeedAccess(): SeedAccessRow[] {
	return [{ threshold: 0, allow: false, price: "0" }];
}
