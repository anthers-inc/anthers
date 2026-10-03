// SPDX-License-Identifier: Apache-2.0
/**
 * Account & economics routes — the support model.
 *
 * What a user gives Anthers is their held **Badge** on the org's ladder — one discrete
 * pick in `user_badges`, whose threshold IS the amount, read wherever it is needed
 * through `heldAnthersBadgeAmount`. What they direct at creators is a set of **Badge
 * holdings** in `user_badges` — one discrete pick per issuer per cycle, each row naming
 * the Badge whose threshold is the amount; the balance they direct from is
 * `billing_accounts.directed_budget`, written by the subscription webhook.
 *
 * There is no delivery line — delivery is free at any volume. This file also
 * serves time (attention) tracking, pool distributions, creator Badges, and access.
 */

import { db } from "@anthers/db/client";
import {
	accountCycles,
	attentionEvents,
	badges,
	billingAccounts,
	comments,
	creatorCredits,
	creatorNettingApplications,
	creatorNettings,
	creatorTransferCredits,
	creatorTransfers,
	poolDistributions,
	posts,
	stickers,
	userBadges,
	userPreferences,
	users,
	works,
} from "@anthers/db/schema";
import {
	type AttentionEventType,
	eventTypeFor,
	isTimePoolEligible,
	MAX_RANGE_SECONDS,
	RANGE_LOOKBACK_SECONDS,
} from "@anthers/shared/attention";
import { isBadgeColor, isBadgeEmblem, isBadgeShape } from "@anthers/shared/badge-art";
import {
	currentCycleKey,
	cycleEnd,
	cycleKeyFor,
	cycleStart,
	nextCycleKey,
} from "@anthers/shared/billing-cycle";
import {
	amountMeets,
	BADGE_ART_MAX_BYTES,
	BADGE_ART_PX,
	CHARGEABLE_AMOUNT_MESSAGE,
	heldBadgeName,
	isChargeableAmount,
	PUBLIC_ACCESS_PRICE,
	STRIPE_MIN_CHARGE,
	stickerBudgetFor,
	supportAmount,
} from "@anthers/shared/constants";
import { badgeViews } from "@anthers/shared/fees";
import type { PublicAccessBudget, ShareLinkBudget } from "@anthers/shared/public-access";
import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import { isGiveable, stickerAmount } from "@anthers/shared/stickers";
import { groupSupporters } from "@anthers/shared/supporters";
import { zValidator } from "@hono/zod-validator";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import sharp from "sharp";
import type Stripe from "stripe";
import { z } from "zod";
import { accountByHandle, resolveHandle } from "../lib/handles.js";
import {
	createBillingPortalSession,
	createSubscription,
	listCardPaymentMethods,
	paymentsConfigured,
	previewInvoice,
	retrieveSubscription,
	updateSubscription,
} from "../lib/processor.js";
import { getOptionalUserId, requireAuth, requireVerified } from "../middleware/auth.js";
import {
	type AccessibleWork,
	buildAccessContext,
	heldAnthersBadgeAmount,
	heldAnthersBadgeAmountInCycle,
	resolveAccess,
	resolveAccessSync,
} from "../services/access.js";
import { creditedSeconds } from "../services/attention-ranges.js";
import {
	ensureAnthersProduct,
	ensureCreatorProduct,
	ensureStripeCustomer,
	itemsFromSub,
	periodEndFromSub,
	periodStartFromSub,
	planItemChange,
	supportItems,
} from "../services/billing.js";
import { commentAncestry, rootOfAncestry } from "../services/comment-thread.js";
import { canBePaid } from "../services/payouts.js";
import { loadPublicAccessBudget, loadShareLinkBudget } from "../services/public-access.js";
import { scanInlineUpload } from "../services/safety-scan.js";
import { resolveShareToken } from "../services/share-links.js";
import { storage } from "../services/storage/index.js";
import { recordReductions } from "../services/support-reductions.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Operational ceiling, in **dollars a month**, on a single subscription update — a
 * fat-finger and abuse guard, NOT a model bound.
 *
 * `services/billing.ts` describes the Badge ladder as "unbounded, so Blossom+ works", and
 * both are true: the ladder genuinely has no top rung (what you give keeps scaling what
 * your time pays creators), while this caps what one request may set. The two read as
 * contradictory, which is why it was filed as drift; the resolution is that "unbounded" is
 * about the ladder and this is about a request. It is the only such bound in this file, and
 * a second one appearing elsewhere is drift rather than a considered difference.
 *
 * ⚠️ **Two docblocks on one declaration is a shape worth noticing**, because this
 * declaration carried a stale second one for months: the compiler takes the nearest and
 * the reader takes the first, so a rewrite placed above an old block leaves both live and
 * only one of them read.
 */
const MAX_ANTHERS_SUPPORT = 300;

/**
 * The smallest a whole monthly charge may come to.
 *
 * 🚨 **A floor on the INVOICE, never on a destination**, and that distinction is the point
 * of retiring the $3 unit. The old floor was per-Seed and justified by card economics — a
 * $1 charge loses ~33% to processing — but PR #223 made one subscription carry everything a
 * user gives, so the fixed $0.30 is paid once a month whatever the denomination. What the
 * fee actually argues for is a minimum total, which is here, and a creator may set a $1
 * Badge without it costing anyone a third of it.
 *
 * It **is** Stripe's own minimum charge rather than a number chosen to match it, which is why
 * it is `STRIPE_MIN_CHARGE` and not a literal: going lower is not ours to choose, and the
 * same vendor rule is what floors a creator's own amounts.
 */
const MIN_INVOICE_TOTAL = STRIPE_MIN_CHARGE;

/** The Badge ladder (Free … Blossom), each with its monthly amount + decomposition. Shared
 *  with the signup page via `badgeViews()` so the two never drift. */
const BADGE_VIEWS = badgeViews();

// ── Stickers ─────────────────────────────────────────────────────────────────

/** Dollars, rounded the way money is compared here rather than by float chance. */
const round2 = (n: number) => Math.round(n * 100) / 100;

const STICKER_SUBJECTS = ["work", "post", "comment"] as const;
type StickerSubject = (typeof STICKER_SUBJECTS)[number];

/**
 * 🚨 **The client picks art, never an amount.** The art is the denomination, so accepting
 * both would let a caller pair the most elaborate drawing with the smallest sum — and the
 * drawing is what tells a creator and everyone reading the page how generous somebody was.
 * That is a misrepresentation rather than an accounting error, and the only way to make it
 * impossible is to never take the number from the request.
 */
const giveStickerSchema = z.object({
	subjectType: z.enum(STICKER_SUBJECTS),
	subjectId: z.number().int().positive(),
	artKey: z.string().max(64).refine(isGiveable, "Not a Sticker in the current batch"),
});

/** This user's current cycle key and what they may direct by hand within it. */
async function stickerCycleFor(
	userId: number,
): Promise<{ billingCycle: string; allowance: number } | null> {
	// The Anthers side reads the held Badge on the org's ladder; the period rides the
	// billing row. A viewer with no billing row has no period to key from and no holdings
	// to draw against — null, as the callers already treat it.
	const [acct] = await db
		.select({ periodStart: billingAccounts.currentPeriodStart })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	if (!acct) return null;
	const start = acct.periodStart ?? new Date();
	// 🚨 **The same key `distribute-pool` writes, computed by the same function** — which it
	// was not until 2026-09-16, and the divergence was invisible precisely because both
	// were local-time readers and therefore always agreed.
	//
	// Anchoring every account to the 1st made that unsafe: `period_start` became exactly
	// midnight UTC on the 1st, which is the one input a local-time reader gets wrong by a
	// whole month in any zone behind UTC, for every account, every cycle. A Sticker would
	// then be recorded against a cycle the pool job never pays — money a supporter aimed at
	// a creator, reaching nobody. Never build this key by hand.
	const billingCycle = cycleKeyFor(start);
	// The allowance is what THIS cycle's held Badge funds — a Sticker is directed out of the
	// same cycle's pool, so the read is cycle-anchored, not point-in-time.
	const support = await heldAnthersBadgeAmountInCycle(userId, billingCycle);
	return { billingCycle, allowance: round2(stickerBudgetFor(support)) };
}

/** What this user has already directed in the cycle — removed Stickers included. */
async function stickersDirectedIn(userId: number, billingCycle: string): Promise<number> {
	// 🚨 **No `removed_at` predicate, deliberately.** Taking a Sticker off the page returns
	// no money, so a removed one still counts against the cap — otherwise give, remove and
	// give again would spend the same allowance twice, which is the rentable-standing hole
	// arriving through the back door.
	//
	// ⚠️ **`voided_at` is the opposite case and DOES come out.** That is Anthers reverting
	// the direction because it took the Work down, so the money went back to being
	// distributed by time and the giver never spent it. Charging them for a Sticker on
	// something Anthers removed would be charging them for our decision.
	const [row] = await db
		.select({ total: sql<string>`COALESCE(SUM(${stickers.amount}), 0)` })
		.from(stickers)
		.where(
			and(
				eq(stickers.giverId, userId),
				eq(stickers.billingCycle, billingCycle),
				isNull(stickers.voidedAt),
			),
		);
	return round2(Number(row?.total ?? 0));
}

/**
 * The creator of a Work or post a reader can see, or null when there is nothing public there.
 *
 * ⚠️ **Only something already in front of people can carry a Sticker.** A private Work, a
 * draft post, a Work taken down or quarantined — none of them was put there by somebody set
 * up to be paid, and a Sticker on one would direct money at a subject no reader could have
 * found. Answered as absent rather than refused, so a guessed id learns nothing.
 */
async function publicCreatorOf(kind: "work" | "post", id: number): Promise<number | null> {
	if (kind === "work") {
		const [row] = await db
			.select({ creatorId: works.creatorId })
			.from(works)
			.where(
				and(
					eq(works.id, id),
					eq(works.visibility, "released"),
					eq(works.takedownStatus, "active"),
					ne(works.quarantineStatus, "quarantined"),
				),
			)
			.limit(1);
		return row?.creatorId ?? null;
	}
	const [row] = await db
		.select({ creatorId: posts.creatorId })
		.from(posts)
		.where(and(eq(posts.id, id), eq(posts.isPublished, true)))
		.limit(1);
	return row?.creatorId ?? null;
}

/**
 * Who a Sticker on this subject pays.
 *
 * 🚨 **A Sticker pays the CREATOR of the Work or post, never the author of the comment.**
 * It rides the giver's own like or comment and is never placed on somebody else's, so a
 * Sticker on a comment pays whoever made the thing being discussed. Paying commenters would
 * have Anthers moving money between users — a different regulatory question and a different
 * product — and it is one line of code away from happening by accident.
 *
 * 🚨 **And only a creator who can be paid right now.** Publishing takes completed payout setup,
 * but an account Stripe later holds is still the creator of everything it released, and a
 * Sticker given then would be money owed to somebody Anthers cannot pay.
 */
async function stickerRecipient(
	giverId: number,
	subjectType: StickerSubject,
	subjectId: number,
): Promise<{ creatorId: number } | { error: string; code: string; status: 403 | 404 | 409 }> {
	const notFound = { error: "Nothing to sticker", code: "no_subject", status: 404 } as const;

	let creatorId: number | null = null;
	if (subjectType === "comment") {
		const [row] = await db
			.select({ userId: comments.userId })
			.from(comments)
			.where(and(eq(comments.id, subjectId), eq(comments.moderationStatus, "visible")))
			.limit(1);
		if (!row) return notFound;
		if (row.userId !== giverId) {
			return {
				error: "A Sticker rides your own comment, not somebody else's.",
				code: "not_yours",
				status: 403,
			};
		}
		// ⚠️ **The ROOT of the thread, never the comment's own subject.** A reply's subject is
		// another comment, and reading its id as a post's pays whoever wrote the post that
		// happens to share that number.
		const root = rootOfAncestry(await commentAncestry(subjectId));
		if (!root || (root.subjectType !== "work" && root.subjectType !== "post")) return notFound;
		creatorId = await publicCreatorOf(root.subjectType, root.subjectId);
	} else {
		creatorId = await publicCreatorOf(subjectType, subjectId);
	}
	if (creatorId === null) return notFound;

	// Paying yourself would move your own Time Pool into your own pocket, which is not a
	// gift and would let an account cycle money back to itself.
	if (creatorId === giverId) {
		return { error: "You cannot sticker your own work.", code: "own_work", status: 403 };
	}
	if (!(await canBePaid(creatorId))) {
		return {
			error: "This creator can't be paid at the moment, so a Sticker can't reach them.",
			code: "creator_not_payable",
			status: 409,
		};
	}
	return { creatorId };
}

/** The Badge view for monthly dollars given to Anthers (capped at Blossom for display). */
function badgeViewFor(anthersSupport: number) {
	// Look the rung up by its Badge, never by array position. `thresholdForBadge` returns a
	// THRESHOLD, and a threshold only doubles as an index while Anthers' Badges sit at
	// 1/2/3/4; the moment they don't, indexing returns the wrong rung or undefined.
	const held = heldBadgeName(anthersSupport);
	return BADGE_VIEWS.find((v) => v.id === held) ?? BADGE_VIEWS[0];
}

/**
 * A Badge as a client may see it.
 *
 * 🚨 **`artKey` never leaves the server.** The object is private and served through an
 * access-checked route, and a client holding the key is one URL away from fetching badge
 * art on a path nothing checks — which is exactly the boundary the two-bucket split exists
 * to hold. The client needs to know only *whether* to draw the creator's art or the
 * default, so that is the whole of what it gets.
 */
type BadgeRow = typeof badges.$inferSelect;
function publicBadge({ artKey, ...badge }: BadgeRow) {
	return { ...badge, hasArt: Boolean(artKey) };
}

// ⭐ `artShape`, `artColor` and `artEmblem` DO reach the client, and only `artKey` does not.
// They are ids into a library the browser already has, so there is nothing to protect — what
// must not travel is the path to a private object.

// ─── Helpers ─────────────────────────────────────────────────────────────────

// The cycle key and the period both come from `@anthers/shared/billing-cycle` now. Four
// functions computed the key independently until 2026-09-15, all of them reading local time
// while the crons that consume it run in UTC — see that module's header.

function currentPeriod() {
	const key = currentCycleKey();
	return { start: cycleStart(key), end: cycleEnd(key) };
}

async function getAccount(userId: number) {
	const [acct] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	return acct ?? null;
}

/** Ensure a billing row exists; returns it. */
async function ensureAccount(userId: number) {
	const existing = await getAccount(userId);
	if (existing) return existing;
	const { start, end } = currentPeriod();
	const [created] = await db
		.insert(billingAccounts)
		.values({ userId, currentPeriodStart: start, currentPeriodEnd: end })
		.returning();
	return created;
}

/**
 * The directed dollars this user has this cycle — what the Badge picker draws against.
 *
 * 🚨 **Read off `billing_accounts.directed_budget`, never recomputed here.** The
 * subscription webhook is the writer (`syncSubscriptionToAccount`): what the subscription's
 * directed items add up to is Stripe-side truth about what was *paid for*, and a number
 * derived at read time from a subscription fetch would answer a request Stripe has not
 * validated and cost a round trip on every pick. The held-over rule on decreases lives in
 * that write, so every reader of this figure shares one answer.
 */
async function directedBudgetFor(userId: number): Promise<number> {
	const [acct] = await db
		.select({ directedBudget: billingAccounts.directedBudget })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	return Number(acct?.directedBudget ?? 0);
}

// 🚨 A private, cookie-only `getOptionalUserId` lived here until 2026-08-28, having outlived
// the consolidation that `middleware/auth.ts` documents as having removed it. It never read
// the `Authorization: Bearer` header, so a packaged desktop Studio session read as signed out
// at `GET /public-access` and was told it had no allowance. Two ways to read one session must
// not answer differently; the import above is the one that does.

// ── Attention eligibility (server side) ──────────────────────────────────────

/**
 * What a post can legitimately be credited for, resolved from the database rather
 * than taken on the client's word.
 *
 * `packages/shared/src/attention.ts` owns the *policy* — which content types earn,
 * and under what evidence — and the browser applies it honestly. But a claim is an
 * HTTP request, and `distribute-pool` turns `attention_events.duration_seconds`
 * straight into money, so the policy has to be re-decided here against the real
 * post. The wall-clock clamp downstream bounds *volume*; it has nothing to say
 * about *attribution*, and a hand-written request could otherwise credit `read`
 * seconds against a body-only announcement, or against a creator who had nothing
 * to do with the post.
 */
interface WorkEligibility {
	/**
	 * Null on a withdrawn Work whose creator deleted their account. Attention against
	 * one is ineligible by construction — the claim has to name a creator that matches,
	 * and null matches nobody, so there is no creator left to pay.
	 */
	creatorId: number | null;
	/** Event types this Work can earn — empty means it earns nothing. */
	earns: Set<AttentionEventType>;
	/** Whether the claiming viewer may actually consume it. */
	accessible: boolean;
	/**
	 * Whether this Work is **Public Access** — ungated, streaming, free to everyone — so
	 * its seconds draw a free account's monthly allowance. Gated work the viewer cleared,
	 * work they bought, and their own catalog are all excluded by this being false.
	 */
	publicAccess: boolean;
	/** Private Works aren't public consumption, so they can't earn from the public. */
	released: boolean;
}

/**
 * Eligibility, keyed on the **Work** — which is what actually earns.
 *
 * This got simpler with the model rather than merely moving: a post could hold many
 * content elements of different types, so "what does this earn?" was a set gathered
 * across a join. A Work has exactly one type, so it is one lookup. The asymmetry the old
 * version existed to enforce — prose in a post BODY earns nothing while the same prose as
 * a content element earns — is now structural: prose that earns is a Work of type `text`,
 * and a post body is an announcement.
 */
async function loadWorkEligibility(
	workIds: number[],
	viewerId: number | null,
	sharedBy: number | null = null,
): Promise<Map<number, WorkEligibility>> {
	const byId = new Map<number, WorkEligibility>();
	if (workIds.length === 0) return byId;

	const workRows = await db.select().from(works).where(inArray(works.id, workIds));
	if (workRows.length === 0) return byId;

	const ctx = await buildAccessContext(viewerId, {
		workIds: workRows.map((w) => w.id),
		sharedBy,
	});
	for (const work of workRows) {
		const earns = new Set<AttentionEventType>();
		if (isTimePoolEligible(work.type)) earns.add(eventTypeFor(work.type));
		const access = resolveAccessSync(work as AccessibleWork, ctx);
		byId.set(work.id, {
			creatorId: work.creatorId,
			earns,
			accessible: access.canAccess,
			released: work.visibility === "released",
			// Public Access = ungated, streaming, free to everyone. `isFree` is exactly
			// "an allowed baseline row at price 0", so the definition is the resolver's
			// rather than a second copy of it. Stamped per event because a Work's access
			// can change later and today's answer must not be applied to last week's
			// seconds — see the column note on `attention_events.public_access`.
			//
			// A creator's own watching is excluded here rather than by the meter: `owner`
			// reports `isFree: false`, so their seconds never carry the flag and never
			// draw an allowance for consuming their own catalog.
			publicAccess:
				access.isFree &&
				work.streamEnabled &&
				work.visibility === "released" &&
				// ⚠️ **A creator sharing their OWN Work earns nothing from it**, which the owner
				// branch cannot say here: a share context has a null viewer, so `owner` never
				// fires and `isFree` comes back true. Without this the sharer's Time Pool would
				// pay the sharer, which is the same refusal `resolveAccessSync` makes for a
				// creator watching their own catalog — a pool is for buying the commons from
				// somebody else. The seconds are still recorded and still draw the relay budget,
				// because what that bounds is how much viewing one account may fund, and
				// funding it for your own work is exactly the case most in need of a bound.
				!(sharedBy != null && work.creatorId === sharedBy),
		});
	}
	return byId;
}

// ── The attributable viewer ──────────────────────────────────────────────────

/**
 * Who these seconds belong to — an account, or the **sharer** whose link a stranger followed.
 *
 * 🚨 **A session always wins over a token.** Somebody with an account spends their own
 * allowance whatever link they arrived by; otherwise a link would be a way to consume on
 * another person's meter while signed in.
 *
 * ⚠️ **The token is not checked against the Works being claimed here, and does not need to
 * be.** Eligibility is re-resolved below against a share context, so a claim naming a Work the
 * link does not cover is refused by the resolver like any other — a share context reaches
 * only universally-free work, which is the same set any recipient could already open. What
 * the token decides is *whose month pays*, and that is the sharer either way.
 */
async function attributionFor(
	c: Parameters<typeof getOptionalUserId>[0],
): Promise<{ userId: number | null; sharedBy: number | null }> {
	const userId = await getOptionalUserId(c);
	if (userId != null) return { userId, sharedBy: null };
	const token = c.req.query("share");
	if (!token) return { userId: null, sharedBy: null };
	const link = await resolveShareToken(token);
	return { userId: null, sharedBy: link?.sharerId ?? null };
}

/**
 * A session, **or** a live share link. See the note on `POST /attention` for why this
 * endpoint wants an *attributable* caller rather than a logged-in one.
 */
const requireAttributableViewer = createMiddleware(async (c, next) => {
	const token = c.req.query("share");
	if (token && (await resolveShareToken(token))) return next();
	return requireAuth(c, next);
});

/**
 * The relay budget in the ordinary meter's shape.
 *
 * The players read `remainingSeconds` and `allowed` to draw a countdown and a wall, and a
 * share-link recipient needs both for exactly the same reason a signed-in viewer does. Giving
 * them a second shape would mean a second branch in every player for a difference they should
 * never see — what ran out is *time on this link*, and the copy says so.
 */
function shareLinkBudgetAsMeter(b: ShareLinkBudget): PublicAccessBudget {
	return {
		unlimited: false,
		usedSeconds: b.usedSeconds,
		limitSeconds: b.limitSeconds,
		remainingSeconds: b.remainingSeconds,
		allowed: b.allowed,
	};
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const subscriptionRoutes = new Hono()
	// ── Anthers' Badge ladder (the display views of the seeded set) ────────────
	// The creator-ladder CRUD took `/badges` below, so the account page's Anthers-ladder
	// views — the decomposed rungs, shared with the signup page via `badgeViews()` — moved
	// here. ⚠️ Phase C should note the path change: `/subscriptions/badges` →
	// `/subscriptions/anthers-badges`.
	.get("/anthers-badges", (c) => c.json({ badges: BADGE_VIEWS }))

	// ── Current Account ──────────────────────────────────────────────────────
	// ── Public Access meter ──────────────────────────────────────────────────
	// A free account watches 10 hours of the commons a month; the Public Access price
	// given to Anthers removes the limit and nothing above it buys more. Its own endpoint because
	// it is a property of the ACCOUNT, not of any Work — a Work never reports itself
	// gated by the meter, or the commons would be stratified again.
	.get("/public-access", async (c) => {
		const userId = await getOptionalUserId(c);
		return c.json(await loadPublicAccessBudget(userId));
	})

	.get("/me", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		// What the user gives Anthers — their held Badge on the org ladder's ladder — is a
		// `user_badges` read now, wherever the billing row stands. The response shapes below
		// keep the field names the subscription page reads; the amount columns they used to
		// mirror died with the accounts split.
		const anthersSupport = await heldAnthersBadgeAmount(user.id);
		const badge = heldBadgeName(anthersSupport);
		const badgeView = badgeViewFor(anthersSupport);

		if (!acct) {
			return c.json({
				account: {
					isSelfHosting: false,
					isActive: true,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					canceledAt: null,
					directedBudget: "0.00",
				},
				anthersSupport,
				// Derived rather than typed as the literal "free": inside `c.json` a string
				// literal widens to `string`, and the RPC client then cannot see it is a
				// BadgeKey at all.
				badge,
				badgeView,
			});
		}

		return c.json({
			account: acct,
			anthersSupport,
			badge,
			badgeView,
		});
	})

	// ── Preview a monthly amount to Anthers (no charge) — powers the confirmation modal ──
	.get("/preview/:amount", requireAuth, async (c) => {
		const user = c.get("user");
		// ⚠️ **NOT `Number.isInteger`.** Amounts carry cents,
		// so an integer check here would refuse to preview any amount a creator's own
		// ladder can actually sit at.
		const target = supportAmount(c.req.param("amount"));
		if (!Number.isFinite(target) || target < 0 || target > MAX_ANTHERS_SUPPORT) {
			return c.json({ error: "Invalid amount" }, 400);
		}
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		const acct = await ensureAccount(user.id);
		// The held Anthers Badge — what "cancel" would revert and what "current support"
		// shows — reads the org ladder now, not the billing row. A row with a subscription
		// but no ladder holding yet still cancels correctly: the amount check is against
		// the holding, the subscription id against the row.
		const currentSupport = await heldAnthersBadgeAmount(user.id);

		// Cancel preview (→ 0 / Free): what you keep, and until when.
		if (target === 0) {
			if (!acct.stripeSubscriptionId || currentSupport === 0) {
				return c.json({ error: "Nothing given to Anthers to cancel" }, 400);
			}
			const sub = await retrieveSubscription(acct.stripeSubscriptionId);
			return c.json({
				isCancel: true,
				anthersSupport: 0,
				currentSupport,
				nextBillingUnix: sub ? periodEndFromSub(sub) : null,
			});
		}

		const price = target;

		// The card on file — attached when a subscription's first payment is confirmed.
		let savedCard: { id: string; brand: string; last4: string } | null = null;
		if (acct.stripeCustomerId) {
			const pms = await listCardPaymentMethods({
				customer: acct.stripeCustomerId,
				type: "card",
				limit: 1,
			});
			const pm = pms?.data[0];
			if (pm?.card) savedCard = { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
		}

		// A change to an active subscription → ask Stripe for the exact proration owed now.
		let isChange = false;
		let chargeNow = price.toFixed(2);
		let nextBillingUnix: number | null = null;
		if (acct.stripeSubscriptionId) {
			const sub = await retrieveSubscription(acct.stripeSubscriptionId);
			if (sub && (sub.status === "active" || sub.status === "trialing")) {
				isChange = true;
				const product = await ensureAnthersProduct();
				if (product) {
					// Preview only the ANTHERS line moving. Sending the whole item set would
					// price a change to every creator the user supports as well, which is not
					// what this modal is asking about.
					const existing = itemsFromSub(sub).find((i) => i.creatorId === null);
					const preview = await previewInvoice({
						customer: acct.stripeCustomerId ?? undefined,
						subscription: sub.id,
						subscription_details: {
							items: [
								{
									...(existing ? { id: existing.itemId } : {}),
									price_data: {
										currency: "usd",
										product,
										unit_amount: Math.round(target * 100),
										recurring: { interval: "month" as const },
									},
									quantity: 1,
									metadata: { destination: "anthers" },
								},
							],
							proration_behavior: "always_invoice",
						},
					});
					if (!preview) return c.json({ error: "Payments are not configured." }, 503);
					chargeNow = Math.max(0, preview.amount_due / 100).toFixed(2);
					nextBillingUnix = periodEndFromSub(sub);
				}
			}
		}
		if (!isChange) {
			// 🚨 **The 1st of next month, not a month from today.** Every account renews on the
			// 1st, so this quoted a date the subscription will not be charged on — and it is the
			// figure in the confirmation modal, which is the sentence somebody agrees to.
			// `setMonth(getMonth() + 1)` was also the overflowing form: it keeps the day of the
			// month, so a quote given on 31 January named 3 March.
			nextBillingUnix = Math.floor(cycleEnd(currentCycleKey()).getTime() / 1000);
		}

		return c.json({
			isCancel: false,
			anthersSupport: target,
			isChange,
			recurring: { amount: price.toFixed(2), interval: "month" as const },
			chargeNow,
			nextBillingUnix,
			savedCard,
		});
	})

	// ── Set the monthly support (subscribe / change / cancel) ────────────────
	.post(
		"/account",
		requireAuth,
		requireVerified,
		zValidator(
			"json",
			z.object({
				/**
				 * Monthly dollars to Anthers. **Not an integer** — there is no unit any more,
				 * and refusing $2.50 here would reimpose the granularity the Seed retirement
				 * removed. `$${PUBLIC_ACCESS_PRICE}` buys unlimited Public Access; above that
				 * is standing, never more reach.
				 */
				anthersSupport: z.number().min(0).max(MAX_ANTHERS_SUPPORT),
				/**
				 * Support pointed at creators, on the SAME charge — one subscription item
				 * each, so the invoice names them. Optional, so every existing caller (the
				 * post unlock, /subscription) keeps working untouched and simply means
				 * "nothing directed on this charge".
				 */
				directed: z
					.array(
						z.object({
							creatorId: z.number().int(),
							// 🚨 Stripe's floor, not a granularity floor. A directed amount can be
							// any level at all above it; what it cannot be is the unpayable gap
							// between zero and a charge the processor will not accept.
							amount: z.number().min(STRIPE_MIN_CHARGE).max(MAX_ANTHERS_SUPPORT),
						}),
					)
					.max(50)
					.optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { anthersSupport, directed = [] } = c.req.valid("json");
			if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

			const acct = await ensureAccount(user.id);
			const directedTotal = directed.reduce((sum, d) => sum + d.amount, 0);
			const total = anthersSupport + directedTotal;

			// Nothing at all → cancel the subscription at period end (webhook reverts).
			if (total === 0) {
				if (acct.stripeSubscriptionId) {
					await updateSubscription(acct.stripeSubscriptionId, {
						cancel_at_period_end: true,
					});
					await db
						.update(billingAccounts)
						.set({ canceledAt: new Date(), updatedAt: new Date() })
						.where(eq(billingAccounts.id, acct.id));
				}
				return c.json({ pending: false, account: await getAccount(user.id) });
			}

			/**
			 * 🚨 The one floor left, and it is a floor on the **invoice**, not on any
			 * destination.
			 *
			 * The retired $3 unit was justified by card economics — a $1 charge loses ~33%
			 * to processing — and that argument only ever supported a minimum *total*, since
			 * PR #223 made one subscription carry everything and the fixed $0.30 is paid once
			 * a month whatever the denomination. So a creator may sit at $1; a whole month's
			 * charge may not, and Stripe would refuse it anyway below $0.50.
			 */
			if (total < MIN_INVOICE_TOTAL) {
				return c.json(
					{ error: `A monthly charge has to come to at least $${MIN_INVOICE_TOTAL.toFixed(2)}.` },
					400,
				);
			}

			/**
			 * 🚨 **The Anthers line is $0 or at least $3.** $3 is what unlimited Public Access
			 * costs and it is the bottom rung of the ladder, so anything between buys a Badge's
			 * worth of nothing — no rung cleared, no meter lifted, and a supporter with no way
			 * to find that out except by comparing their account page against `/signup`.
			 *
			 * ⚠️ **It bounds the Anthers destination only, and must never be allowed to spread
			 * to `directed`.** A creator sets their own Badge levels to any chargeable amount,
			 * which is why that array keeps the lower `STRIPE_MIN_CHARGE` floor; applying $3 to
			 * both would put every creator's ladder back on a $3 step and make a $1 Badge
			 * unreachable through this route.
			 */
			if (anthersSupport > 0 && anthersSupport < PUBLIC_ACCESS_PRICE) {
				return c.json(
					{
						error: `An amount to Anthers is $0 or at least $${PUBLIC_ACCESS_PRICE}, which is what unlimited Public Access costs. Anything between buys nothing.`,
					},
					400,
				);
			}

			const product = await ensureAnthersProduct();
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");

			// A Product per creator, so each line on the invoice names who it is for.
			const creators =
				directed.length > 0
					? await db
							.select({ id: users.id, handle: users.atprotoHandle })
							.from(users)
							.where(
								inArray(
									users.id,
									directed.map((d) => d.creatorId),
								),
							)
					: [];
			const byId = new Map(creators.map((u) => [u.id, u.handle]));
			const picks: { creatorId: number; product: string; amount: number }[] = [];
			for (const d of directed) {
				const handle = byId.get(d.creatorId);
				if (!handle) return c.json({ error: "Unknown creator in the directed list" }, 400);
				picks.push({
					creatorId: d.creatorId,
					product: await ensureCreatorProduct(d.creatorId, handle),
					amount: d.amount,
				});
			}
			const items = supportItems(product, anthersSupport, picks);
			const now = new Date();

			/**
			 * Changing an active subscription, and **the two directions are separate calls**.
			 *
			 * 🚨 A raise or an added creator is charged **in full today**; a decrease or a
			 * removal waits for the 1st. `proration_behavior` is one setting for a whole
			 * update, so one call cannot express both — and the previous version made exactly
			 * that mistake in the other direction, replacing the whole item set under
			 * `always_invoice` so that lowering an amount mid-month credited the unused days
			 * back immediately. That is the everyday case of money coming back after it was
			 * already credited to a creator, which Parker's 2026-09-14 decision exists to
			 * remove.
			 *
			 * ⚠️ **Items are now changed by id rather than deleted and rebuilt.** Rebuilding
			 * gave every line a new id on every change, and a line's id is what a reduction
			 * coupon is attached to on the renewal invoice — see `services/support-reductions.ts`.
			 */
			if (acct.stripeSubscriptionId) {
				const sub = await retrieveSubscription(acct.stripeSubscriptionId);
				if (!sub) return c.json({ error: "Payments are not configured." }, 503);
				/**
				 * 🚨 **A subscription whose renewal failed is refused, never replaced.** Falling
				 * through to the create path below opened a second subscription beside the first,
				 * which Stripe would go on retrying — two charges for one person's support. The
				 * remedy is paying what is owed, which the card update in Manage Billing does.
				 */
				if (sub.status === "past_due" || sub.status === "unpaid") {
					return c.json(
						{
							error:
								"Your last payment didn't go through. Update your card in Manage Billing, and you can change your support once it has.",
							code: "payment_past_due",
						},
						409,
					);
				}
				if (sub.status === "active" || sub.status === "trialing") {
					const change = planItemChange(sub, product, anthersSupport, picks);

					// Up first, because it is the call that takes money and the one a declined
					// card should stop. A decrease that silently followed a failed raise would
					// leave somebody paying less than the page told them they had asked for.
					if (change.raises.length > 0) {
						// Prorate from the START of the period, so "the part of the month that is
						// left" is the whole of it and the line is charged in full. The days before
						// it began come off the 1st instead, recorded below.
						//
						// 🚨 **Falling back to the 1st rather than to `undefined`.** Stripe reads a
						// missing `proration_date` as *now*, which prorates the raise across the
						// days remaining and charges a sliver — the gate-for-a-day hole, arriving
						// silently through a subscription whose items happen to carry no period. A
						// wrong answer here has to fail toward charging in full.
						const periodStart =
							periodStartFromSub(sub) ??
							Math.floor(cycleStart(currentCycleKey(now)).getTime() / 1000);
						await updateSubscription(sub.id, {
							items: change.raises,
							proration_behavior: "always_invoice",
							proration_date: periodStart,
							cancel_at_period_end: false,
							// Automatic tax rides on the update too, so a subscription that
							// predates it is brought on the moment its items next change —
							// an update that omitted it would leave the old subscription
							// untaxed while its new lines carry tax codes.
							automatic_tax: { enabled: true },
							metadata: { ...sub.metadata, userId: String(user.id) },
						});
					}
					if (change.drops.length > 0) {
						await updateSubscription(sub.id, {
							items: change.drops,
							// No proration and no invoice: the price changes and the next charge
							// on the 1st is the only thing that moves. What was already paid for
							// this month stays in force — `syncSubscriptionToAccount` holds the
							// account's own amounts up to match.
							proration_behavior: "none",
							cancel_at_period_end: false,
							automatic_tax: { enabled: true },
							metadata: { ...sub.metadata, userId: String(user.id) },
						});
					}
					if (change.raises.length === 0 && change.drops.length === 0) {
						// Nothing moved — still clear a pending cancellation, which is the one
						// thing a no-op change is legitimately used for.
						await updateSubscription(sub.id, { cancel_at_period_end: false });
					}

					await recordReductions(user.id, now, change.started);
					return c.json({ pending: false, account: await getAccount(user.id) });
				}
			}

			// New subscription → create it incomplete and hand back the confirmation secret so
			// the user confirms the first payment inline; the webhook applies it on success.
			//
			// 🚨 **Automatic tax is on, with no `liability` — the platform is the tax
			// liability.** Monthly support is Anthers' own sale (it settles on Anthers'
			// account, creators are paid by transfer), and the Creator Terms promise Anthers
			// collects and remits, so the liability stays on the platform by construction.
			// Pointing it at a connected account would be both wrong and impossible here —
			// one subscription pays many creators. Stripe test mode confirmed on 2026-09-15
			// that this calculates correctly through the renewal rule, reduced renewals
			// included.
			const sub = await createSubscription({
				customer: customerId,
				items,
				automatic_tax: { enabled: true },
				// 🚨 **Backdated to the 1st, which is what puts every account on one calendar
				// cycle.** The first invoice then covers the whole month, charges in full today,
				// and lands the renewal on the 1st with no anchor arithmetic anywhere else. A
				// `billing_cycle_anchor` at the *next* 1st would have been the obvious reach and
				// is wrong in both available flavors: prorating charges a sliver, and not
				// prorating charges nothing at all until next month.
				backdate_start_date: Math.floor(cycleStart(currentCycleKey(now)).getTime() / 1000),
				payment_behavior: "default_incomplete",
				payment_settings: { save_default_payment_method: "on_subscription" },
				expand: ["latest_invoice.confirmation_secret"],
				metadata: { userId: String(user.id) },
			});
			if (!sub) return c.json({ error: "Payments are not configured." }, 503);
			await db
				.update(billingAccounts)
				.set({ stripeSubscriptionId: sub.id, updatedAt: new Date() })
				.where(eq(billingAccounts.id, acct.id));

			// Every line on a new subscription started today, so every one of them is owed the
			// days of the month before it. Recorded now rather than on activation: the charge
			// has been raised, and a subscription that never activates has its reductions
			// carried against an invoice that never arrives, which costs nothing.
			await recordReductions(user.id, now, [
				{ creatorId: null, amount: anthersSupport },
				...picks.map((p) => ({ creatorId: p.creatorId, amount: p.amount })),
			]);

			const invoice = sub.latest_invoice as
				| (Stripe.Invoice & { confirmation_secret?: { client_secret?: string } })
				| null;
			return c.json({
				pending: true,
				subscriptionId: sub.id,
				clientSecret: invoice?.confirmation_secret?.client_secret ?? null,
			});
		},
	)

	// ── Self-Hosting Toggle (creators) ───────────────────────────────────────
	/**
	 * 🚨 **Closed with a 503, deliberately, until an origin can back the claim.**
	 *
	 * This set `billing_accounts.is_self_hosting` to whatever an authenticated caller asked
	 * for, asserting nothing about whether they host anything — a creator-facing money input
	 * whose precondition was *claimed rather than observed*. What makes closing it the
	 * right move rather than a deferral is that the flag currently prices **nothing**: no
	 * code path bills a creator for storage at all, `SELF_HOST_FEE` has been `0` since
	 * 2026-08-12, and no UI anywhere calls this endpoint.
	 *
	 * ⚠️ And its one live effect is **inverted** — it costs the claimant money rather than
	 * saving it. `calculate-crf` reads the flag, gets a zeroed hosting cost from
	 * `estimateStorageCost`, and its `earnings.gte(hostingCost)` test then passes for
	 * everyone (earnings are never negative), so it records a zero subsidy and moves on.
	 * Setting this flag today makes a creator permanently ineligible for the hosting
	 * subsidy. A 503 removes a footgun; it does not withhold a feature.
	 *
	 * **The eventual shape is not a better-guarded setter.** The flag should be DERIVED
	 * from origin registration — a creator is self-hosting if and only if the hub knows a
	 * registered origin of theirs — which is milestone 1 of Creator-Hosted Delivery. So do
	 * not build a verification mechanism here in the meantime: there is nothing to verify
	 * against, and anything built now is replaced by that registration. When it lands, this
	 * stops being a setter and the column stops being a claim.
	 */
	.post(
		"/self-hosting",
		requireAuth,
		zValidator("json", z.object({ enabled: z.boolean() })),
		async (c) =>
			c.json(
				{
					error:
						"Self-hosting cannot be set here. It will be derived from a registered origin once creator-hosted delivery ships.",
				},
				503,
			),
	)

	// ── Cancel (revert to Free at period end) ────────────────────────────
	.post("/cancel", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		// What they give Anthers is the held Badge on the org ladder; the amount columns
		// this check used to read died with the accounts split.
		if (!acct || (await heldAnthersBadgeAmount(user.id)) === 0) {
			return c.json(
				{ error: "You are not supporting Anthers, so there is nothing to cancel" },
				400,
			);
		}
		// Refuse outright when payments aren't configured, like the other seven payment
		// routes. This used to be `if (stripe && …)`, which silently SKIPPED Stripe and
		// mutated the DB anyway — recording a cancellation locally that never reached
		// Stripe, so billing would keep charging a user the UI showed as canceled. That was
		// filed as harmless while prod carried no Stripe config; prod now runs Stripe in
		// test mode, so the guard is doing real work.
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// Cancel at period end — the support keeps working until the cycle ends, then the
		// subscription.deleted webhook reverts to Free. An account with no Stripe subscription
		// (nothing to cancel remotely) still cancels locally: the flag is its whole state.
		if (acct.stripeSubscriptionId) {
			await updateSubscription(acct.stripeSubscriptionId, { cancel_at_period_end: true });
		}
		await db
			.update(billingAccounts)
			.set({ canceledAt: new Date() })
			.where(eq(billingAccounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Resume ───────────────────────────────────────────────────────────────
	.post("/resume", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct?.canceledAt) {
			return c.json({ error: "No canceled subscription to resume" }, 400);
		}
		// Same guard as cancel — see the note there on why `if (stripe && …)` was wrong.
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		if (acct.stripeSubscriptionId) {
			await updateSubscription(acct.stripeSubscriptionId, { cancel_at_period_end: false });
		}
		await db
			.update(billingAccounts)
			.set({ canceledAt: null })
			.where(eq(billingAccounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Billing Portal ───────────────────────────────────────────────────────
	.post("/billing-portal", requireAuth, async (c) => {
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);
		const user = c.get("user");
		const customerId = await ensureStripeCustomer(user.id, user.email);
		const base =
			process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000";
		const session = await createBillingPortalSession({
			customer: customerId,
			return_url: `${base}${STRIPE_RETURN_PATHS.billingPortalReturn}`,
		});
		if (!session?.url) return c.json({ error: "Payments are not configured." }, 503);
		return c.json({ portalUrl: session.url });
	})

	// ── Time (Attention) Events ──────────────────────────────────────────────
	/**
	 * 🚨 **`requireAuth` became `requireAttributableViewer` on 2026-08-28, and the name is the
	 * whole argument.** This endpoint is where time turns into money, so what it has always
	 * needed is not a *logged-in* caller but an *attributable* one — somebody a creator can be
	 * paid on behalf of. An account is the ordinary way to be that. A **share link** is the
	 * other way: the viewer is a stranger we deliberately did not ask to sign up, and the time
	 * is attributed to whoever shared the link, who does have an account.
	 *
	 * ⚠️ **Which is also why the exception cannot leak into access.** The rows written below
	 * carry the sharer's `user_id` and `via_share_link: true`; the *entitlement* question was
	 * already answered by `resolveAccessSync` against a null viewer, so nothing a link carries
	 * can open gated or Adult work. See `services/share-links.ts`.
	 */
	.post(
		"/attention",
		requireAttributableViewer,
		zValidator(
			"query",
			z.object({
				/** A **share link** token — see `attributionFor`. Declared so the client can send it. */
				share: z.string().optional(),
			}),
		),
		zValidator(
			"json",
			z.object({
				events: z
					.array(
						z.object({
							creatorId: z.number().int(),
							eventType: z.enum(["page_view", "play", "watch", "read", "listen"]),
							/**
							 * Duration of the range in seconds, as reported. Zero is a visit
							 * ping (no time claimed). A claimed range carries `startedAt`/`endedAt`.
							 */
							durationSeconds: z.number().int().min(0).max(MAX_RANGE_SECONDS).default(0),
							workId: z.number().int().optional(),
							/**
							 * Time is recorded as RANGES rather than durations: when this activity
							 * started and ended, in real time. Required when `durationSeconds > 0`;
							 * bounded server-side below (nothing after it was received, nothing
							 * earlier than a flush could have covered).
							 */
							startedAt: z.number().int().positive().optional(),
							endedAt: z.number().int().positive().optional(),
							/**
							 * A stable per-range id, so a retried flush is recognized as the same
							 * range rather than counted twice. Required when `durationSeconds > 0`.
							 */
							clientId: z.string().max(128).optional(),
							// The evidence on which the claim was judged live, reported for the record.
							tabVisible: z.boolean().optional(),
							elementVisible: z.boolean().optional(),
							playing: z.boolean().optional(),
							surface: z.string().max(64).optional(),
							device: z.string().max(64).optional(),
						}),
					)
					.max(50),
			}),
		),
		async (c) => {
			const { userId, sharedBy } = await attributionFor(c);
			// The account the seconds are recorded against. For a share-link view that is the
			// sharer — which is what makes the time attributable at all, and the Time Pool
			// cannot pay a creator for time it cannot attribute to anybody.
			const attributedTo = userId ?? sharedBy;
			if (attributedTo == null) return c.json({ error: "Authentication required" }, 401);
			const viaShareLink = userId == null;
			const { events } = c.req.valid("json");

			if (events.length === 0) {
				return c.json({ recorded: 0, ineligible: 0, malformed: 0 });
			}

			// Eligibility, re-decided server-side. A zero-duration event carries no time
			// and cannot over-credit, so visit pings pass through untouched — they are
			// deliberately the analytics signal for surfaces that earn nothing.
			//
			// A CLAIMED RANGE (durationSeconds > 0) must carry its client-supplied time
			// window, because that window is the record: the equal-time principle is
			// enforced by splitting overlapping ranges on read, which needs the range's
			// real start and end. Three bounds, all against facts rather than claims:
			//   1. `startedAt < endedAt` — a range is an interval, not a moment.
			//   2. `endedAt <= now` — nothing ends in the future.
			//   3. `startedAt >= now - RANGE_LOOKBACK_SECONDS` — nothing starts earlier
			//      than an honest flush could have covered; a forged request can claim
			//      at most the lookback, never settled history.
			const receivedAt = Date.now();
			const earliestStart = receivedAt - RANGE_LOOKBACK_SECONDS * 1_000;
			const timed = events.filter((e) => e.durationSeconds > 0);
			const malformed = timed.filter(
				(e) =>
					e.startedAt == null ||
					e.endedAt == null ||
					e.clientId == null ||
					e.startedAt >= e.endedAt ||
					e.endedAt > receivedAt ||
					e.startedAt < earliestStart,
			);
			if (malformed.length > 0) {
				console.warn(
					`attention ranges: ${viaShareLink ? `a share link of user ${attributedTo}` : `user ${attributedTo}`} sent ${malformed.length} range(s) outside the bounds a flush could honestly cover — dropped`,
				);
			}
			const wellFormed = events.filter((e) => e.durationSeconds <= 0 || !malformed.includes(e));

			// Anything claiming *time* then has to earn it, against four checks:
			//
			//   1. It names a Work. A claim with no Work context is connective tissue by
			//      definition (a post body, a profile, discovery) and those earn nothing.
			//   2. That Work exists and has been released — private staging isn't
			//      consumption, so it cannot be consumed by the public.
			//   3. The claimed creator really is the Work's creator — otherwise the
			//      attribution is simply forged.
			//   4. The Work's type earns this event type, and the viewer can actually
			//      access it.
			const eligibility = await loadWorkEligibility(
				[
					...new Set(
						wellFormed
							.filter((e) => e.durationSeconds > 0)
							.map((e) => e.workId)
							.filter((id): id is number => id != null),
					),
				],
				userId,
				sharedBy,
			);

			const eligible = wellFormed.filter((e) => {
				if (e.durationSeconds <= 0) return true;
				if (e.workId == null) return false;
				const work = eligibility.get(e.workId);
				if (!work) return false;
				if (work.creatorId !== e.creatorId) return false;
				if (!work.released && work.creatorId !== userId) return false;
				return work.accessible && work.earns.has(e.eventType);
			});

			const ineligible = events.length - eligible.length - malformed.length;
			if (ineligible > 0) {
				console.warn(
					`attention eligibility: ${viaShareLink ? `a share link of user ${attributedTo}` : `user ${attributedTo}`} submitted ${ineligible} of ${events.length} events that no Work entitles them to — dropped`,
				);
			}

			if (eligible.length === 0) {
				return c.json({ recorded: 0, ineligible: events.length, malformed: malformed.length });
			}

			// Rows are written as REPORTED — ground truth, with no split applied here.
			// The even split across tabs and devices happens on read, over the union of
			// this account's ranges (`splitOverlappingRanges`), so the stored record stays
			// lossless and a late-arriving range re-splits what it overlaps. Nothing a
			// client sends can make the credited total exceed real elapsed time, because
			// that is a read-side property of the split, not an intake check.
			const rows = eligible.map((e) => ({
				userId: attributedTo,
				creatorId: e.creatorId,
				eventType: e.eventType,
				durationSeconds: e.durationSeconds,
				workId: e.workId ?? null,
				// Zero-duration visit pings carry no Work and draw nothing, so they are
				// never Public Access consumption whatever they point at.
				publicAccess: e.workId != null && (eligibility.get(e.workId)?.publicAccess ?? false),
				viaShareLink,
				startedAt: e.startedAt != null ? new Date(e.startedAt) : null,
				endedAt: e.endedAt != null ? new Date(e.endedAt) : null,
				clientId: e.clientId ?? null,
				tabVisible: e.tabVisible ?? null,
				elementVisible: e.elementVisible ?? null,
				playing: e.playing ?? null,
				surface: e.surface ?? null,
				device: e.device ?? null,
			}));

			// The unique index on (user_id, client_id) makes a retried flush idempotent:
			// the second delivery of a batch conflicts on the ranges already recorded and
			// records only the ones it had not. `DO NOTHING` rather than an error, because
			// a retried honest flush is ordinary — the queue requeues on any failure.
			await db.insert(attentionEvents).values(rows).onConflictDoNothing();

			// The budget AFTER this batch, so a player can stop at the limit rather than
			// discovering it on the next playlist request. Returned on every write because
			// the client has no other cheap way to know it is close.
			//
			// A share-link recipient is told about the **relay** budget instead, in the same
			// shape so the players need no second branch — and without a reading of the
			// sharer's own ten hours, which are nobody else's business.
			const budget = viaShareLink
				? shareLinkBudgetAsMeter(await loadShareLinkBudget(attributedTo))
				: await loadPublicAccessBudget(attributedTo);

			return c.json({
				recorded: rows.length,
				ineligible: events.length - eligible.length,
				malformed: malformed.length,
				publicAccess: budget,
			});
		},
	)

	// ── Time Summary ─────────────────────────────────────────────────────────
	.get("/attention/summary", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? currentCycleKey();

		// The window this cycle covers. Both ends come from the shared module: a
		// `new Date("YYYY-MM-01T00:00:00")` with no zone is parsed as LOCAL midnight, so the
		// window was offset from the UTC-keyed rows it is querying by the machine's offset.
		const cycleFrom = cycleStart(cycle);
		const cycleTo = cycleEnd(cycle);

		// Ranges split on read: the person's real seconds, never more than elapsed time.
		// Overlap, not containment — a range straddling the cycle's edge contributes
		// its in-window share, which the split clips. Goes through the same helper as
		// every other reader, so "time spent" means one thing everywhere.
		const [totalSeconds, eventRows] = await Promise.all([
			creditedSeconds(user.id, cycleFrom, cycleTo),
			db
				.select({ id: attentionEvents.id })
				.from(attentionEvents)
				.where(
					and(
						eq(attentionEvents.userId, user.id),
						gte(attentionEvents.createdAt, cycleFrom),
						lte(attentionEvents.createdAt, cycleTo),
					),
				),
		]);

		return c.json({
			hoursUsed: Number((totalSeconds / 3600).toFixed(2)),
			eventCount: eventRows.length,
			cycleStart: cycle,
		});
	})

	// ── The Person's Own Activity History ───────────────────────────────────────
	/**
	 * A person's own attention ranges, newest first — exactly the stored record.
	 *
	 * This is the account-settings answer to "what do you hold about what I watch":
	 * the ranges as reported, with their evidence, unsplit and unsurprised. It paged
	 * rather than windowed because the point is inspection, not a total.
	 */
	.get("/attention/history", requireAuth, async (c) => {
		const user = c.get("user");
		const page = Math.max(0, Number(c.req.query("page") ?? 0));
		const pageSize = 50;

		const rows = await db
			.select({
				id: attentionEvents.id,
				creatorId: attentionEvents.creatorId,
				workId: attentionEvents.workId,
				eventType: attentionEvents.eventType,
				durationSeconds: attentionEvents.durationSeconds,
				startedAt: attentionEvents.startedAt,
				endedAt: attentionEvents.endedAt,
				tabVisible: attentionEvents.tabVisible,
				elementVisible: attentionEvents.elementVisible,
				playing: attentionEvents.playing,
				surface: attentionEvents.surface,
				device: attentionEvents.device,
				workTitle: works.title,
				workSlug: works.slug,
				workPublicId: works.publicId,
			})
			.from(attentionEvents)
			.leftJoin(works, eq(attentionEvents.workId, works.id))
			.where(and(eq(attentionEvents.userId, user.id), sql`${attentionEvents.durationSeconds} > 0`))
			.orderBy(sql`${attentionEvents.startedAt} DESC NULLS LAST, ${attentionEvents.createdAt} DESC`)
			.limit(pageSize)
			.offset(page * pageSize);

		return c.json({
			entries: rows.map((r) => ({
				...r,
				url:
					r.workPublicId != null && r.workSlug != null
						? `/works/${r.workSlug}-${r.workPublicId}`
						: null,
			})),
			page,
			hasMore: rows.length === pageSize,
		});
	})

	// ── Pool Distributions (subscriber view) ─────────────────────────────────
	.get("/distributions", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? currentCycleKey();

		const result = await db
			.select({
				distribution: poolDistributions,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(poolDistributions)
			// LEFT, not inner: `creator_id` is nullable since migration `0031`, because this
			// row is a payment record that outlives the accounts on either side of it. An
			// inner join would silently drop a distribution whose creator has since deleted
			// their account — making Privacy Policy's "one record survives" true in the database and
			// false on the page, which is the same failure shape as the feed dropping
			// tombstoned posts.
			.leftJoin(users, eq(poolDistributions.creatorId, users.id))
			.where(
				and(eq(poolDistributions.subscriberId, user.id), eq(poolDistributions.billingCycle, cycle)),
			)
			.orderBy(
				desc(
					sql`CAST(${poolDistributions.poolAmount} AS numeric) + CAST(${poolDistributions.badgeAmount} AS numeric)`,
				),
			);

		return c.json({
			distributions: result.map((r) => ({
				...r.distribution,
				creator: {
					handle: r.creatorHandle,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
			})),
		});
	})

	// ── Creator Earnings ─────────────────────────────────────────────────────
	.get("/earnings", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? currentCycleKey();

		const [earnings] = await db
			.select({
				poolTotal: sql<string>`COALESCE(SUM(CAST(pool_amount AS numeric)), 0)`,
				badgeTotal: sql<string>`COALESCE(SUM(CAST(badge_amount AS numeric)), 0)`,
				subscriberCount: sql<number>`COUNT(DISTINCT subscriber_id)::int`,
				estimateRows: sql<number>`COUNT(*) FILTER (WHERE settled_at IS NULL)::int`,
			})
			.from(poolDistributions)
			.where(
				and(eq(poolDistributions.creatorId, user.id), eq(poolDistributions.billingCycle, cycle)),
			);

		const total = (Number(earnings.poolTotal) + Number(earnings.badgeTotal)).toFixed(2);

		// The transfer split, beside the month's figures: what settlement has credited
		// that is still held (no coverage row names it) and what has already moved into
		// the connected account. Both are lifetime totals, not per-cycle — a credit's
		// hold and transfer are about when it settled, not the month it was earned in,
		// so the two figures this surface exists to show do not follow the `cycle` param.
		const covered = db
			.selectDistinct({ creditId: creatorTransferCredits.creditId })
			.from(creatorTransferCredits);
		const [split] = await db
			.select({
				heldTotal: sql<string>`COALESCE(SUM(${creatorCredits.amount}), 0)`,
			})
			.from(creatorCredits)
			.where(and(eq(creatorCredits.creatorId, user.id), notInArray(creatorCredits.id, covered)));
		const [moved] = await db
			.select({
				transferredTotal: sql<string>`COALESCE(SUM(${creatorTransfers.amount}), 0)`,
			})
			.from(creatorTransfers)
			.where(eq(creatorTransfers.creatorId, user.id));

		// The netting figures (Parker, 2026-09-14, "Money That Came Back"): what of this
		// creator's share of returned money has been recovered from their earnings
		// (`nettedTotal`), and what is still open (`nettingOpenTotal`) — the two figures
		// that make the held number honest, because a held credit a netting has consumed
		// will transfer nothing even though it still reads as held. Both lifetime totals,
		// like the held and transferred figures beside them. The open figure is the
		// REMAINING (amount minus what was applied), not the rows' amounts — an exhausted
		// netting is not open, the same derivation `openNettingFor` applies.
		const [netted] = await db
			.select({
				nettedTotal: sql<string>`COALESCE(SUM(${creatorNettingApplications.amount}) FILTER (
					WHERE ${creatorNettingApplications.reversedAt} IS NULL
				), 0)`,
				openedTotal: sql<string>`COALESCE(SUM(${creatorNettings.amount}), 0)`,
			})
			.from(creatorNettings)
			.leftJoin(
				creatorNettingApplications,
				eq(creatorNettingApplications.nettingId, creatorNettings.id),
			)
			.where(and(eq(creatorNettings.creatorId, user.id), isNull(creatorNettings.reversedAt)));

		return c.json({
			poolTotal: earnings.poolTotal,
			badgeTotal: earnings.badgeTotal,
			total,
			subscriberCount: Number(earnings.subscriberCount),
			cycle,
			/**
			 * 🚨 **Whether these figures are money or an estimate.** A month is estimated nightly
			 * from what supporters give today and credited once it ends from what they actually
			 * paid, so the two can differ; a page showing the running month must say which it is.
			 */
			settled: Number(earnings.estimateRows) === 0 && Number(earnings.subscriberCount) > 0,
			/**
			 * Settled money that has not yet been transferred into the connected account —
			 * held behind its own 14-day hold or the account's readiness, and still owed.
			 * The figure the Studio shows beside "estimated/settled" so a creator can see
			 * the money that is theirs but not yet in their Stripe balance.
			 */
			heldTotal: new Decimal(split.heldTotal).toFixed(2),
			/** Money already transferred into the connected account, read from the coverage rows. */
			transferredTotal: new Decimal(moved.transferredTotal).toFixed(2),
			/**
			 * What was recovered from this creator's earnings for sales that came back — a
			 * refund or chargeback after the money had reached them. Never a bill: recovery
			 * only ever came from earnings that were still held, and a won dispute's
			 * reversal hands back what was recovered.
			 */
			nettedTotal: new Decimal(netted.nettedTotal).toFixed(2),
			/**
			 * The not-yet-recovered remainder of returned money — still open against future
			 * earnings. Shown beside the netted figure so a creator can see the whole
			 * record, not only the part that has landed.
			 */
			nettingOpenTotal: Decimal.max(
				0,
				new Decimal(netted.openedTotal).minus(new Decimal(netted.nettedTotal)),
			).toFixed(2),
		});
	})

	// ── The user's own Badge holdings ────────────────────────────────────────
	// What this user holds this cycle: one discrete Badge per creator. The budget is
	// the balance the user holds this cycle to direct at creators — what the
	// subscription's directed items add up to, which is the webhook-synced
	// `billing_accounts.directed_budget` — and Anthers takes no cut of it. Holding a
	// creator's Badge clears that creator's gates at the Badge's threshold and below.
	// (What actually reaches the creator is net of the threshold's pro-rata share of
	// the at-cost card fee — see the discrepancy note in `distribute-pool.ts`.)
	.get("/my-badges", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? currentCycleKey();

		const result = await db
			.select({
				badge: badges,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				holding: userBadges,
			})
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.innerJoin(users, eq(users.id, badges.creatorId))
			.where(and(eq(userBadges.userId, user.id), eq(userBadges.billingCycle, cycle)));

		const budget = await directedBudgetFor(user.id);
		const allocated = result.reduce((sum, r) => sum + Number(r.badge.threshold), 0);

		return c.json({
			badges: result.map((r) => ({
				id: r.badge.id,
				threshold: r.badge.threshold,
				label: r.badge.label,
				description: r.badge.description,
				artShape: r.badge.artShape,
				artColor: r.badge.artColor,
				artEmblem: r.badge.artEmblem,
				hasArt: Boolean(r.badge.artKey),
				billingCycle: r.holding.billingCycle,
				createdAt: r.holding.createdAt,
				creator: {
					handle: r.creatorHandle,
					displayName: r.creatorDisplayName,
				},
			})),
			budget: budget.toFixed(2),
			allocated: allocated.toFixed(2),
			remaining: (budget - allocated).toFixed(2),
		});
	})

	.post(
		"/my-badges",
		requireAuth,
		requireVerified,
		zValidator(
			"json",
			z.object({
				/** The Badge to hold — a discrete pick, not an amount. */
				badgeId: z.number().int().positive(),
				cycle: z
					.string()
					.regex(/^\d{4}-\d{2}-01$/)
					.optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { badgeId, cycle: requestedCycle } = c.req.valid("json");
			const currentCycle = currentCycleKey();
			const cycle = requestedCycle ?? currentCycle;

			// Only allow editing current or next month.
			const nextCycle = nextCycleKey(currentCycle);

			if (cycle !== currentCycle && cycle !== nextCycle) {
				return c.json({ error: "Can only pick Badges for the current or next billing cycle" }, 400);
			}

			const budget = await directedBudgetFor(user.id);

			if (budget <= 0) {
				return c.json({ error: "You have nothing to give this cycle" }, 400);
			}

			// The Badge itself: its threshold is the amount this pick directs, and the
			// route never takes a number from the request — the pick names the rung.
			const [badge] = await db.select().from(badges).where(eq(badges.id, badgeId)).limit(1);
			if (!badge) return c.json({ error: "No such Badge" }, 404);
			if (badge.creatorId === user.id) {
				return c.json({ error: "You cannot hold your own Badge" }, 400);
			}
			const amountNum = Number(badge.threshold);

			// Current month: a holding locks — a viewer may move up this cycle, never down.
			if (cycle === currentCycle) {
				const [existing] = await db
					.select({ threshold: badges.threshold })
					.from(userBadges)
					.innerJoin(badges, eq(badges.id, userBadges.badgeId))
					.where(
						and(
							eq(userBadges.userId, user.id),
							eq(badges.creatorId, badge.creatorId),
							eq(userBadges.billingCycle, cycle),
						),
					)
					.limit(1);

				if (existing && amountNum < Number(existing.threshold)) {
					return c.json(
						{ error: "Cannot reduce what you have already given in this billing cycle" },
						400,
					);
				}
			}

			// Check total allocated (excluding this creator's holding) against the budget.
			const [currentAllocated] = await db
				.select({
					total: sql<string>`COALESCE(SUM(${badges.threshold}), 0)`,
				})
				.from(userBadges)
				.innerJoin(badges, eq(badges.id, userBadges.badgeId))
				.where(
					and(
						eq(userBadges.userId, user.id),
						eq(userBadges.billingCycle, cycle),
						sql`${badges.creatorId} != ${badge.creatorId}`,
					),
				);

			const otherAllocated = Number(currentAllocated.total);
			if (otherAllocated + amountNum > budget) {
				return c.json({ error: "Exceeds what you are giving this cycle" }, 400);
			}

			// 🚨 **One holding per issuer per cycle — the pick REPLACES the issuer's other
			// rungs rather than sitting beside them.** The "cannot reduce" check above
			// already assumes the shape (a viewer raising $3 → $6 has ONE holding, at $6),
			// and the access/distribution reads enforce it defensively with MAX(threshold).
			// An insert that left the old rung beside the new one would overstate the
			// allocation against the cycle's budget — the e2e walk hit exactly that, ending
			// a $3 → $21 climb holding $39 of rungs — while reading right only because
			// every reader takes the max. Delete the issuer's other holdings for this
			// cycle, then upsert the picked one.
			await db
				.delete(userBadges)
				.where(
					and(
						eq(userBadges.userId, user.id),
						eq(userBadges.billingCycle, cycle),
						ne(userBadges.badgeId, badgeId),
						sql`${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${badge.creatorId})`,
					),
				);

			// Upsert the holding. The unique key is (user, badge, cycle), so a repeated pick
			// of the same rung is a no-op.
			await db
				.insert(userBadges)
				.values({
					userId: user.id,
					badgeId,
					billingCycle: cycle,
				})
				.onConflictDoUpdate({
					target: [userBadges.userId, userBadges.badgeId, userBadges.billingCycle],
					set: { updatedAt: new Date() },
				});

			return c.json({ success: true });
		},
	)

	// ── Creator Badges — the ladder a creator defines ─────────────────────────
	.get("/badges", async (c) => {
		const creatorHandle = c.req.query("creator");

		if (!creatorHandle) {
			// If no creator specified, require auth and return own ladder
			const userId = await getOptionalUserId(c);
			if (!userId) return c.json({ error: "Unauthorized" }, 401);

			const rows = await db
				.select()
				.from(badges)
				.where(eq(badges.creatorId, userId))
				.orderBy(badges.sortOrder, badges.threshold);

			return c.json({ badges: rows.map(publicBadge) });
		}

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.atprotoHandle, creatorHandle))
			.limit(1);
		if (!creator) return c.json({ error: "Creator not found" }, 404);

		const rows = await db
			.select()
			.from(badges)
			.where(eq(badges.creatorId, creator.id))
			.orderBy(badges.sortOrder, badges.threshold);

		return c.json({ badges: rows.map(publicBadge) });
	})

	.post(
		"/badges",
		requireAuth,
		zValidator(
			"json",
			z.object({
				// 🚨 Monthly DOLLARS (migration `0041`) — what is given to this creator. It was
				// `/^\d+$/` (digits only) until 2026-08-16 on the reasoning that a fractional
				// gate was one no viewer could exactly meet, since Seeds were indivisible. The
				// unit went and so did the reasoning: refusing "9.50" now rejects the levels a
				// creator is most likely to set. Cents, because that is what can be charged.
				// 🚨 And floored at Stripe's minimum, because a Badge level is a level of
				// monthly support somebody has to be able to fund. `directed[].amount` refuses
				// anything between zero and that floor, so a $0.25 Badge is a rung no viewer
				// can climb — the creator would find out through a supporter failing rather
				// than through their own editor.
				threshold: z
					.string()
					.regex(/^\d+(\.\d{1,2})?$/)
					.refine((v) => isChargeableAmount(Number(v)), { message: CHARGEABLE_AMOUNT_MESSAGE }),
				label: z.string().min(1).max(100),
				description: z.string().max(1000).optional().default(""),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

			const [maxRow] = await db
				.select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
				.from(badges)
				.where(eq(badges.creatorId, user.id));

			const [badge] = await db
				.insert(badges)
				.values({ creatorId: user.id, ...data, sortOrder: Number(maxRow.max) + 1 })
				.returning();

			return c.json({ badge: publicBadge(badge) }, 201);
		},
	)

	.patch(
		"/badges/:id",
		requireAuth,
		zValidator(
			"json",
			z.object({
				threshold: z
					.string()
					.regex(/^\d+(\.\d{1,2})?$/)
					.refine((v) => isChargeableAmount(Number(v)), { message: CHARGEABLE_AMOUNT_MESSAGE })
					.optional(),
				label: z.string().min(1).max(100).optional(),
				description: z.string().max(1000).optional(),
				// 🚨 Validated against `@anthers/shared/badge-art`, which is the one list the
				// web layer renders from too. A id the server accepted and the library does
				// not carry renders as nothing, with no error to explain it — so the check is
				// here rather than left to the form. `null` is how a creator goes back to the
				// default, which is why each is nullable rather than merely optional.
				artShape: z.string().refine(isBadgeShape).nullable().optional(),
				artColor: z.string().refine(isBadgeColor).nullable().optional(),
				artEmblem: z.string().refine(isBadgeEmblem).nullable().optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { id } = c.req.param();
			const data = c.req.valid("json");

			const [updated] = await db
				.update(badges)
				.set({ ...data, updatedAt: new Date() })
				.where(and(eq(badges.id, Number(id)), eq(badges.creatorId, user.id)))
				.returning();

			if (!updated) return c.json({ error: "Badge not found" }, 404);
			return c.json({ badge: publicBadge(updated) });
		},
	)

	.delete("/badges/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { id } = c.req.param();

		const deleted = await db
			.delete(badges)
			.where(and(eq(badges.id, Number(id)), eq(badges.creatorId, user.id)))
			.returning({ id: badges.id, artKey: badges.artKey });

		if (deleted.length === 0) return c.json({ error: "Badge not found" }, 404);
		// The rung is gone, so its art has nothing left to belong to. Swept after the row
		// rather than before: an object stranded by a crash is findable, while a row
		// pointing at an object we already destroyed renders a broken badge forever.
		if (deleted[0].artKey) await storage.delete(deleted[0].artKey).catch(() => {});
		return c.body(null, 204);
	})

	// ── Badge art ───────────────────────────────────────────────────────────────
	//
	// ⭐ Only the INTERIOR of the badge is uploaded. Every badge shares one round botanical
	// frame — Anthers' own Root/Sprout/Petal/Blossom already render `frame-round` with an
	// emoji inside it — and a creator's art replaces the emoji rather than the frame.
	// Parker settled the format on 2026-08-29: shared frame, free interior, because the
	// symmetry between the two ladders is most of why the model reads cleanly (30.01).
	//
	// 🚨 **Raster only, and never an SVG.** An SVG is a script-execution surface that would
	// need sanitizing before it could be rendered, and it cannot be safety-scanned as it
	// stands — PDQ hashes pixels, so an SVG would have to be rasterized before it could be
	// fingerprinted at all. Accepting one means building a sanitizer AND a rasterize-then-
	// hash step before a single badge is safe to display. Anthers' own defaults are SVG
	// through `@anthers/brand`, and the two never mix.
	.post("/badges/:id/art", requireAuth, async (c) => {
		const user = c.get("user");
		const badgeId = Number(c.req.param("id"));

		const [badge] = await db
			.select()
			.from(badges)
			.where(and(eq(badges.id, badgeId), eq(badges.creatorId, user.id)))
			.limit(1);
		if (!badge) return c.json({ error: "Badge not found" }, 404);

		const form = await c.req.formData();
		const file = form.get("file");
		if (!(file instanceof File)) return c.json({ error: "No file provided" }, 400);
		if (file.size > BADGE_ART_MAX_BYTES) {
			return c.json({ error: "That image is too large — 4 MB at most.", code: "too_large" }, 413);
		}

		// Normalized rather than stored as sent, which does four jobs at once: every badge
		// interior ends up the same square so the shared frame fits it, EXIF and any other
		// trailing payload is dropped, an SVG or a PDF fails here rather than later, and
		// what we scan is exactly what we serve.
		let normalized: Buffer;
		try {
			normalized = await sharp(Buffer.from(await file.arrayBuffer()), { failOn: "none" })
				.resize(BADGE_ART_PX, BADGE_ART_PX, { fit: "cover", position: "attention" })
				.png()
				.toBuffer();
		} catch {
			return c.json(
				{
					error: "That file is not an image we can read. PNG, JPEG or WebP.",
					code: "not_an_image",
				},
				400,
			);
		}

		const key = `creators/${user.id}/badges/${badgeId}/${crypto.randomUUID().replace(/-/g, "")}.png`;
		await storage.upload(key, normalized, "image/png", "private");

		// 🚨 Scanned INLINE, before the key is ever written to the row. Badge art is
		// user-supplied imagery on a surface other people see, so it is another ingest door
		// for the child-safety coverage map, which is deliberately not public — and unlike a Work there is no release gate behind which a queued scan
		// could catch up. The bytes are already buffered here, so there is nothing to defer.
		const outcome = await scanInlineUpload(key, { uploaderId: user.id, objectKind: "badge" });
		if (outcome.quarantine) {
			// 🚨 **The object is quarantined, never deleted, and the scanner has already done
			// it** — `quarantineObject` moved it under the quarantine prefix, wrote the
			// `media_quarantine` row and placed the § 2258A(h) hold on the uploader before
			// this line runs. Destroying it here is what the route used to do, and it was
			// backwards twice over: it discarded the one object a CyberTipline report has to
			// cite, and it made the outcome depend on where the file was going rather than on
			// what it was. Refusing the upload is still right — the creator gets no badge.
			return c.json({ error: "That image cannot be used.", code: "refused" }, 422);
		}

		const previous = badge.artKey;
		await db
			.update(badges)
			.set({ artKey: key, updatedAt: new Date() })
			.where(eq(badges.id, badgeId));
		// Only after the row points somewhere else, so a failure here strands an object
		// rather than blanking a badge.
		if (previous) await storage.delete(previous).catch(() => {});

		return c.json({ artPath: `/api/subscriptions/badges/${badgeId}/art` }, 201);
	})

	.delete("/badges/:id/art", requireAuth, async (c) => {
		const user = c.get("user");
		const badgeId = Number(c.req.param("id"));
		const [updated] = await db
			.update(badges)
			.set({ artKey: null, updatedAt: new Date() })
			.where(and(eq(badges.id, badgeId), eq(badges.creatorId, user.id)))
			.returning({ artKey: badges.artKey });
		if (!updated) return c.json({ error: "Badge not found" }, 404);
		return c.body(null, 204);
	})

	/**
	 * Serve a rung's art.
	 *
	 * ⚠️ **404 rather than a placeholder when there is no art**, because the default is the
	 * client's to draw. A default served from here would be a raster of something the brand
	 * package renders as recolor-ready SVG, and it would go stale the moment the palette
	 * moved. The client falls back; this route only ever answers with a creator's own file.
	 */
	.get("/badges/:id/art", async (c) => {
		const [badge] = await db
			.select({ artKey: badges.artKey })
			.from(badges)
			.where(eq(badges.id, Number(c.req.param("id"))))
			.limit(1);
		if (!badge?.artKey) return c.json({ error: "No art" }, 404);

		const bytes = await storage.read(badge.artKey);
		// The row names an object storage does not have. 404 so the client draws the
		// default, rather than 500 for a badge nobody can do anything about.
		if (!bytes) return c.json({ error: "No art" }, 404);

		return c.body(new Uint8Array(bytes), 200, {
			"Content-Type": "image/png",
			// Keyed by a uuid that changes on every upload, so a long cache is safe and a
			// replacement is visible immediately.
			"Cache-Control": "public, max-age=86400",
		});
	})

	// ── The supporters page ────────────────────────────────────────────────────

	/**
	 * Everybody who has ever supported Anthers and has not opted out.
	 *
	 * 🚨 **Reads the per-cycle record, never live standing.** Eligibility is having *ever*
	 * supported, so somebody who gave for three months and stopped keeps their place — a
	 * query over the held Badge (or live anything) would quietly drop them the month they
	 * stopped, which is the opposite of what the page is for.
	 *
	 * ⚠️ **The lifetime total leaves this function and never leaves the server.**
	 * `groupSupporters` is what strips it; the response carries names and an order.
	 */
	.get("/supporters", async (c) => {
		const rows = await db
			.select({
				handle: users.atprotoHandle,
				displayName: users.displayName,
				lifetime: sql<string>`COALESCE(SUM(${accountCycles.anthersSupport}), 0)`,
			})
			.from(accountCycles)
			.innerJoin(users, eq(users.id, accountCycles.userId))
			// INNER, and the join is what makes "ever supported AND opted in" one condition:
			// a user with cycles but no preferences row has answered nothing, and the column
			// default (listed) is theirs — an INNER join would drop them. LEFT JOIN plus
			// `COALESCE(listed, true)` reads the default for the row that is absent, which is
			// exactly what the eager-creatable table's default means.
			.leftJoin(userPreferences, eq(userPreferences.userId, accountCycles.userId))
			.where(sql`COALESCE(${userPreferences.listedAsSupporter}, true)`)
			.groupBy(users.id, users.atprotoHandle, users.displayName)
			.having(sql`COALESCE(SUM(${accountCycles.anthersSupport}), 0) > 0`);

		// ⚠️ **A supporter with no name at all is left off rather than rendered blank** — an
		// empty line on a thank-you page is worse than an absence, because it looks like the
		// page is broken rather than like somebody is missing. `atprotoHandle` is never null,
		// so this now only drops a row when both name fields would render as nothing.
		const named = rows.flatMap((r) => {
			const handle = r.handle;
			const displayName = r.displayName || null;
			if (!handle && !displayName) return [];
			return [{ handle, displayName, lifetimeDollars: Number(r.lifetime) }];
		});

		return c.json({ groups: groupSupporters(named) });
	})

	/**
	 * Whether this person appears there.
	 *
	 * ⭐ Listed by default and told so when they start supporting, so this is the control
	 * that notice points at rather than a setting somebody has to go looking for.
	 */
	.get("/supporters/listing", requireAuth, async (c) => {
		const user = c.get("user");
		const [prefs] = await db
			.select({ listed: userPreferences.listedAsSupporter })
			.from(userPreferences)
			.where(eq(userPreferences.userId, user.id))
			.limit(1);
		// No row yet means the user has set nothing — the column's default (listed) is the
		// answer, which is what the eager-creatable table makes an absent row mean.
		return c.json({ listed: prefs?.listed ?? true });
	})

	.patch(
		"/supporters/listing",
		requireAuth,
		zValidator("json", z.object({ listed: z.boolean() })),
		async (c) => {
			const user = c.get("user");
			const { listed } = c.req.valid("json");
			// Insert-or-update rather than an update behind a lookup: the preferences row is
			// eagerly creatable now, so a user who has never written a preference can still
			// take themselves off the page — and the old 404 ("no account") dies with the
			// row-per-user lifecycle the split gave this table.
			const [row] = await db
				.insert(userPreferences)
				.values({ userId: user.id, listedAsSupporter: listed })
				.onConflictDoUpdate({
					target: userPreferences.userId,
					set: { listedAsSupporter: listed, updatedAt: new Date() },
				})
				.returning({ listed: userPreferences.listedAsSupporter });
			return c.json({ listed: row.listed });
		},
	)
	// ── Stickers ───────────────────────────────────────────────────────────────
	//
	// A user directing part of their own Time Pool at one creator, by hand. The money is
	// not new: `distribute-pool` distributes by time only what was not directed here.

	.get("/stickers/allowance", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = await stickerCycleFor(user.id);
		if (!cycle) return c.json({ allowance: 0, directed: 0, remaining: 0, cycle: null });
		const directed = await stickersDirectedIn(user.id, cycle.billingCycle);
		return c.json({
			allowance: cycle.allowance,
			directed,
			// ⚠️ Floored: lowering a Badge mid-cycle can put `directed` above `allowance`, and
			// a negative remaining would render as a debt the user does not owe.
			remaining: Math.max(0, round2(cycle.allowance - directed)),
			cycle: cycle.billingCycle,
		});
	})

	/**
	 * The Stickers showing on one subject.
	 *
	 * ⚠️ **Public, and it publishes art and a count rather than who gave what.** A Sticker
	 * is a visible gesture, so the page has to show it — but pairing a name with a sum is
	 * a statement about somebody's finances, exactly as the supporters page reasons. The
	 * viewer's own Stickers come back identified, because you may take back only your own.
	 *
	 * 🚨 **Removed Stickers are excluded here and nowhere else.** Removal is display-only;
	 * `stickersDirectedIn` still counts them against the giver's allowance and the creator
	 * still gets paid. This endpoint is the display, so this is the one place it applies.
	 */
	.get("/stickers", async (c) => {
		const subjectType = c.req.query("subjectType") ?? "";
		const subjectId = Number(c.req.query("subjectId"));
		if (!STICKER_SUBJECTS.includes(subjectType as StickerSubject) || !Number.isInteger(subjectId)) {
			return c.json({ error: "Bad subject" }, 400);
		}
		const viewerId = await getOptionalUserId(c);
		const rows = await db
			.select({ id: stickers.id, artKey: stickers.artKey, giverId: stickers.giverId })
			.from(stickers)
			.where(
				and(
					eq(stickers.subjectType, subjectType),
					eq(stickers.subjectId, subjectId),
					isNull(stickers.removedAt),
				),
			)
			.orderBy(stickers.id);

		// Grouped by art, because a wall of twenty identical butterflies says less than
		// "twenty butterflies" and costs a page more to render.
		const byArt = new Map<string, { artKey: string; count: number; mine: number[] }>();
		for (const row of rows) {
			const key = row.artKey ?? "";
			const entry = byArt.get(key) ?? { artKey: key, count: 0, mine: [] };
			entry.count++;
			if (viewerId && row.giverId === viewerId) entry.mine.push(row.id);
			byArt.set(key, entry);
		}
		return c.json({ stickers: [...byArt.values()] });
	})

	.post("/stickers", requireAuth, zValidator("json", giveStickerSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId, artKey } = c.req.valid("json");
		// Read off the batch, never off the request — see `giveStickerSchema`. The schema
		// already refused a key that is not giveable, so this cannot be undefined.
		const amount = stickerAmount(artKey) as number;

		const cycle = await stickerCycleFor(user.id);
		if (!cycle) return c.json({ error: "No active billing cycle" }, 409);
		if (cycle.allowance <= 0) {
			return c.json(
				{ error: "A free account has no Time Pool to direct by hand.", code: "no_allowance" },
				403,
			);
		}

		const target = await stickerRecipient(user.id, subjectType, subjectId);
		if ("error" in target) return c.json({ error: target.error, code: target.code }, target.status);

		// 🚨 The cap is checked HERE and nowhere else. Once given, the money is committed —
		// removing the Sticker returns nothing — so this is the only moment it can be refused.
		const directed = await stickersDirectedIn(user.id, cycle.billingCycle);
		if (round2(directed + amount) > cycle.allowance) {
			return c.json(
				{
					error: `That is more than you have left to direct this month ($${(cycle.allowance - directed).toFixed(2)}).`,
					code: "over_allowance",
					remaining: Math.max(0, round2(cycle.allowance - directed)),
				},
				409,
			);
		}

		const [row] = await db
			.insert(stickers)
			.values({
				giverId: user.id,
				creatorId: target.creatorId,
				subjectType,
				subjectId,
				billingCycle: cycle.billingCycle,
				amount: amount.toFixed(2),
				artKey: artKey ?? null,
			})
			.returning();
		return c.json({ sticker: row }, 201);
	})

	.delete("/stickers/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Not found" }, 404);

		// ⚠️ **Sets a timestamp; never deletes the row and never touches the money.** The
		// giver was told the creator stays paid, and settlement reads `amount` alone. A
		// `DELETE` verb here is about the Sticker leaving the page, not the record leaving
		// the table — removal is a state, as everywhere else in this schema.
		const [row] = await db
			.update(stickers)
			.set({ removedAt: new Date() })
			.where(and(eq(stickers.id, id), eq(stickers.giverId, user.id), isNull(stickers.removedAt)))
			.returning();
		if (!row) return c.json({ error: "Not found" }, 404);
		return c.json({ removed: true, creatorStaysPaid: true });
	})

	// ── Content Access Check ─────────────────────────────────────────────────
	// Access lives on the Work (the two access tables); resolveAccess is the single
	// source of truth, shared with the content and payment routes.
	.get("/access/:workId", async (c) => {
		const { workId } = c.req.param();
		const currentUserId = await getOptionalUserId(c);

		const [work] = await db
			.select()
			.from(works)
			.where(eq(works.id, Number(workId)))
			.limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		const result = await resolveAccess(work, currentUserId);
		return c.json({
			access: result.canAccess,
			reason: result.reason,
			requiresPurchase: result.requiresPurchase,
			price: result.price,
			isEntitled: result.isEntitled,
			isFree: result.isFree,
			streamEnabled: result.streamEnabled,
			downloadEnabled: result.downloadEnabled,
		});
	})

	// ── Creator Status (for the creator page's Badge + holdings display) ──
	.get("/creator-status/:handle", async (c) => {
		const handle = c.req.param("handle");
		const currentUserId = await getOptionalUserId(c);

		// Look up the creator, following a stale handle to the account's current one
		// (a renamed account is still the one being asked about).
		const resolution = await resolveHandle(handle);
		const creator =
			resolution.account ??
			(resolution.redirectToHandle
				? await accountByHandle(resolution.redirectToHandle)
				: undefined);
		if (!creator) return c.json({ error: "Creator not found" }, 404);

		// Get the creator's Badge ladder
		const ladder = await db
			.select()
			.from(badges)
			.where(eq(badges.creatorId, creator.id))
			.orderBy(badges.sortOrder, badges.threshold);

		if (!currentUserId) {
			return c.json({
				badge: "free",
				badgeAmount: "0.00",
				badges: ladder.map(publicBadge),
				unlockedBadges: [],
			});
		}

		// What the viewer gives Anthers (point-in-time) and what they hold from this creator.
		const anthersSupport = await heldAnthersBadgeAmount(currentUserId);
		const badge = heldBadgeName(anthersSupport);
		const cycle = currentCycleKey();
		const [holding] = await db
			.select({ threshold: badges.threshold })
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.where(
				and(
					eq(userBadges.userId, currentUserId),
					eq(badges.creatorId, creator.id),
					eq(userBadges.billingCycle, cycle),
				),
			)
			.limit(1);

		const badgeAmount = holding?.threshold ?? "0.00";

		// Every Badge is a dollar threshold against what the viewer gives its issuer this
		// cycle — same comparison, and no conversion between units anywhere: the holding's
		// dollars are the Badge's threshold by construction, which is what removed the
		// reinterpretation hazard the retired `gate_type` enum used to encode.
		const given = supportAmount(badgeAmount);
		const unlockedBadges = ladder
			.filter((b) => amountMeets(given, Number(b.threshold)))
			.map((b) => b.id);

		return c.json({
			badge,
			badgeAmount,
			badges: ladder.map(publicBadge),
			unlockedBadges,
		});
	});

export { subscriptionRoutes };
