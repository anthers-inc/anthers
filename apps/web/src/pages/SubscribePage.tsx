// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Support page (route: /subscribe) — the middle of the funnel.
//
// Its job is to explain how support works and then open a door: a free account, or a
// monthly amount pointed at Anthers and at creators. It is NOT a report on what a user
// already holds — that is /subscription, and conflating the two is what the previous
// revision did.
//
// The page is a guided sequence, and the order is the argument:
//
//   0. **Join.** The five free inclusions as an icon row, then the signup control — an
//      address or a Bluesky handle, on a tab switcher — before the page asks for anything
//      at all. Two doors into the optional half close the section.
//   1. What support for a CREATOR does, with its breakdown, ending in a creator search.
//   2. What support for ANTHERS does, with the same breakdown, ending in a yes/no.
//   …then the one place it all adds up, with the same signup control again.
//
// ⭐ **The first section was rebuilt on 2026-08-23, and three of its changes are about
// how the section is READ rather than what it claims.** The inclusions were four bordered
// cards sitting directly above the bordered signup card, so the eye could not tell the
// list of what you get from the thing you do about it — they are an icon row now, the
// shape /about used for its governance facts. The Bluesky door was a divider and a second
// button under the email field, which made it read as an afterthought rather than as the
// other half of one choice. And the two paragraphs describing where a monthly amount can
// point are now buttons that scroll to the section that asks for it, so a reader does not
// have to hold a description in their head for two screens before meeting its control.
//
// 🚨 **Signing up moved to the TOP on 2026-08-22, and it moved for a reason about how the
// page is read rather than about what it says.** The signup control used to live only in
// the closing panel, below two sections of money — so a visitor arriving from a button
// marked "Sign Up" met an argument about supporting creators and an argument about
// supporting Anthers before finding any way in. Everything on the way down was optional
// and nothing said so early enough. Putting the door first makes the optionality
// structural instead of a claim: you can join from the first screen and never scroll.
//
// 🚨 **Support for ANTHERS must never read as the price of admission.** Parker's framing,
// and it is a product position rather than a copy preference: somebody served entirely by
// purchases, by backing creators directly, and by the free hours is using Anthers exactly
// as intended, and the page must not nudge them out of it. Hence "Only if you want to" as
// the first words of that section, and hence the free inclusions being a list at the top
// rather than a sentence somewhere in the middle.
//
// ⚠️ The free hours are stated **up front and as an inclusion**, which is the other half
// of the same instruction: a limit discovered after signing up is a surprise, and a limit
// read as a warning turns the whole list into a trial. The wiki's *How Anthers Talks About Itself* already required "free
// forever" and the cap to be co-present in the same breath; this page now does it in the
// first thing anybody sees.
//
// 🚨 **The creator ask leads and the Anthers ask follows it, and that is a product
// decision rather than a layout one.** Support for Anthers buys Public Access and nothing
// else; early visitors arrive at the invitation of a creator already here, and with few
// creators there is little Public Access to want yet. Reordering these two is a change to
// what the funnel is for — see the same note on `/`.
//
// Each step that asks something answers it in place — a `SectionEcho` under the controls,
// defaulting to *nothing chosen* — and the closing section adds the page up once. That
// replaced a sticky tray in a right-hand rail: the rail fought the one thing every other
// marketing page does, which is center a single column, and it put a choice and its
// consequence in different eyelines.
//
// The question the page asks is *whether*, never *how much*: a creator pick is
// follow-or-back rather than a stepper, because the amount is a conversation for after
// the account exists and asking it here costs conversion for no information.
//
// ⚠️ PROPOSAL vs. SHIPPED. Public Access is a proposal — the working plan is the vault's
// `90-99 Agents/Transient/Public Access Model Revamp 20260811`, and where this disagrees
// with the wiki the wiki is still right. Everything drawn from `@anthers/shared/constants`
// is real and charged against. The two figures that used to be quarantined here as a
// SPIKE — the free hours and the free-account Time Pool — are both real constants
// as of 2026-08-12 and are now read rather than typed.
//
// What is wired to real data, and what is not:
//   • The creator finder is REAL — `GET /api/accounts/creators`, whose `mediums` come from
//     what each creator has actually released rather than anything they declare.
//   • Support for ANTHERS commits for real, through the same preview + modal ceremony the
//     inline post unlock uses.
//   • Following commits for real.
//   • Support for a CREATOR rides on the SAME subscription as the Anthers one — ONE ITEM
//     PER DESTINATION, itemized, so the invoice names them. ⚠️ **Never collapse these back
//     into a quantity**: a quantity can only express whole multiples of one price, and
//     amounts are free to the cent. The split rides in subscription metadata; see
//     `anthersSupportFromSub` in services/billing.ts.
//     (`POST /subscriptions/seeds/buy` also exists as a one-off top-up of the creator
//     balance. It is not this path — a separate charge pays the fixed $0.30 twice — and
//     nothing in the UI calls it.)

import type { Badge, BadgeKey } from "@anthers/shared/constants";
import {
	amountLabel,
	BADGE_ORDER,
	badgeLabel,
	cardFeeDisplay,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	heldBadgeLabel,
	PUBLIC_ACCESS_PRICE,
	stickerBudgetFor,
	storageGibFor,
	thresholdForBadge,
	timePoolFor,
	WITHDRAWN_RESCUE_DAYS,
} from "@anthers/shared/constants";
import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import {
	EMPTY_PICKS,
	normalizePicks,
	type SignupPicks,
	supportTotal,
} from "@anthers/shared/signup";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { AnthersBadgeMark, BADGE_ART } from "@anthers/web-shared/economics";
import { FONTS } from "@anthers/web-shared/fonts";
import { displayHandle, profileUrl } from "@anthers/web-shared/profile";
import { Link, useLocation, useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import {
	ArrowDownTrayIcon,
	BanknotesIcon,
	EnvelopeIcon,
	HeartIcon,
	PlayCircleIcon,
	ServerStackIcon,
	ShieldCheckIcon,
	SparklesIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import BlueskyMark from "../components/auth/BlueskyMark";
import { storedGibPerSourceHour } from "../components/calculators/video-model";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../components/subscribe/SubscriptionPaymentModal";
import { FAQBlock } from "../components/ui/FAQ";

/* ── Free-tier figures ────────────────────────────────────────────────────────
 * Both of these were quarantined in a named `SPIKE` block until 2026-08-12, because
 * Public Access was a proposal and neither number had code behind it. Both are real
 * now and are read from the modules that own them, so this page cannot drift from the
 * meter that enforces the hours or the ledger that funds the pool.
 *
 * 🚨 `FREE_TIME_POOL` in particular is **explicitly provisional** and expected to move —
 * which is exactly why it must not be transcribed here. See its note in `constants.ts`.
 */

/** Where support for Anthers goes, at the worst case of it alone on the charge. */
const ANTHERS_PAYMENTS = cardFeeDisplay(PUBLIC_ACCESS_PRICE);
/** What a lone directed amount reaches its creator as — gross, less its share of the fee. */
const CREATOR_NET = PUBLIC_ACCESS_PRICE - ANTHERS_PAYMENTS;

/**
 * What the free creator allowance holds, in hours of video — **derived, never typed.**
 *
 * A creator's storage carries the master they uploaded plus the whole AV1 ladder Anthers
 * transcodes from it, so "50 GiB" means nothing to somebody deciding whether to publish
 * here and "6+ hours of video" means everything. The number is computed from the same
 * bitrate model `/calculators/video-storage` runs on, so the page and the calculator
 * cannot disagree, and doubling the allowance would move this sentence on its own.
 *
 * 🚨 **The framerate is the assumption to know about, and the copy does not state it.**
 * An hour at 1080p60 stores nearly twice what an hour at 1080p30 does, so this reads the
 * 30fps case: 50 GiB is about 6.7 hours at 30fps and about 4.7 at 60. The published
 * sentence says "6+ hours", which is true of a 30fps master and generous for a 60fps one.
 * If that ever needs to be the worst case rather than the common one, change the argument
 * here rather than the sentence.
 */
const FREE_VIDEO_HOURS = Math.floor(FREE_STORAGE_GIB / storedGibPerSourceHour("1080p", 30, "h264"));

/** How many creators a shuffle draws. Two rows at most, at every breakpoint. */
const HANDFUL = 6;

/** Work types, in the shape a reader recognizes. Keys are `works.type` values. */
const MEDIUMS = [
	{ key: "game", label: "Games" },
	{ key: "video", label: "Video" },
	{ key: "audio", label: "Audio" },
	{ key: "text", label: "Writing" },
] as const;

/** Picks survive a trip through signup, so nobody loses their choices to a redirect. */
const PICKS_KEY = "anthers_subscribe_picks";

/** The marketing display face, as the other marketing pages set it. */
const serif = { fontFamily: FONTS.fraunces };

/**
 * What a visitor chose, before any of it was committed.
 *
 * ⚠️ **The shape moved to `@anthers/shared/signup` on 2026-08-26**, because it stopped
 * being this page's private state: pressing *Create My Account* writes it to a pending
 * signup, and the page that finishes the job reads it back. Three boundaries, one shape —
 * the alias below is kept only so the rest of this file still reads in its own vocabulary.
 *
 * 🚨 **`anthers` is dollars, not a flag, and not nullable.** It was `boolean | null` until
 * 2026-08-24, when the section became a ladder: a boolean could only ever express the
 * Public Access price, so every rung above Root was unreachable from this page. It stopped
 * being nullable on 2026-08-25, when Free became the default (Parker) — `null` meant
 * "hasn't said", a distinction worth keeping while the section opened with nothing selected
 * and meaningless once it opens on Free.
 */
type Picks = SignupPicks;

const money = amountLabel;

function initialsOf(name: string): string {
	return (
		name
			.split(/\s+/)
			.map((w) => w[0])
			.join("")
			.replace(/[^a-z]/gi, "")
			.slice(0, 2)
			.toLowerCase() || "an"
	);
}

/** A creator's display name, falling back to the handle that always exists. */
function nameOf(creator: PublicUser): string {
	return creator.displayName || creator.username;
}

/** The step marker — numbered because the page really is a sequence. */
function StepNumber({ n }: { n: number }) {
	return (
		<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-content">
			{n}
		</span>
	);
}

/**
 * A step's heading block.
 *
 * Centered, and in the Fraunces display face at the marketing scale, because this page
 * sits in the same lineup as /for-users and /about and was reading as a different site:
 * bold sans headings hard against the left edge, while every neighboring page centers a
 * light serif inside a capped column.
 */
function StepHeading({
	n,
	title,
	children,
}: {
	n: number;
	title: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="text-center">
			<div className="mb-4 flex justify-center">
				<StepNumber n={n} />
			</div>
			<h2 style={serif} className="text-balance text-3xl font-light leading-tight sm:text-4xl">
				{title}
			</h2>
			{children && (
				<p className="mx-auto mt-4 max-w-3xl text-lg leading-relaxed text-base-content/65">
					{children}
				</p>
			)}
		</div>
	);
}

/** One segment of the support breakdown. */
interface Segment {
	amount: number;
	label: string;
	desc: string;
	tone: "pool" | "mission" | "pay";
}

const SEGMENT_BG: Record<Segment["tone"], string> = {
	pool: "bg-success/70",
	mission: "bg-info/40",
	pay: "bg-base-300",
};

/**
 * Where a month's support goes — one component, used twice.
 *
 * The two destinations are the same picture with different segments, which is what makes
 * the contrast legible without inventing a second visual language for it.
 */
function SeedBreakdown({
	segments,
	note,
	total: totalOverride,
	sizers,
}: {
	segments: Segment[];
	note: string;
	/**
	 * The other shapes this breakdown can take, rendered invisibly so its legend and its
	 * closing note are always as tall as the tallest of them.
	 *
	 * 🚨 **Same reason as the echo's `sizers` and the perk cards' stacked bodies**: the
	 * Anthers ladder switches this panel between a paid reading and a free one, and copy of
	 * different lengths moved the page under the control that changed it. At 1440px the two
	 * notes happened to wrap to the same number of lines and the defect was invisible; at
	 * 390px it was 19px. Anything that swaps this component's copy in place belongs here.
	 */
	sizers?: { segments: Segment[]; note: string }[];
	/**
	 * What the reader PAYS, when that is not the sum of the segments.
	 *
	 * 🚨 **Only Free needs this, and only because its segments describe money that is not
	 * the reader's.** A free account still pays creators through the Time Pool — Anthers
	 * funds the pot on its behalf — so the bar has something true to draw while the amount
	 * charged is $0. Everywhere else the sum IS the total and this stays unset.
	 *
	 * ⚠️ Do not reach for this to "fix" a paying breakdown that does not add up. The
	 * derivation below exists because a hardcoded total silently disagreed with the bar
	 * above it; an override used anywhere the reader is actually being charged reopens
	 * exactly that hole.
	 */
	total?: number;
}) {
	// 🚨 **Summed, never assumed.** This printed `money(PUBLIC_ACCESS_PRICE)` until
	// 2026-08-24, which was true only while the section could express one amount. With a
	// ladder above it, a hardcoded total is a number that disagrees with the bar drawn
	// directly above it — the exact class of defect `supportTotal` has a test for.
	const total = totalOverride ?? segments.reduce((sum, s) => sum + s.amount, 0);
	return (
		<div className="my-6 mx-auto max-w-4xl">
			{/* ⚠️ Zero-value segments are dropped from the BAR but kept in the legend below.
			    `flexGrow: 0` does not make a slice disappear — its `$0` label still claims
			    min-content width — so Free's two empty lines rendered as a squashed "$0$0"
			    jammed against the right edge. The legend still lists them, which is where a
			    reader learns those lines exist and are zero. */}
			<div className="flex h-11 overflow-hidden rounded-xl border border-base-content/10">
				{segments
					.filter((s) => s.amount > 0)
					.map((s) => (
						<div
							key={s.label}
							className={`grid min-w-0 place-items-center text-sm font-bold tabular-nums ${SEGMENT_BG[s.tone]}`}
							style={{ flexGrow: Math.round(s.amount * 100) }}
						>
							{money(s.amount)}
						</div>
					))}
			</div>
			{/* The legend and the note are the two things that change with the reading, so each
			    is stacked over invisible copies of every other reading it could have. */}
			<div className="mt-4 grid">
				{sizers?.map((alt) => (
					<ul
						key={alt.note}
						aria-hidden="true"
						className="invisible col-start-1 row-start-1 space-y-2.5"
					>
						{alt.segments.map((s) => (
							<SegmentLegendRow key={s.label} segment={s} />
						))}
					</ul>
				))}
				<ul className="col-start-1 row-start-1 space-y-2.5">
					{segments.map((s) => (
						<SegmentLegendRow key={s.label} segment={s} />
					))}
				</ul>
			</div>
			<div className="mt-3 flex items-baseline justify-between border-t border-base-content/10 pt-3">
				<span className="font-bold">Total</span>
				<span className="text-xl font-bold tabular-nums">{money(total)}/mo</span>
			</div>
			<p className="text-right text-xs text-base-content/45">plus any applicable tax</p>
			<div className="mt-3 grid">
				{sizers?.map((alt) => (
					<p
						key={alt.note}
						aria-hidden="true"
						className="invisible col-start-1 row-start-1 text-xs leading-relaxed text-base-content/50"
					>
						{alt.note}
					</p>
				))}
				<p className="col-start-1 row-start-1 text-xs leading-relaxed text-base-content/50">
					{note}
				</p>
			</div>
		</div>
	);
}

/**
 * How the Anthers breakdown reads at a given rung — its segments and its closing note.
 *
 * 🚨 **One function for both readings, not two literals at the call site**, because the
 * panel renders the reading you chose *and* the other one invisibly to size itself. Kept
 * inline, the sizer would have been a third copy of copy that already existed twice, and
 * the sizer is the copy nobody proofreads.
 *
 * ⚠️ Free's segments describe money that is real but is not the reader's: Anthers funds a
 * Time Pool pot on a free account's behalf, so creators are genuinely paid for that
 * account's time. They are the SAME three lines a paid rung draws, so the two readings are
 * directly comparable — and the zeroes are true, since a free account contributes nothing
 * to the remainder and has no card to process.
 */
function anthersReading(amount: number): { segments: Segment[]; note: string } {
	if (amount > 0) {
		return {
			segments: [
				{
					tone: "pool",
					amount: timePoolFor(amount),
					label: "To creators, through the Time Pool",
					desc: "split by the share of your time each one earned",
				},
				{
					tone: "mission",
					amount: amount - timePoolFor(amount) - cardFeeDisplay(amount),
					label: "Free access & programs",
					desc: "keeps other people's accounts free and funds Anthers' charitable programs",
				},
				{
					tone: "pay",
					amount: cardFeeDisplay(amount),
					label: "Payments",
					desc: "card & processing, at cost, paid to the processor",
				},
			],
			note: `${money(PUBLIC_ACCESS_PRICE)} a month lifts your monthly limit, and nothing above it buys more access — what climbs is what your time pays creators, and what keeps other people's accounts free. Shown at the worst case: this alone on the charge. Back a creator too and the fixed card fee spreads across both.`,
		};
	}
	return {
		segments: [
			{
				tone: "pool",
				amount: FREE_TIME_POOL,
				label: "To creators, through the Time Pool",
				desc: "split by the share of your time each one earned — funded by Anthers, not by you",
			},
			{
				tone: "mission",
				amount: 0,
				label: "Free access & programs",
				desc: "funded by the rungs above, which is what pays for your account",
			},
			{
				tone: "pay",
				amount: 0,
				label: "Payments",
				desc: "no card, so nothing to process",
			},
		],
		note: `A free account is charged nothing, and the creators you spend time with are still paid: Anthers puts ${money(FREE_TIME_POOL)} a month into the Time Pool on your behalf, out of what the rungs above pay in.`,
	};
}

/** One legend row, shared by the real reading and the invisible ones sizing it. */
function SegmentLegendRow({ segment }: { segment: Segment }) {
	return (
		<li className="flex items-baseline gap-2.5 text-sm">
			<span
				aria-hidden="true"
				className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm ${SEGMENT_BG[segment.tone]}`}
			/>
			<span className="leading-snug">
				<span className="text-base-content/80">{segment.label}</span>
				<span className="block text-xs text-base-content/45">{segment.desc}</span>
			</span>
			<strong className="ml-auto shrink-0 tabular-nums">{money(segment.amount)}</strong>
		</li>
	);
}

/* ── Step 3 · Anthers' own ladder ───────────────────────────────────────────── */

/**
 * Every rung's amount, in ladder order — Free's $0 included, since it is a rung here.
 *
 * 🚨 Derived from `BADGE_ORDER`, never written out. A rung added to `ANTHERS_BADGES` has to
 * grow the matrix a column, the card list a card and the echo a sizer without being told.
 */
export const RUNG_AMOUNTS = BADGE_ORDER.map(thresholdForBadge);

/** What a cell says when the rung does not carry the perk at all. */
const NOT_CARRIED = "—";

/**
 * A money figure for a matrix COLUMN, where `amountLabel`'s dropped `.00` is wrong.
 *
 * ⚠️ `amountLabel` is right in prose — *"just $3"* — and wrong stacked in a column: a Time
 * Pool row reading `$0.25 · $1.50 · $3 · $4.50 · $6` does not scan as one series, and
 * `tabular-nums` cannot align figures that are not the same shape. 20.06's own table writes
 * `$3.00`. Prices in the header still use `amountLabel`, because those are prose.
 */
const columnMoney = (amount: number) => `$${amount.toFixed(2)}`;

/**
 * What one rung carries for one perk: the figure, and a qualifier when the figure alone
 * would be a lie by omission.
 *
 * 🚨 **The `note` is what makes the card view's diff honest.** Free and Root both carry 50
 * GiB and it is not the same perk — at Free the space holds a published catalog and nothing
 * else, so an account that has never published has no storage at all until Root. Compared
 * on the figure alone, that upgrade *vanishes* from Root's card, because 50 equals 50.
 * 20.06's own table solves it the same way, with a `(creator)` / `(combined)` qualifier.
 */
interface PerkCell {
	value: string;
	note?: string;
}

interface PerkRow {
	title: string;
	desc: string;
	cell: (amount: number) => PerkCell;
}

/**
 * The confirmed perk set from 20.06 § Currently Confirmed Perks, one row per perk.
 *
 * 🚨 **Every figure is derived, and 20.06 says so in as many words**: the numbers in that
 * table are the same numbers as the sections they summarize, and neither may be edited
 * without the other. So the Sticker budget and the storage floor have real functions in
 * `constants.ts` — `stickerBudgetFor` and `storageGibFor` — rather than being read off the
 * table, and `econ:figures` fails the build on a figure typed into a page.
 *
 * ⚠️ **The Sticker denominations are deliberately not here.** 20.06 sets them at three
 * values and no constant carries them, so writing them into this copy would be the typed
 * figure the scan exists to catch. The budget is shown; what it buys can be said once
 * Stickers have a primitive to attach to.
 */
const PERK_ROWS: PerkRow[] = [
	{
		title: "Monthly Public Access",
		desc: "Streaming Works a creator has left open to everyone, rather than gated behind their own Badges or sold directly.",
		cell: (amount) => ({ value: amount > 0 ? "Unlimited" : `${FREE_PUBLIC_ACCESS_HOURS} hours` }),
	},
	{
		title: "Monthly Time Pool",
		// ⚠️ The second sentence is not decoration. A free account's pot is real money that
		// creators are really paid, and it is Anthers that pays it — a column reading "$0.25"
		// with no more said implies the free account is being charged a quarter.
		desc: "Paid out to the creators you spend time with, split by the share of your time each one earned. Anthers funds a free account's pot rather than the account paying for it.",
		cell: (amount) => ({
			value: columnMoney(timePoolFor(amount)),
			note: amount > 0 ? undefined : "from Anthers",
		}),
	},
	{
		title: "Monthly Sticker Budget",
		// ⚠️ "Held back from" rather than "on top of" — the budget is carved out of the Time
		// Pool in the row above, and what goes unspent returns to it. Two figures that
		// overlap have to say they overlap, or the matrix reads as money appearing twice.
		desc: "Held back from the Time Pool for you to attach to a like or a comment. Anything you don't spend goes back into the pool at the end of the month.",
		cell: (amount) => ({
			value: stickerBudgetFor(amount) > 0 ? columnMoney(stickerBudgetFor(amount)) : NOT_CARRIED,
		}),
	},
	{
		title: "Cloud Content Storage",
		desc: "Free storage for a catalog you publish. From Root the same space also holds your own files — cloud saves, and purchases you have kept.",
		cell: (amount) => ({
			value: `${storageGibFor(amount)} GiB`,
			note: amount > 0 ? "catalog & your files" : "catalog only",
		}),
	},
	{
		title: "Purchase Preservation",
		desc: "A Work you bought that its creator later withdrew stays in your library to download. After that, keeping a copy is yours to do.",
		cell: (amount) => ({ value: amount > 0 ? "While Badged" : `${WITHDRAWN_RESCUE_DAYS} days` }),
	},
	{
		title: "Merch Discount",
		// 20.06 leaves the size of the discount undecided, so the cell says that it exists
		// and no more. A percentage invented here would be a figure with no source.
		desc: "A discount on merch anyone can buy from the Anthers shop, where the net revenue funds Anthers' charitable programs.",
		cell: (amount) => ({ value: amount > 0 ? "Yes" : NOT_CARRIED }),
	},
	{
		title: "Our Appreciation",
		desc: "A place on the Anthers supporters page, for anyone who has ever supported Anthers.",
		cell: (amount) => ({ value: amount > 0 ? "Yes" : NOT_CARRIED }),
	},
];

/** A rung's name, with Free's — which is a rung here and not a Badge, so it has no label. */
const rungName = (key: BadgeKey) => (key === "free" ? "Free" : badgeLabel(key));

/** A rung's price, said the way the rest of the page says money. */
const rungPrice = (amount: number) => (amount === 0 ? "$0" : `${money(amount)}/mo`);

/** Whether two rungs read the same for one perk — the diff behind every card's list. */
const same = (a: PerkCell, b: PerkCell) => a.value === b.value && a.note === b.note;

/**
 * What a rung adds over the one below it.
 *
 * 🚨 **Derived by comparing rungs, never a hand-kept list per Badge.** Five lists of perks
 * beside one table of the same perks is five more places for 20.06 to drift away from, and
 * the drift would be invisible: a card that has quietly stopped mentioning the storage
 * upgrade still renders and still reads fine.
 */
export function marginalRows(amount: number, previous: number | null): PerkRow[] {
	return PERK_ROWS.filter((row) => {
		const here = row.cell(amount);
		if (here.value === NOT_CARRIED) return false;
		return previous === null || !same(here, row.cell(previous));
	});
}

/**
 * A perk's qualifier, printed only at the rung where it CHANGES.
 *
 * ⚠️ *"catalog & your files"* is true of Root, Sprout, Petal and Blossom alike, so printing
 * it four times — under four columns, or down four cards — is four copies of one fact and
 * reads as clutter. Printed under Root alone, beside Free's *"catalog only"*, it is the
 * thing that changed. Both layouts thin the *display* this way and neither thins the data:
 * `marginalRows` still compares the full cell, qualifier included, which is what keeps the
 * storage upgrade from vanishing out of Root's card on the grounds that 50 equals 50.
 */
function changedNote(row: PerkRow, amount: number, previous: number | null): string | null {
	const { note } = row.cell(amount);
	if (!note) return null;
	if (previous === null) return note;
	return note === row.cell(previous).note ? null : note;
}

/**
 * The lowest rung carrying a perk at all — the one card where its description earns space.
 *
 * ⚠️ Repeating what a Sticker Budget *is* on all four paid cards is how a five-card list
 * becomes a wall. Said once, where the perk first appears, and after that the reader is
 * looking at a figure they have already had explained.
 */
function firstRungCarrying(row: PerkRow): number {
	return RUNG_AMOUNTS.find((amount) => row.cell(amount).value !== NOT_CARRIED) ?? RUNG_AMOUNTS[0];
}

/**
 * The width at which the matrix stops being a matrix.
 *
 * 🚨 **Three terms, and the third one is the whole reason this is not just addition.** The
 * table's `min-w-[40rem]`, plus the page's `px-6` on both sides (`3rem`), plus **`2rem` of
 * slack for the scrollbar gutter**. `LoggedOutLayout` sets `scrollbar-gutter: stable` so the
 * marketing pages do not jump on navigation — and a `min-width` media query is answered by
 * the viewport, which still counts that reserved strip. Written as the exact sum of the
 * first two terms, the query matched at a window 10px narrower than the table needed and the
 * matrix scrolled by a hair at exactly one width. Slack, not arithmetic.
 *
 * ⚠️ **`table-fixed` is what makes the declared minimum the real one.** Under `auto` layout
 * a table is never narrower than its content wants, so `min-w-[46rem]` was a floor the
 * browser cheerfully ignored on the way up — it still needed ~742px, and the matrix went on
 * scrolling 74px below a breakpoint that said it fitted. Fixed layout gives the columns the
 * widths they are declared and lets the copy wrap, which is what a comparison table wants
 * anyway: equal columns, whatever length the words happen to be.
 *
 * ⚠️ **In `rem`, not `px`, so it tracks the table it is derived from.** The table's minimum
 * is in `rem` and grows with the reader's font size; a pixel breakpoint would keep promising
 * room a larger font had already spent. 🚨 Change the table's `min-w` or the page's padding
 * and this number is wrong.
 *
 * Below it, a matrix is a worse version of a list — Parker's rule (2026-08-24) is to keep
 * the matrix for as long as it works and to swap only where it does not.
 */
const MATRIX_QUERY = "(min-width: 45rem)";

const subscribeToMatrixFit = (onChange: () => void) => {
	const mql = window.matchMedia(MATRIX_QUERY);
	mql.addEventListener("change", onChange);
	return () => mql.removeEventListener("change", onChange);
};
const matrixFitsNow = () => window.matchMedia(MATRIX_QUERY).matches;
/** No window to measure: assume the matrix, which is the layout the section is designed as. */
const matrixFitsWithoutAWindow = () => true;

/**
 * ⚠️ **One layout is rendered, never both with one hidden by CSS.** Two copies would put
 * two radios per rung in the DOM: same `name` means the browser keeps one `checked` and
 * React sets both, and `getByRole("radio")` would find ten controls for five choices. A
 * media query in JS costs a `useSyncExternalStore` and removes the whole class of problem.
 */
function useMatrixFits(): boolean {
	return useSyncExternalStore(subscribeToMatrixFit, matrixFitsNow, matrixFitsWithoutAWindow);
}

interface LadderProps {
	/** The chosen rung's amount. Always one of `RUNG_AMOUNTS` — see `Picks.anthers`. */
	value: number;
	onChange: (value: number) => void;
	/** A radio group is keyed by `name`, so two on one page must not share it. */
	idPrefix: string;
}

/**
 * Anthers' Badges: every rung's perks at once, chosen by pressing the rung.
 *
 * 🚨 **A comparison rather than a panel that swaps** (Parker, 2026-08-24). Showing one
 * rung's perks at a time made the section a thing you operate in order to learn what you
 * are choosing between; a reader deciding between Sprout and Petal had to press each one
 * and hold the difference in their head. It also made the page grow and shrink under the
 * control being pressed, which took three sets of invisible sizers to hold still. Saying
 * everything always is the better fix for both, and it is why neither layout below hides
 * anything behind the selection.
 *
 * 🚨 **The rung's own card IS the chooser** (Parker, 2026-08-24). A separate row of Badge
 * cards above the table put the five names, prices and marks on the page twice, a hundred
 * pixels apart, and only one copy was a control.
 *
 * ⚠️ **Real `<input type="radio">`, not a `<div>` wearing `role="radio"`.** A native group
 * gives arrow-key navigation and one tab stop for the whole set. The `<fieldset>` and its
 * `<legend>` live here rather than in either layout: a radio group is *grouped* by `name`
 * but *named* by the legend, and a table caption does not do that job. The cost is that a
 * native radio cannot be un-checked, so once somebody has chosen there is no way back to
 * unanswered — the correct trade, since the state they can no longer reach is the one
 * meaning "hasn't looked", which stops being true the moment they press anything.
 *
 * ⚠️ **Free is lit from the first paint** (Parker, 2026-08-25). This opened with nothing
 * selected, on the reasoning that a lit rung is a claim about what somebody has picked —
 * but that left a control whose default state showed none of its five options, beside a
 * breakdown quietly previewing one of them. Free is not a claim about a choice; it is what
 * an account with no support for Anthers already is, and the section's own thesis is that
 * this is a complete answer rather than the absence of one.
 *
 * ⚠️ **No COMING pills** (Parker, 2026-08-24): most of this is designed rather than built
 * today, and all of it is meant to be built before the page is public. The ledger of what
 * exists is `constants.ts` and 20.06, not a badge on a marketing table.
 */
function BadgeLadder(props: LadderProps) {
	const fits = useMatrixFits();
	return (
		// 🚨 `min-w-0` is load-bearing, and it is a `<fieldset>` quirk rather than a flex one.
		// The UA stylesheet gives a fieldset `min-inline-size: min-content`, so it refuses to
		// shrink below the widest thing inside it — and the widest thing inside this one is a
		// table with a `min-w` on it. Without this the page itself scrolls sideways.
		<fieldset className="mx-auto mt-8 min-w-0 max-w-7xl">
			<legend className="sr-only">What to give Anthers each month</legend>
			{fits ? <BadgeMatrix {...props} /> : <BadgeCards {...props} />}
		</fieldset>
	);
}

/** The Badge's mark, drawn as `/for-users` draws it: the frame behind, the emoji inside.
 *
 *  🚨 **Free gets no mark, because a mark IS a Badge and Free is the absence of one**
 *  (Parker, 2026-08-24) — not a Badge worth $0. `BADGE_ART` is keyed by `Badge` rather than
 *  `BadgeKey`, so the caller's `key !== "free"` guard is a type error to drop. */
function BadgeMark({ badge, lit, size }: { badge: Badge; lit: boolean; size: string }) {
	return <AnthersBadgeMark badge={badge} lit={lit} size={size} />;
}

/**
 * The matrix's own surface and grid.
 *
 * 🚨 **The body needs a card of its own, and it needs the lines drawn** (Parker,
 * 2026-08-25). Without them the figures sat straight on the page background with nothing
 * tying a value to its row, which is the one thing a matrix has to do.
 *
 * ⚠️ **Every vertical rule is a `border-r`, never a `border-l` on the cell to its right.**
 * `border-separate` does not collapse adjacent borders — it stacks them — so a column
 * drawing its left edge beside a neighbor drawing its right edge is a 2px line where
 * every other rule is 1px. One side owns the line; the first column adds the card's left
 * edge because nothing sits to its left to own it.
 *
 * 🚨 **The chosen column recolours the rule on EACH side of it, which means touching its
 * left neighbor's cell.** The alternative — giving the lit column its own `border-l` — is
 * what stacks two borders, and the highlight would visibly fatten on one side only.
 *
 * ⚠️ **Two shades, not one** (Parker, 2026-08-25). The chrome — the rung tabs along the top
 * and the perk names down the side — is the frame you read *from*; the cells are the
 * figures you read. Drawn in one tone the whole thing was a flat field with lines on it,
 * and the eye had nothing telling it which way the table runs. The tabs and the row names
 * take the heavier tone because they are the axes; the cells sit lighter so a figure reads
 * against its own row rather than against the page.
 *
 * ⚠️ **Which is exactly why the outer edge had to get heavier with them** (Parker,
 * 2026-08-25). Lightening the cells to separate them from the chrome also moved them
 * closer to the page, and a card whose fill nearly matches its surroundings is held
 * together by its edge alone. So the edge is 2px against the grid's 1px, in a stronger
 * tone, and the table casts a shadow.
 *
 * 🚨 **`drop-shadow` on the TABLE, not `shadow` on anything.** A box-shadow would trace a
 * rectangle, and this control is not one: the rung tabs stand proud of the body with gaps
 * between them, and the corner above the row names is empty. `drop-shadow` follows what is
 * actually painted, so the tabs cast their own shadow and the empty corner casts none —
 * the whole ladder reads as one raised object instead of a box with bites out of it.
 */
const GRID = "border-base-content/10";
const SURFACE_CHROME = "bg-base-200/70";
const SURFACE_CELL = "bg-base-100/70";
const RAISED = "drop-shadow-[0_5px_16px_rgba(0,0,0,0.15)]";

/** The wide layout: seven perks by five rungs, chosen by the column headers. */
function BadgeMatrix({ value, onChange, idPrefix }: LadderProps) {
	// ⚠️ The chosen rung as a COLUMN INDEX rather than an amount, because the grid rules are
	// drawn by neighbor: a cell needs to know it sits immediately left of the lit column.
	// An amount off the ladder gives `-1`, which no `column` and no `column - 1` can equal,
	// so an unrecognized value lights nothing rather than lighting the wrong thing.
	const litColumn = RUNG_AMOUNTS.indexOf(value);
	return (
		// ⚠️ `overflow-x-auto` is a backstop rather than the plan — `MATRIX_QUERY` is what
		// keeps this layout to windows it fits in. It stays because "fits" is computed from a
		// declared minimum, and a reader with a very large font can still land a pixel short.
		//
		// 🚨 **`relative` is what would keep such a scroll INSIDE this box.** Every rung's
		// radio is `sr-only`, which is `position: absolute` — and an absolutely positioned
		// element is clipped by an ancestor's `overflow` only when its containing block is
		// inside that ancestor. Without a positioned box here, the five radios resolved
		// against the section instead, escaped the clip, and pushed the DOCUMENT to 710px at
		// a 390px viewport: the whole page scrolled sideways, on account of five 1px inputs.
		<div className="relative overflow-x-auto">
			<table
				className={`w-full min-w-[40rem] table-fixed border-separate border-spacing-0 text-left ${RAISED}`}
			>
				<caption className="sr-only">
					What each Anthers Badge carries, by the amount given each month. Choose one to see it
					priced below.
				</caption>
				<thead>
					<tr>
						{/* The corner names the column of row labels for a screen reader and stays
						    visually empty, which is what a matrix corner should be. */}
						<th scope="col" className="w-[36%] px-4 align-bottom">
							<span className="sr-only">Feature or perk</span>
						</th>
						{BADGE_ORDER.map((key) => {
							const amount = thresholdForBadge(key);
							const lit = value === amount;
							return (
								<th
									key={key}
									scope="col"
									// `align-middle` rather than a `h-full` flex child: the cell stretches to
									// the row and centers its own content, which is what lets Free sit level
									// with the others without a spacer standing in for art it does not have.
									//
									// ⚠️ **Every header carries a visible edge, not only the chosen one.**
									// Drawn on selection alone, the four rungs nobody has picked are
									// borderless text in a table header and read as labels rather than as the
									// control they are. Unpicked, the edge stops at the header like a tab;
									// picked, the same edge carries on down the column.
									className={`rounded-t-2xl border-x border-t p-0 text-center align-middle transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary ${
										lit
											? "border-primary/50 bg-primary/10"
											: `border-base-content/10 ${SURFACE_CHROME} hover:border-base-content/30 hover:bg-base-200/90`
									}`}
								>
									<label className="flex cursor-pointer flex-col items-center px-3 pb-3 pt-4">
										<input
											type="radio"
											name={`${idPrefix}-anthers-badge`}
											className="sr-only"
											checked={lit}
											onChange={() => onChange(amount)}
										/>
										{key !== "free" && <BadgeMark badge={key} lit={lit} size="mb-1 h-14 w-14" />}
										<span style={serif} className="block text-base font-medium">
											{rungName(key)}
										</span>
										<span className="mt-0.5 block text-sm tabular-nums text-base-content/60">
											{rungPrice(amount)}
										</span>
									</label>
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{PERK_ROWS.map((row, rowIndex) => {
						const first = rowIndex === 0;
						const last = rowIndex === PERK_ROWS.length - 1;
						// The label column owns the rule to ITS right, so it is the cell that turns
						// primary when Free — the first rung — is the one chosen.
						const labelEdgeLit = litColumn === 0;
						return (
							<tr key={row.title}>
								<th
									scope="row"
									// The card's left edge, and its top and bottom on the first and last rows:
									// 2px in a stronger tone, against the 1px `GRID` of every rule inside it.
									className={`border-l-2 border-r border-t ${GRID} border-l-base-content/30 ${SURFACE_CHROME} px-4 py-3 text-left font-normal ${first ? `rounded-tl-2xl border-t-2 border-t-base-content/30` : ""} ${last ? `rounded-bl-2xl border-b-2 border-b-base-content/30` : ""} ${labelEdgeLit ? "border-r-primary/50" : ""}`}
								>
									<span className="block text-sm font-semibold">{row.title}</span>
									<span className="mt-0.5 block text-xs leading-snug text-base-content/55">
										{row.desc}
									</span>
								</th>
								{RUNG_AMOUNTS.map((amount, column) => {
									const lit = column === litColumn;
									// This cell owns the rule between itself and the column to its right, so
									// it draws that rule in primary when EITHER of the two is the chosen one.
									const rightEdgeLit = lit || column === litColumn - 1;
									const lastColumn = column === RUNG_AMOUNTS.length - 1;
									const cell = row.cell(amount);
									const carried = cell.value !== NOT_CARRIED;
									const shownNote = changedNote(
										row,
										amount,
										column === 0 ? null : RUNG_AMOUNTS[column - 1],
									);
									return (
										<td
											key={amount}
											className={`border-r border-t px-2 py-3 text-center text-sm tabular-nums transition-colors ${GRID} ${SURFACE_CELL} ${first ? "border-t-2 border-t-base-content/30" : ""} ${last ? "border-b-2 border-b-base-content/30" : ""} ${lastColumn ? "border-r-2 border-r-base-content/30" : ""} ${lastColumn && first ? "rounded-tr-2xl" : ""} ${lastColumn && last ? "rounded-br-2xl" : ""} ${lit ? "bg-primary/10 font-semibold" : ""} ${rightEdgeLit ? "border-r-primary/50" : ""} ${lit && last ? "border-b-primary/50" : ""} ${carried ? "text-base-content/80" : "text-base-content/30"}`}
										>
											{cell.value}
											{!carried && <span className="sr-only">not carried</span>}
											{shownNote && (
												<span className="mt-0.5 block text-xs font-normal text-base-content/45">
													{shownNote}
												</span>
											)}
										</td>
									);
								})}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/**
 * The narrow layout: one card per rung, listing what that rung adds over the one below it.
 *
 * 🚨 **Marginal rather than complete, which is the only way five cards beat one table**
 * (Parker, 2026-08-24). Repeating all seven perks on all five cards is the matrix again,
 * stacked, at five times the length — and a reader scrolling it cannot see the difference
 * between two rungs at all, which is the one thing they came here to find. So each card
 * answers "what does this one add", and `marginalRows` derives that from the same `cell`
 * functions the table reads, so a card cannot quietly stop agreeing with the table.
 *
 * ⚠️ **The header is the control here too**, and only the header: a `<label>` may not
 * legally contain a `<ul>`, so wrapping the whole card would mean giving up list semantics
 * for the perks. The pressable part is the rung, which is also what it is in the matrix.
 */
function BadgeCards({ value, onChange, idPrefix }: LadderProps) {
	return (
		<div className="space-y-3">
			{BADGE_ORDER.map((key, index) => {
				const amount = thresholdForBadge(key);
				const previousKey = index === 0 ? null : BADGE_ORDER[index - 1];
				const previous = index === 0 ? null : RUNG_AMOUNTS[index - 1];
				const lit = value === amount;
				const rows = marginalRows(amount, previous);
				return (
					<div
						key={key}
						className={`rounded-2xl border transition-colors ${
							lit ? "border-primary/50 bg-primary/10" : "border-base-content/10 bg-base-200/40"
						}`}
					>
						<label className="flex cursor-pointer items-center gap-3 px-4 py-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
							<input
								type="radio"
								name={`${idPrefix}-anthers-badge`}
								className="sr-only"
								checked={lit}
								onChange={() => onChange(amount)}
							/>
							{key !== "free" && <BadgeMark badge={key} lit={lit} size="h-12 w-12" />}
							<span className="min-w-0">
								<span style={serif} className="block text-lg font-medium">
									{rungName(key)}
								</span>
								<span className="block text-sm tabular-nums text-base-content/60">
									{rungPrice(amount)}
								</span>
							</span>
						</label>
						<div className="border-t border-base-content/10 px-4 py-3">
							<p className="text-xs font-semibold uppercase tracking-wide text-base-content/45">
								{previousKey === null
									? "What a free account carries"
									: `What ${rungName(key)} adds over ${rungName(previousKey)}`}
							</p>
							{rows.length === 0 ? (
								<p className="mt-2 text-sm text-base-content/55">
									The same as {previousKey === null ? "Free" : rungName(previousKey)}.
								</p>
							) : (
								<ul className="mt-2 space-y-2.5">
									{rows.map((row) => {
										const cell = row.cell(amount);
										const shownNote = changedNote(row, amount, previous);
										return (
											<li key={row.title}>
												<span className="flex items-baseline justify-between gap-3 text-sm">
													<span className="font-medium">{row.title}</span>
													<strong className="shrink-0 text-right tabular-nums">
														{cell.value}
														{shownNote && (
															<span className="block text-xs font-normal text-base-content/45">
																{shownNote}
															</span>
														)}
													</strong>
												</span>
												{/* Said once, on the card where the perk first appears. */}
												{amount === firstRungCarrying(row) && (
													<span className="mt-1 block text-xs leading-snug text-base-content/55">
														{row.desc}
													</span>
												)}
											</li>
										);
									})}
								</ul>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/* ── Step 4 · the creator finder ────────────────────────────────────────────── */

/**
 * Search by name, or tap a medium for a handful.
 *
 * The medium chips SHUFFLE rather than filter: tapping one draws a few creators who work
 * in it, and tapping it again draws different ones. A directory has to be complete before
 * it's worth browsing, and at launch it won't be — a handful that changes always reads as
 * discovery instead.
 */
function CreatorFinder({
	creators,
	loading,
	picks,
	onToggle,
}: {
	creators: PublicUser[];
	loading: boolean;
	picks: Picks;
	onToggle: (username: string, kind: "follow" | "seed") => void;
}) {
	const [query, setQuery] = useState("");
	const [medium, setMedium] = useState<string | null>(null);
	const [shuffle, setShuffle] = useState(0);

	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (q) {
			return creators
				.filter(
					(c) =>
						c.username.toLowerCase().includes(q) || (c.displayName ?? "").toLowerCase().includes(q),
				)
				.slice(0, HANDFUL);
		}
		const pool = medium
			? creators.filter((c) => (c.mediums ?? []).includes(medium))
			: creators.slice();
		// Fisher–Yates, so tapping the same medium again genuinely redraws rather than
		// reordering the same six. `shuffle` is a dependency purely to force the redraw.
		void shuffle;
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		return pool.slice(0, HANDFUL);
	}, [creators, query, medium, shuffle]);

	return (
		<div className="mt-6">
			<label className="input input-bordered mx-auto flex max-w-md items-center gap-2 rounded-full">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					strokeLinecap="round"
					className="h-4 w-4 shrink-0 opacity-40"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="6" />
					<path d="M20 20l-4.5-4.5" />
				</svg>
				<input
					type="search"
					className="grow"
					placeholder="Search creators by name"
					aria-label="Search creators by name"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>

			<div className="mt-3 flex flex-wrap items-center justify-center gap-2">
				{MEDIUMS.map((m) => (
					<button
						key={m.key}
						type="button"
						className={`btn btn-xs rounded-full ${medium === m.key ? "btn-neutral" : "btn-outline"}`}
						aria-pressed={medium === m.key}
						onClick={() => {
							setQuery("");
							setMedium(m.key);
							setShuffle((n) => n + 1);
						}}
					>
						{m.label}
					</button>
				))}
				<span className="text-xs text-base-content/40">
					{medium ? "Tap again for a different handful." : "Tap one for a handful."}
				</span>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{loading ? (
					Array.from({ length: 3 }, (_, i) => (
						<div key={`c-skeleton-${i}`} className="h-28 animate-pulse rounded-xl bg-base-200" />
					))
				) : shown.length === 0 ? (
					<p className="col-span-full rounded-xl border border-dashed border-base-content/15 p-5 text-center text-sm text-base-content/50">
						{query
							? "No one by that name yet — try a medium, or browse everyone on Discover."
							: "No creators here yet. They're on their way."}
					</p>
				) : (
					shown.map((creator) => {
						const followed = picks.follow.includes(creator.username);
						const seeded = picks.seed.includes(creator.username);
						return (
							<div
								key={creator.id}
								className={`rounded-xl border p-3.5 transition-colors ${
									followed || seeded
										? "border-primary/40 bg-primary/5"
										: "border-base-content/10 bg-base-100"
								}`}
							>
								<div className="flex items-center gap-2.5">
									{creator.avatar ? (
										<img
											src={creator.avatar}
											alt=""
											className="h-9 w-9 shrink-0 rounded-full object-cover"
										/>
									) : (
										<span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold text-primary-content">
											{initialsOf(nameOf(creator))}
										</span>
									)}
									<span className="min-w-0">
										<Link
											to={profileUrl(creator.username)}
											className="block truncate text-sm font-bold hover:underline"
										>
											{nameOf(creator)}
										</Link>
										<span className="block truncate text-xs text-base-content/45">
											{(creator.mediums ?? [])
												.map((m) => MEDIUMS.find((x) => x.key === m)?.label ?? m)
												.slice(0, 2)
												.join(" · ") || displayHandle(creator.username)}
										</span>
									</span>
								</div>
								<div className="mt-3 flex flex-wrap gap-2">
									<button
										type="button"
										className={`btn btn-xs rounded-full ${followed ? "btn-outline btn-primary" : "btn-outline"}`}
										aria-pressed={followed}
										onClick={() => onToggle(creator.username, "follow")}
									>
										{followed ? "✓ Following" : "Follow"}
									</button>
									<button
										type="button"
										className={`btn btn-xs rounded-full ${seeded ? "btn-primary" : "btn-outline"}`}
										aria-pressed={seeded}
										onClick={() => onToggle(creator.username, "seed")}
									>
										{seeded ? "✓ Supporting" : "Support"}
									</button>
								</div>
							</div>
						);
					})
				)}
			</div>
			{/* ⚠️ This said "how much each creator gets is a question for once your account
			    exists — right now it's just who", which the echo below it contradicts: a
			    pick adds a real priced line. The page still asks *whether* rather than *how
			    much*, so name the starting amount and say where it is changed. */}
			<p className="mt-4 text-center text-xs text-base-content/45">
				Backing someone starts at {money(PUBLIC_ACCESS_PRICE)} a month each. You can change the
				amount, or add and drop creators, whenever you like once your account exists.
			</p>
		</div>
	);
}

/* ── Per-section feedback, and the summary that adds it up ──────────────────── */

interface PickLine {
	key: string | null;
	label: string;
	sub: string;
	amount: number;
}

/**
 * The line the Anthers step produces at a given rung.
 *
 * 🚨 **A factory rather than an inline literal, because the echo below renders every rung's
 * line as an invisible sizer and a second copy of this copy would drift from it.** A sizer
 * that says something shorter than the answer it is reserving room for is worse than no
 * sizer at all: it reserves *almost* the right height, so the page still moves, only by
 * less and only at some widths.
 */
function anthersLineFor(amount: number): PickLine {
	return {
		key: "anthers",
		// The Badge is what somebody chose, so name it rather than the act — `heldBadgeLabel`
		// also carries the "+" rule if the amount ever stops landing exactly on a rung.
		label: `${heldBadgeLabel(amount)} — support for Anthers`,
		sub: "Thanks for helping to grow an internet worth loving again",
		amount,
	};
}

/** Every answer the Anthers step can give, for the echo to hold room for. Free is not here:
 *  it produces no line, and the empty sentence it shows instead is what the room is for. */
const ANTHERS_ECHO_SIZERS = RUNG_AMOUNTS.filter((amount) => amount > 0).map(anthersLineFor);

/**
 * The account's own row in the closing summary, at whichever rung is chosen.
 *
 * 🚨 **One row rather than two, because the free account and the Anthers rung are the same
 * fact** (Parker, 2026-08-25). The summary listed a permanent *"Free account · 10 hours of
 * Public Access a month"* and then grew a second row when somebody chose a Badge, which cost
 * two things. The card got 73px taller under a control most of a page above it, sliding every
 * bee in `MeadowVines` — they sit at a percentage of page height — and the permanent row went
 * on promising ten hours a month at rungs where the matrix directly upstream says Public
 * Access is unlimited. Saying it once, in the reading the chosen rung actually has, fixes
 * both: the list is the same length at every rung, and the sentence is true at each of them.
 *
 * ⚠️ **It stays FIRST, ahead of the creators, even though the page asks about creators
 * first.** The two support lines were deliberately ordered to match the steps above them on
 * 2026-08-17, and this row is the exception because it is not only the Anthers answer — it is
 * the account, which exists before either step is asked. Free carries no `key`, since the one
 * thing a reader cannot remove is having an account.
 */
function accountLineFor(amount: number): PickLine {
	if (amount > 0) return anthersLineFor(amount);
	return {
		key: null,
		label: "Free account",
		sub: `${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month`,
		amount: 0,
	};
}

/** Every reading that row can have, so its height is the tallest of them at every rung. */
const SUMMARY_ACCOUNT_SIZERS = RUNG_AMOUNTS.map(accountLineFor);

const DROP_LABEL = "Remove";
const DROP_CLASS = "text-xs text-base-content/45 underline";

/**
 * One row of an echo — the real answer, or an invisible copy of it holding the box open.
 *
 * 🚨 **A sizer draws the drop control as a `<span>` rather than leaving it out**, because
 * the right-hand group is `shrink-0` and the label beside it is `min-w-0`: whatever width
 * that group takes is width the label does not get. Omitting the word gave the sizer's
 * label a button's worth of extra room, so it wrapped one line later than the answer it was
 * reserving for and under-reserved by 32px at 390px. A `<span>` holds the same width and
 * stays out of the tab order without leaning on `visibility: hidden` to do it.
 */
function EchoRow({ line, onDrop }: { line: PickLine; onDrop?: (key: string) => void }) {
	return (
		<li className="flex items-baseline gap-3 text-sm">
			<span className="min-w-0">
				<span className="font-semibold">{line.label}</span>
				<span className="block text-xs text-base-content/50">{line.sub}</span>
			</span>
			<span className="ml-auto flex shrink-0 items-baseline gap-3">
				<strong className="tabular-nums">
					{line.amount ? `${money(line.amount)}/mo` : "Free"}
				</strong>
				{line.key &&
					(onDrop ? (
						<button type="button" className={DROP_CLASS} onClick={() => onDrop(line.key as string)}>
							{DROP_LABEL}
						</button>
					) : (
						<span className={DROP_CLASS}>{DROP_LABEL}</span>
					))}
			</span>
		</li>
	);
}

/**
 * What this section currently amounts to, stated under the section itself.
 *
 * Every step that asks something answers it in place rather than reporting into a rail
 * off to one side: a choice and its consequence belong in the same eyeline, and the page
 * can then be a single centered column like the rest of the marketing lineup. The default
 * is always *nothing chosen*, said plainly — an unanswered step reads as unanswered
 * rather than as a quiet no.
 */
function SectionEcho({
	empty,
	lines,
	onDrop,
	sizers,
}: {
	empty: string;
	lines: PickLine[];
	onDrop: (key: string) => void;
	/**
	 * Every answer this section can produce, rendered invisibly so the box is always as tall
	 * as its tallest one.
	 *
	 * 🚨 **For a step whose control is a set of options rather than a growing list** — the
	 * Anthers ladder, where the echo goes from a sentence to exactly one line and back.
	 * Without it, pressing a rung grew this box by the height of a `sub`, and the page moved
	 * under the control being pressed. The creator step leaves this off: its echo grows with
	 * however many creators somebody picks, so there is no tallest answer to hold it at.
	 *
	 * ⚠️ **The rows, not a `min-h-*` measured off a screenshot.** A reserved height in
	 * pixels is right at one viewport and one font size; it was wrong at 390px within
	 * minutes of being written, because the label wraps there and the reservation did not.
	 */
	sizers?: PickLine[];
}) {
	const total = lines.reduce((sum, l) => sum + l.amount, 0);
	return (
		<div
			className={`mx-auto mt-8 max-w-xl rounded-2xl border px-5 py-4 transition-colors ${
				lines.length > 0
					? "border-primary/35 bg-primary/5"
					: "border-dashed border-base-content/15 bg-base-200/40"
			}`}
		>
			<div className="grid">
				{sizers?.map((line) => (
					<ul
						key={line.amount}
						aria-hidden="true"
						className="invisible col-start-1 row-start-1 space-y-2"
					>
						<EchoRow line={line} />
					</ul>
				))}
				{/* `self-center` so the empty sentence sits in the middle of whatever room the
				    sizers reserved, rather than against the top of it. */}
				<div className="col-start-1 row-start-1 self-center">
					{lines.length === 0 ? (
						<p className="text-center text-sm text-base-content/50">{empty}</p>
					) : (
						<>
							<ul className="space-y-2">
								{lines.map((line) => (
									<EchoRow key={line.key ?? line.label} line={line} onDrop={onDrop} />
								))}
							</ul>
							{lines.length > 1 && (
								<p className="mt-3 border-t border-base-content/10 pt-2 text-right text-sm font-semibold tabular-nums">
									{money(total)}/mo from this step
								</p>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * What signing up actually costs, said as a list rather than as a paragraph.
 *
 * 🚨 **The limit is in here, not in a footnote, and the wiki's *How Anthers Talks About Itself* requires it to be.** *"Free
 * forever"* met without a bound beside it is heard as *unlimited*, so the offer has to be
 * stated whole: permanent **and** bounded. Hiding the cap would also hollow out the only
 * honest reason to give Anthers anything, since the cap is the thing that lifts.
 *
 * ⚠️ Every line is a thing you get, including the bounded one. *"10 hours a month"* is
 * written as an inclusion rather than as a restriction, because it is one — and because a
 * reader who meets it as a warning reads the whole list as a trial.
 */
function FreeInclusions() {
	const items: { icon: typeof PlayCircleIcon; label: string; sub: string }[] = [
		{
			icon: PlayCircleIcon,
			label: `${FREE_PUBLIC_ACCESS_HOURS} hrs/mo of Public Access`,
			sub: "Any works creators make available without a Badge, streamed for free, with creators still paid by Anthers for you.",
		},
		{
			icon: ShieldCheckIcon,
			label: "No Ads or Data Harvesting",
			sub: "Even if you use Anthers for free, we never serve ads, we never sell your data, and we can never be sold. Free means free.",
		},
		{
			icon: BanknotesIcon,
			label: "Zero Platform Fee",
			sub: "When you choose to support a creator with a monthly Badge subscription or a direct purchase, Anthers takes no cut.",
		},
		{
			icon: ArrowDownTrayIcon,
			label: "Purchases are yours, forever",
			sub: "Any works you purchase are yours to own and download from your Anthers library, even if they're unlisted later.",
		},
		{
			icon: ServerStackIcon,
			label: `${FREE_STORAGE_GIB} GiB of Creator storage`,
			// ⚠️ **This is a CREATOR allowance, and the sentence has to keep saying so.**
			// `FREE_STORAGE_GIB`'s only consumer is `estimateStorageCost` in
			// `packages/shared/src/fees.ts`, which bills a creator's catalog against it —
			// there is no user-side storage quota to describe. A draft of this line offered
			// the same allowance to users for preserving delisted purchases and storing
			// cloud saves; neither exists, and a delisted purchase already survives without
			// drawing on anybody's quota, since that is a free-access obligation under the wiki's *How Anthers Talks About Itself*.
			//
			// ⚠️ The `6+` is DERIVED, never typed — see `FREE_VIDEO_HOURS`. Only the numeral
			// is computed; the sentence is Parker's, word for word.
			sub: `If you're interested in creating on Anthers, you can store the equivalent of ${FREE_VIDEO_HOURS}+ hours of Full HD video for free in your catalog.`,
		},
	];
	return (
		// The icon row, as /about used to draw its governance facts: a mark, a short name,
		// a sentence. ⭐ It replaced five bordered cards, which sat directly above the
		// signup card and read as a second stack of the same object — the eye could not
		// tell the list of what you get from the thing you do about it.
		<ul className="mx-auto mt-12 grid max-w-7xl grid-cols-1 gap-8 text-center sm:grid-cols-2 lg:grid-cols-5 lg:gap-8">
			{items.map((item, i) => (
				<Reveal as="li" key={item.label} delay={i * 90}>
					<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
						<item.icon className="h-7 w-7" />
					</div>
					{/* ⚠️ `lg:min-h-12` reserves two lines for every title, because these wrap to
					    one or two depending on the name and the breakpoint — and a row whose
					    paragraphs start at five different heights reads as five loose blocks
					    rather than as one row. It applies only where the items sit side by
					    side; stacked, the reserved space is just a gap. */}
					<h3 style={serif} className="mb-1 text-base font-medium text-balance lg:min-h-8">
						{item.label}
					</h3>
					<p className="text-xs leading-relaxed text-base-content/55">{item.sub}</p>
				</Reveal>
			))}
		</ul>
	);
}

/**
 * One of the two optional things, drawn as a door rather than described as a fact.
 *
 * ⚠️ **It scrolls rather than navigates**, because the section it names is on this page —
 * a `<Link to="#…">` would be a router navigation to the same route and would leave the
 * reader where they were. `scroll-mt` on the target is what keeps the heading clear of
 * the sticky header.
 */
function GoFurtherCard({
	icon: Icon,
	title,
	target,
	children,
}: {
	icon: typeof PlayCircleIcon;
	title: string;
	target: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="group flex w-full items-start gap-4 rounded-2xl border border-base-content/10 bg-base-200/60 p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
			onClick={() =>
				document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })
			}
		>
			<span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
				<Icon className="h-6 w-6" />
			</span>
			<span className="min-w-0">
				<span className="flex items-center gap-1.5 text-sm font-bold">
					{title}
					<span
						aria-hidden="true"
						className="translate-y-px text-base-content/35 transition-transform group-hover:translate-x-0.5"
					>
						↓
					</span>
				</span>
				<span className="mt-1.5 block text-sm leading-snug text-base-content/60">{children}</span>
			</span>
		</button>
	);
}

/** Which way in the signup card is currently offering. */
type Door = "email" | "bluesky";

/**
 * The line under the signup button, for one reading of the page.
 *
 * 🚨 **A function rather than three literals at the call site, because the card renders the
 * note it is showing *and* every other note it could show, invisibly, to size itself** — the
 * same arrangement `anthersReading` exists for. Choosing a rung swaps a one-line note for a
 * two-line one, and this card sits ABOVE the ladder, so the 19px it gained pushed the matrix
 * down under the pointer that had just pressed it. It moved the decor with it too: the bees
 * in `MeadowVines` are placed at a percentage of page height, so anything that changes how
 * tall this page is slides the whole backdrop.
 *
 * 🚨 **The Bluesky note is the ONLY warning that the round trip asks for an email address**,
 * since the panel above it became a field and a button and nothing else. `transition:email`
 * is a real consent screen on somebody else's website, and meeting it unannounced is how a
 * signup gets abandoned at the last step — so the note carries that rather than narrating the
 * redirect, which the button it sits under already names. `subscribe-bluesky.e2e.ts` pins the
 * sentence.
 */
function signupNote(signedIn: boolean, paying: boolean, door: Door): string {
	if (signedIn)
		return "You'll see the exact charge before anything is confirmed. Change or stop any month.";
	if (paying)
		return "We'll confirm your email first. You'll see the exact charge before anything is taken.";
	return door === "bluesky"
		? "Bluesky will ask to share your email address."
		: "We'll email you a code to confirm your address.";
}

/**
 * Every note this visitor can meet without leaving the page — the card's own sizers.
 *
 * ⚠️ Both of the things that swap the note are reachable from where the reader is standing:
 * the Anthers ladder is most of a page below and the door tabs are an inch above, and neither
 * may resize the card. `signedIn` is the one input that cannot change while the page is up,
 * so it narrows the set rather than joining it.
 */
function signupNoteSizers(signedIn: boolean): string[] {
	if (signedIn) return [signupNote(true, false, "email")];
	return [
		signupNote(false, true, "email"),
		signupNote(false, false, "email"),
		signupNote(false, false, "bluesky"),
	];
}

/**
 * The Badge art is `BADGE_ART` from `@anthers/web-shared/economics`, not a local map.
 *
 * 🚨 **Restating the presentation here is what went wrong before and would go wrong
 * again.** This page once drew its own marks and produced a ladder matching nothing —
 * `/for-users` renders the same rungs a screen away — and when the design changed, three
 * hand-drawn copies each had to be found and edited. A second copy of a brand decision is
 * a second thing to keep in step, and this one had already drifted before it shipped.
 *
 * 🚨 **Free carries no mark**, which is why `BADGE_ART` is keyed by `Badge` and not
 * `BadgeKey`. A mark is a Badge, and Free is the absence of one rather than a Badge worth
 * $0 (Parker, 2026-08-24). The map briefly held a `free: 🌰` entry that no surface was
 * supposed to use, and this ladder used it — so the key was narrowed and the rule is the
 * compiler's now.
 */

/**
 * The signup control: two doors on a tab switcher, an address or a Bluesky handle.
 *
 * 🚨 **One component, rendered twice, and that is deliberate rather than lazy.** It opens
 * the page — because the first thing a visitor needs to know is that joining costs nothing
 * — and it closes it, for somebody who scrolled, chose something, and is ready. Two copies
 * of this markup would be two things to keep honest about what the button promises, and
 * the promise is the part that matters.
 *
 * Both instances read the same `email` state, so typing in one fills the other; only the
 * input's `id` differs, which is why `idPrefix` exists. `door` is shared for the same
 * reason: a reader who picks Bluesky at the top and scrolls to the bottom should find the
 * card they chose, not the one they didn't.
 *
 * ⚠️ **The tabs replaced a divider and a second button underneath the email field**, which
 * made Bluesky read as the afterthought rather than as the other half of one choice. They
 * appear only where there genuinely are two doors: a signed-in visitor has no address to
 * give, somebody returning from Bluesky without a usable address has already used that
 * door, and the door is closed entirely when the API says signup is off.
 */
function SignupForm({
	idPrefix,
	cta,
	busy,
	note,
	noteSizers,
	error,
	success,
	email,
	onEmailChange,
	onSubmit,
	onBluesky,
	handle,
	onHandleChange,
	door,
	onDoorChange,
	className,
}: {
	idPrefix: string;
	cta: string;
	busy: boolean;
	note?: string;
	/**
	 * The other notes this card can show, rendered invisibly so the line under the button is
	 * always as tall as the tallest of them. Built by `signupNoteSizers`, never by hand.
	 */
	noteSizers?: string[];
	error: string | null;
	success: string | null;
	/** Null when signed in — there is no address to ask a returning user for. */
	email: string | null;
	onEmailChange: (value: string) => void;
	onSubmit: () => void;
	/**
	 * Hand the typed handle off to Bluesky. Null when the door should not be offered at all.
	 *
	 * On success this never returns in any useful sense — the browser is already leaving —
	 * so nothing may be queued after it, and `busy` is deliberately left set.
	 */
	onBluesky: ((handle: string) => void) | null;
	/** The Bluesky handle being typed, shared by both copies of this card like `email`. */
	handle: string;
	onHandleChange: (value: string) => void;
	door: Door;
	onDoorChange: (door: Door) => void;
	/** Outer spacing only — the card's own box is this component's, not a caller's. */
	className?: string;
}) {
	const fieldId = `${idPrefix}-email`;
	const handleFieldId = `${idPrefix}-handle`;
	/** Two doors to choose between, rather than one door and a fallback. */
	const tabbed = email !== null && !!onBluesky;
	/** With no tabs there is nothing to switch, so the email field is simply the card. */
	const showEmail = email !== null && (!tabbed || door === "email");

	const emailPanel = showEmail && (
		<form
			className="text-left"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		>
			<label className="label px-0 pb-1" htmlFor={fieldId}>
				<span className="text-sm font-semibold">Where should we reach you?</span>
			</label>
			<input
				id={fieldId}
				type="email"
				required
				autoComplete="email"
				placeholder="you@example.com"
				className="input input-bordered w-full"
				value={email ?? ""}
				onChange={(e) => onEmailChange(e.target.value)}
			/>
			<button
				type="submit"
				className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
				disabled={busy}
			>
				{busy ? "Working…" : cta}
			</button>
		</form>
	);

	/**
	 * The Bluesky door, asked for in place rather than in a modal.
	 *
	 * ⭐ **The handle used to be collected in a step of its own** — press the button, meet
	 * `BlueskyHandleModal`, type the handle, press again, leave. That is two presses and a
	 * layer for one short field, and this card has room the `/login` card genuinely does
	 * not (its botanical flourishes reach about seven rems in from each corner, which is
	 * why the modal exists at all and why `/login` keeps it).
	 *
	 * ⚠️ **The panel is a field and a button, and nothing else** (Parker, 2026-08-24). It
	 * carried a paragraph explaining the round trip, which made the Bluesky tab twice the
	 * height of the email one — so switching tabs resized the card under the reader. What
	 * survives of that explanation is the one-line `note` below the button.
	 *
	 * 🚨 **One of the three promises survives, and it is in the `note` under the button.**
	 * `transition:email` is a real consent screen on somebody else's website, so the warning
	 * that Bluesky will be asked for an email address had to land somewhere — folding it
	 * into a line that already existed keeps it without giving the panel back its height.
	 * The other two are covered a moment later: `/welcome` takes the name and the terms, and
	 * the emailed code speaks for itself when it arrives.
	 */
	const blueskyPanel = tabbed && door === "bluesky" && onBluesky && (
		<form
			className="text-left"
			onSubmit={(e) => {
				e.preventDefault();
				onBluesky(handle);
			}}
		>
			<label className="label px-0 pb-1" htmlFor={handleFieldId}>
				<span className="text-sm font-semibold">What&rsquo;s your handle?</span>
			</label>
			{/* A handle is a domain name, so this is `text` with a URL keyboard rather than an
			    `email`-shaped field. The leading `@` is how people write it and not part of
			    it — stripped on submit, never fought with while typing. */}
			<input
				id={handleFieldId}
				type="text"
				inputMode="url"
				autoComplete="username"
				spellCheck={false}
				autoCapitalize="none"
				placeholder="alice.bsky.social"
				aria-label="Bluesky handle"
				className="input input-bordered w-full"
				value={handle}
				onChange={(e) => onHandleChange(e.target.value)}
			/>
			{/* 🚨 No butterfly on this button, and that is a compliance decision rather than a
			    visual one. Bluesky's guidance allows their mark in three colors only, and the
			    one that reads on `btn-primary` differs by theme — our primary is a deep green
			    in light and a light amber in dark, so white works on one and is nearly
			    invisible on the other, while their blue is listed for light backgrounds only.
			    The tab an inch above already carries the mark in an approved color on a
			    surface we control, which is where it belongs. */}
			<button
				type="submit"
				className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
				disabled={busy || !handle.trim()}
			>
				{busy ? "Taking you to Bluesky…" : "Sign up with Bluesky"}
			</button>
		</form>
	);

	/**
	 * One tab on the vertical rail.
	 *
	 * ⚠️ **Icon-only, so the accessible name comes from `aria-label` and there is no visible
	 * text to fall back on.** `title` gives a pointer user the same word on hover; the panel
	 * beside it names the door in full, which is what carries the meaning for everyone else.
	 */
	/**
	 * One tab in the strip across the card's top edge.
	 *
	 * The selected tab wears the card body's own background so the two read as one
	 * surface, and the unselected one is recessed a shade behind it. That is the whole
	 * of the selected state: it is the tab, not the mark on it, that changes.
	 */
	const tab = (value: Door, label: string, icon: React.ReactNode) => (
		<button
			type="button"
			role="tab"
			aria-selected={door === value}
			// ⚠️ The divider between the cells is this left border rather than a spacer
			// element, because a `tablist` should contain tabs and nothing else — an
			// `aria-hidden` span in there is a thing assistive tech has to step over.
			className={`flex flex-1 items-center justify-center gap-2 border-base-300 px-4 py-3 text-sm font-semibold transition-colors not-first:border-l ${
				door === value
					? "bg-base-200/60 text-base-content"
					: "bg-base-300/60 text-base-content/50 hover:text-base-content/75"
			}`}
			onClick={() => onDoorChange(value)}
		>
			{icon}
			{label}
		</button>
	);

	return (
		// 🚨 `data-signup` exists because the page deliberately carries TWO of these, with the
		// same button label — which is right for a reader (it is the same act) and ambiguous
		// for anything selecting by role and name. This is the seam that disambiguates them
		// without inventing two different labels for one action.
		//
		// ⚠️ **The card box belongs to this component rather than to its call sites**, and
		// that is what lets the tabs sit ON the top edge instead of floating inside the
		// padding. Both callers used to draw the border and background themselves; a tab
		// strip cannot attach to an edge it is nested three levels inside of. `overflow-hidden`
		// is what stops a selected tab's background squaring off the rounded top corners.
		<div
			data-signup={idPrefix}
			className={`overflow-hidden rounded-2xl border border-base-300 bg-base-200/60 ${className ?? ""}`}
		>
			{/* Tabs across the TOP rather than down the left (Parker, 2026-08-24) — the card
			    is a centered column and a left rail pushed its contents off that center line,
			    where a top strip keeps the field, the button and the note all aligned to the
			    same axis.

			    ⚠️ The strip renders only when there really are two doors. One tab above a
			    panel reads as a control that has lost its other half, which is worse than
			    the plain card a closed Bluesky door falls back to.

			    🚨 The label is "Bluesky", never "Bsky" — their brand guidance rules out that
			    abbreviation in public-facing material by name. */}
			{tabbed && (
				<div role="tablist" aria-label="How to sign up" className="flex border-b border-base-300">
					{tab(
						"email",
						"Email",
						<EnvelopeIcon
							className={`h-5 w-5 ${door === "email" ? "text-primary" : "text-base-content/40"}`}
						/>,
					)}
					{/* 🚨 The butterfly keeps its own color in BOTH states — see `BlueskyMark`.
					    Dimming it to signal "not selected" would be tinting somebody else's
					    trademark, so the tab behind it carries the whole selected state. */}
					{tab("bluesky", "Bluesky", <BlueskyMark className="h-5 w-5" />)}
				</div>
			)}

			<div className="p-6">
				{/* The ONE field this page collects. Username and password are deliberately not
				    asked for here — they cost nothing at the moment of decision and everything
				    at the moment of doubt, so they move to onboarding, after the address is
				    confirmed and after any charge. */}
				{/* ⚠️ **This card no longer has a "finishing a Bluesky signup" state**, because
				    nobody comes back to this page to finish one. Coming back from bsky.social to
				    a marketing page with a prefilled email box is exactly what Parker's
				    walkthrough could not tell apart from having accomplished nothing; the
				    callback lands on `/finish` now, where saying whose signup it is finishing is
				    the page's whole subject rather than a banner over a form. */}
				{emailPanel}
				{blueskyPanel}

				{email === null && (
					<button
						type="button"
						className={`btn btn-primary btn-lg w-full ${busy ? "btn-disabled" : ""}`}
						onClick={onSubmit}
						disabled={busy}
					>
						{busy ? "Working…" : cta}
					</button>
				)}
				{error && <p className="mt-3 text-sm text-error">{error}</p>}
				{success && <p className="mt-3 text-sm text-success">{success}</p>}
				{note && (
					// Stacked over an invisible copy of every other note this card can show, so
					// nothing the reader does elsewhere on the page resizes it. See `signupNote`.
					<div className="mt-3 grid">
						{noteSizers?.map((alt) => (
							<p
								key={alt}
								aria-hidden="true"
								className="invisible col-start-1 row-start-1 text-center text-xs leading-relaxed text-base-content/45"
							>
								{alt}
							</p>
						))}
						<p className="col-start-1 row-start-1 text-center text-xs leading-relaxed text-base-content/45">
							{note}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * One row's contents, shared by the real row and by the invisible copies sizing it.
 *
 * 🚨 **A sizer draws the drop control as a `<span>` rather than leaving it out**, exactly as
 * `EchoRow` does and for the same reason: the right-hand group is `shrink-0`, so a sizer with
 * no button hands its label width the real answer will never get, and under-reserves.
 */
function SummaryRowBody({ line, onDrop }: { line: PickLine; onDrop?: (key: string) => void }) {
	return (
		<>
			<span className="min-w-0">
				<span className="font-semibold">{line.label}</span>
				<span className="block text-xs text-base-content/45">{line.sub}</span>
			</span>
			<span className="ml-auto flex shrink-0 items-baseline gap-3">
				<strong className="tabular-nums">{line.amount ? money(line.amount) : "Free"}</strong>
				{line.key &&
					(onDrop ? (
						<button
							type="button"
							className="text-xs text-base-content/40 underline"
							onClick={() => onDrop(line.key as string)}
						>
							{DROP_LABEL}
						</button>
					) : (
						<span className="text-xs text-base-content/40 underline">{DROP_LABEL}</span>
					))}
			</span>
		</>
	);
}

/** The closing panel — the only place the whole page is added up. */
function Summary({
	lines,
	total,
	onDrop,
	accountSizers,
	...signup
}: {
	lines: PickLine[];
	total: number;
	onDrop: (key: string) => void;
	/**
	 * Every reading the FIRST line can have, rendered invisibly so that row is always as tall
	 * as the tallest of them.
	 *
	 * 🚨 **The first line only, because it is the only one whose height the ladder moves.**
	 * It is the account row from `accountLineFor`, and both halves of it vary: at 390px
	 * *"Sprout — support for Anthers"* wraps a line further than *"Root — …"* does, so the
	 * card changed height between two paid rungs as well as between Free and any of them. The
	 * creator rows below deliberately go without, for the same reason the creator step's echo
	 * does — that list grows with however many people somebody picks, so it has no tallest
	 * reading to hold.
	 */
	accountSizers?: PickLine[];
} & Omit<React.ComponentProps<typeof SignupForm>, "idPrefix">) {
	const [account, ...rest] = lines;
	return (
		// ⚠️ Two stacked cards rather than one panel, since `SignupForm` now draws its own
		// box so its tabs have a top edge to sit on. It reads better than the single panel
		// did anyway: what you chose is one object, and the way in is another.
		<div className="mx-auto mt-8 max-w-lg">
			<div className="rounded-2xl border border-base-300 bg-base-200/60 p-6">
				<ul className="space-y-2.5">
					<li className="grid border-b border-base-content/5 pb-2.5">
						{accountSizers?.map((alt) => (
							<span
								key={alt.label}
								aria-hidden="true"
								className="invisible col-start-1 row-start-1 flex items-baseline gap-3 text-sm"
							>
								<SummaryRowBody line={alt} />
							</span>
						))}
						<span className="col-start-1 row-start-1 flex items-baseline gap-3 text-sm">
							<SummaryRowBody line={account} onDrop={onDrop} />
						</span>
					</li>
					{rest.map((line) => (
						<li
							key={line.key ?? line.label}
							className="flex items-baseline gap-3 border-b border-base-content/5 pb-2.5 text-sm"
						>
							<SummaryRowBody line={line} onDrop={onDrop} />
						</li>
					))}
				</ul>
				<div className="mt-4 flex items-baseline justify-between">
					<span className="font-bold">Monthly</span>
					<span className="text-3xl font-bold tabular-nums">{money(total)}</span>
				</div>
				{/* ⚠️ Held in place at $0 rather than dropped, so the rung above cannot resize this
				    card by sixteen pixels — but held *silently*. `SeedBreakdown` prints the same
				    line at $0 and is right to, because it is describing where a charge goes; a
				    panel whose total reads $0 must not print a charge-shaped sentence under it. */}
				<p
					aria-hidden={total === 0}
					className={`text-right text-xs text-base-content/45 ${total > 0 ? "" : "invisible"}`}
				>
					plus any applicable tax
				</p>
			</div>

			<SignupForm idPrefix="summary" className="mt-4" {...signup} />
		</div>
	);
}

/* ── Page ───────────────────────────────────────────────────────────────────── */

export default function SubscribePage() {
	const { user, refreshUser, signUpWithBluesky } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const signedIn = !!user;

	/**
	 * Where to hand the visitor back to once this is over, if they came from somewhere.
	 *
	 * Set by the gated-post unlock modal, which is the case that matters: someone who
	 * clicked "Create an account" to read one particular thing. It rides through the whole
	 * detour — ceremony, possible payment modal, `/welcome` — and onboarding does the final
	 * hop, because a new account still owes a handle and the terms before it goes anywhere.
	 *
	 * 🚨 Read through `sanitizeNextPath` every time, never off `URLSearchParams` directly:
	 * this value is attacker-controlled, and it decides where a person lands seconds after
	 * typing a code from their inbox.
	 */
	const next = sanitizeNextPath(new URLSearchParams(location.search).get("next"));

	const [email, setEmail] = useState("");
	/**
	 * Which door the signup card is showing — shared by both copies of it, like `email`.
	 *
	 * Email is the default because it is the one every visitor can use; the Bluesky tab
	 * asks for an account on another service.
	 */
	const [door, setDoor] = useState<Door>("email");
	/** The Bluesky handle being typed, shared by both copies of the signup card. */
	const [handle, setHandle] = useState("");
	/**
	 * Whether the Bluesky door is open at all.
	 *
	 * ⚠️ Starts false and is only ever turned on, so the page never flashes a button it is
	 * about to take away — and a browser that cannot reach the API simply sees the page as
	 * it was before this feature existed, which is the correct degraded state.
	 */
	const [blueskySignupOpen, setBlueskySignupOpen] = useState(false);

	const [picks, setPicks] = useState<Picks>(EMPTY_PICKS);
	const [creators, setCreators] = useState<PublicUser[]>([]);
	const [loadingCreators, setLoadingCreators] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [pending, setPending] = useState<{
		anthersSupport: number;
		directed: { creatorId: number; amount: number }[];
		badgeName: string;
		preview: SubscriptionPreview;
	} | null>(null);

	// Restore anything chosen on an earlier visit. Guarded because a browser with storage
	// disabled must not take the page down with it.
	//
	// ⚠️ **Session storage is a convenience now rather than the mechanism.** It mattered when
	// signing up round-tripped through another website and came back here; the choices ride
	// on the pending signup since 2026-08-26, so this only spares somebody who wandered off
	// and came back before pressing anything.
	//
	// 🚨 `normalizePicks` rather than a spread, because storage holds whatever a previous
	// visit wrote — including an `anthers` of `null`, which meant "hasn't said" until
	// 2026-08-25 and is a value the ladder can no longer display.
	useEffect(() => {
		try {
			const raw = sessionStorage.getItem(PICKS_KEY);
			if (raw) setPicks(normalizePicks(JSON.parse(raw)));
		} catch {
			/* no storage, no restore — the page still works */
		}
	}, []);

	// Is the Bluesky door open? Signed-out visitors only, because that is the only state
	// this page offers it in.
	useEffect(() => {
		if (signedIn) return;
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then(({ signupEnabled }) => {
				if (live) setBlueskySignupOpen(signupEnabled);
			})
			.catch(() => {
				/* Unreachable API: leave the door closed. */
			});
		return () => {
			live = false;
		};
	}, [signedIn]);

	useEffect(() => {
		try {
			sessionStorage.setItem(PICKS_KEY, JSON.stringify(picks));
		} catch {
			/* see above */
		}
	}, [picks]);

	useEffect(() => {
		let live = true;
		client.api.accounts.creators
			.$get()
			.then((res) => res.json())
			.then((data) => {
				if (live) setCreators(data.creators as PublicUser[]);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoadingCreators(false);
			});
		return () => {
			live = false;
		};
	}, []);

	const toggleCreator = useCallback((username: string, kind: "follow" | "seed") => {
		setPicks((prev) => {
			const follow = new Set(prev.follow);
			const seed = new Set(prev.seed);
			if (kind === "seed") {
				if (seed.has(username)) {
					seed.delete(username);
				} else {
					seed.add(username);
					// Directing support to someone follows them too; the reverse isn't implied.
					follow.add(username);
				}
			} else if (follow.has(username)) {
				follow.delete(username);
				seed.delete(username);
			} else {
				follow.add(username);
			}
			return { ...prev, follow: [...follow], seed: [...seed] };
		});
	}, []);

	const dropPick = useCallback((key: string) => {
		setPicks((prev) =>
			key === "anthers"
				? // Back to Free, not to "unanswered" — dropping support for Anthers IS choosing
					// Free, and it is the only one of the two the ladder can show.
					{ ...prev, anthers: 0 }
				: {
						...prev,
						follow: prev.follow.filter((u) => u !== key),
						seed: prev.seed.filter((u) => u !== key),
					},
		);
	}, []);

	const byUsername = useMemo(() => new Map(creators.map((c) => [c.username, c])), [creators]);

	/**
	 * 🚨 **The displayed total and the charged total are the SAME function**, and were two
	 * independent expressions until 2026-08-16.
	 *
	 * They agreed, so nothing was visibly wrong — but the page's summary said
	 * `(anthers + creators) × price` while the charge said `1 + creators`, and only the
	 * second one broke when the unit changed under it. A page that computes what it shows and
	 * what it bills by different routes is one edit away from showing a number it does not
	 * charge, which is the exact failure the confirmation ceremony exists to prevent.
	 *
	 * ⚠️ **Same function was not the same call, and that gap was real.** The page built one
	 * argument list to display and `commit` built another to bill, from the same picks — so
	 * a rung chosen above Root could be shown and Root charged, with both routes still
	 * "using `supportTotal`". Sabotage confirmed it: substituting the price at the commit
	 * site alone left every test green, because the e2e picks Root, where the substituted
	 * value and the chosen one coincide.
	 *
	 * There is ONE list and ONE total now. `directed` also carries the creator ids the
	 * charge needs, which closes a second, quieter divergence: the display used to count
	 * `picks.seed` while the charge dropped any username missing from `byUsername`, so a
	 * pick made before the creator list loaded was quotable and unbillable.
	 */
	const directed = useMemo(
		() =>
			picks.seed
				.map((username) => byUsername.get(username))
				.filter((creator): creator is PublicUser => !!creator)
				.map((creator) => ({ creatorId: creator.id, amount: PUBLIC_ACCESS_PRICE })),
		[picks.seed, byUsername],
	);

	const total = supportTotal(picks.anthers, directed);

	/**
	 * What the Anthers ladder currently reads as, in dollars.
	 *
	 * ⚠️ **This was `picks.anthers ?? PUBLIC_ACCESS_PRICE` until 2026-08-25**, so that the
	 * panels had a rung to describe while nobody had chosen one — a preview that was
	 * carefully kept out of `supportTotal`, since billing it would have charged people who
	 * never pressed anything. Free being the default retires the whole arrangement: there is
	 * no unanswered state left to preview, so the panels describe the real answer and this
	 * is the same number the total is built from.
	 */
	const anthersAmount = picks.anthers;

	/** The breakdown the chosen rung reads as — see `anthersReading` for the other one. */
	const anthersBreakdown = anthersReading(anthersAmount);

	/** Step 3's answer, in the shape the echo and the summary both render. Step 3 is the
	 *  Anthers ask — it was step 2 until 2026-08-17; see the resequencing note up top. */
	const anthersLines: PickLine[] = useMemo(
		() => (picks.anthers ? [anthersLineFor(picks.anthers)] : []),
		[picks.anthers],
	);

	/** Step 2's answers — one line per creator, whether followed or backed. */
	const creatorLines: PickLine[] = useMemo(
		() =>
			picks.follow.map((username) => {
				const creator = byUsername.get(username);
				return {
					key: username,
					label: creator ? nameOf(creator) : username,
					sub: picks.seed.includes(username) ? "following · supporting" : "following",
					amount: picks.seed.includes(username) ? PUBLIC_ACCESS_PRICE : 0,
				};
			}),
		[picks.follow, picks.seed, byUsername],
	);

	/**
	 * The whole page, added up once — the only place a total appears.
	 *
	 * The account comes first and the creators follow it. That account row is the Anthers
	 * step's answer as well as the account itself — see `accountLineFor` for why the two are
	 * one row — which is the single exception to the rule that this list reads in the order
	 * the page asks. The rule itself stands: the two support lines were the other way round
	 * until 2026-08-17, and a summary ordered differently from the steps above it makes a
	 * reader re-derive which line came from which choice.
	 */
	const summaryLines: PickLine[] = useMemo(
		() => [accountLineFor(picks.anthers), ...creatorLines],
		[picks.anthers, creatorLines],
	);

	/**
	 * Commit what can be committed.
	 *
	 * Signed out, the picks are already in session storage, so the account comes first and
	 * the page is waiting when they come back. Signed in, follows and creator
	 * allocations are applied, and support for Anthers opens the same confirmation modal the
	 * inline post unlock uses — one ceremony, so the charge is described identically
	 * wherever a user commits.
	 */
	/**
	 * Tell the auth context about the new session, then go.
	 *
	 * 🚨 **Refreshing the context is what unmounts this page, so it must be the LAST
	 * thing the ceremony does.** `/subscribe` renders inside `PublicShell`, which returns
	 * `LoggedOutLayout` or `LoggedInLayout` depending on `isAuthenticated`. Those are
	 * different component types, so the moment `refreshUser()` resolves React tears the
	 * subtree down and rebuilds it — and this page goes with it.
	 *
	 * That cost a real bug: verifying used to refresh immediately, so by the time the
	 * preview came back `setPending` was landing on an unmounted component and the
	 * payment modal never opened. Nothing errored. The free path appeared to work only
	 * because `navigate` still fires from a dead closure, which is exactly the kind of
	 * partial success that hides the problem.
	 *
	 * The session cookie is set at verification, so every call in between is already
	 * authenticated — the context is the only thing that doesn't know yet, and it does
	 * not need to until we are leaving.
	 */
	const leave = useCallback(
		async (path: string) => {
			await refreshUser();
			navigate(path);
		},
		[navigate, refreshUser],
	);

	const commit = useCallback(async () => {
		setBusy(true);
		setError(null);
		setSuccess(null);
		try {
			// Following costs nothing, so it is applied straight away rather than waiting on
			// a charge that may not even happen.
			for (const username of picks.follow) {
				const creator = byUsername.get(username);
				if (!creator || creator.isFollowing) continue;
				await client.api.accounts.users[":username"].follow.$post({ param: { username } });
			}

			// 🚨 `directed` and `total` come from the component, NOT from a second
			// computation here — see their definition. This function used to rebuild both,
			// which is what let the displayed and charged amounts drift apart while both
			// still went through `supportTotal`.
			//
			// The Public Access price each, to the creators picked, on the SAME charge as
			// the Anthers one. The chosen rung is billed as chosen: this read
			// `picks.anthers === true ? PUBLIC_ACCESS_PRICE : 0` while the section was a
			// yes/no, which would have billed Root for a chosen Blossom.
			const anthers = picks.anthers ?? 0;

			if (total === 0) {
				// A signed-in account owes no handle, so there is no onboarding to pass
				// through — but if it came from somewhere, that somewhere is still the point
				// of the visit, and a success message on a marketing page is not it.
				if (next) {
					await leave(next);
					return;
				}
				setSuccess(
					picks.follow.length > 0 ? "Saved — you're following them now." : "Nothing to save yet.",
				);
				return;
			}

			// Preview prices the whole charge, so the modal quotes the total the user is
			// actually agreeing to rather than the Anthers half of it.
			const res = await client.api.subscriptions.preview[":amount"].$get({
				param: { amount: String(total) },
			});
			if (!res.ok) {
				setError("Couldn't load the charge details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({
				anthersSupport: anthers,
				directed,
				// The honest label is the amount: a commit needn't land on a Badge, and
				// naming one would describe only the Anthers half of this charge.
				badgeName: `${amountLabel(total)} a month`,
				preview,
			});
		} catch {
			setError("Something went wrong. Please try again.");
		} finally {
			setBusy(false);
		}
	}, [directed, total, leave, next, picks]);

	/**
	 * Ask for the account — the pending one — and hand the visitor to the page that
	 * finishes it.
	 *
	 * 🚨 **Signing up stopped finishing here on 2026-08-26, and the reason is what the old
	 * arrangement read like.** The ceremony was a modal over this page, so the last thing
	 * asked of somebody sat on top of a page still inviting them to add and drop picks — and
	 * through the Bluesky door it was worse, because coming back from bsky.social landed on
	 * `/subscribe` with a prefilled email box, which is indistinguishable from having
	 * accomplished nothing. `/finish` is a page with one job, and the picks travel with the
	 * pending signup rather than being left behind on a page nobody is looking at.
	 */
	const beginSignup = useCallback(
		async (address?: string) => {
			await client.api.auth.signup.begin.$post({
				json: { ...(address ? { email: address } : {}), picks, ...(next ? { next } : {}) },
			});
		},
		[picks, next],
	);

	const submit = async () => {
		if (!signedIn) {
			const address = email.trim();
			if (!address) {
				setError("Add an email address so we can confirm it's you.");
				return;
			}
			setBusy(true);
			setError(null);
			try {
				// Answers 200 whatever happened, deliberately — see the route. So there is
				// nothing to branch on here, and the next page opens either way.
				await beginSignup(address);
				navigate("/finish");
			} catch {
				setError("Couldn't start your signup. Please try again.");
				setBusy(false);
			}
			// ⚠️ No `setBusy(false)` on the success path: this page is unmounting, and putting
			// the button back only invites a second press from a page that is already going.
			return;
		}
		await commit();
	};

	/**
	 * Hand off to Bluesky with the handle typed into the card.
	 *
	 * ⚠️ **`setBusy(false)` is deliberately missing from the success path**, because there
	 * is no success path to return to — `signUpWithBluesky` sets `window.location` and the
	 * browser leaves. Putting the button back would only invite a second handoff from a
	 * page that is already going.
	 *
	 * 🚨 **The pending signup is written BEFORE the handoff**, and the order is the point.
	 * The row is what the callback attaches the proved identity to, so the picks somebody
	 * made are still theirs when they come back — writing it afterwards would mean the
	 * detour through another website arrived at an empty signup, which is the defect this
	 * whole flow exists to fix.
	 */
	const startBluesky = useCallback(
		async (raw: string) => {
			// A handle is a domain name; the leading `@` is how people write it, not part of
			// it. Stripped here rather than while typing, so the field never fights anyone.
			const value = raw.trim().replace(/^@/, "");
			if (!value) {
				setError("Add your Bluesky handle so we know which account to confirm.");
				return;
			}
			setBusy(true);
			setError(null);
			try {
				await beginSignup();
				await signUpWithBluesky(value, next);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Couldn't reach Bluesky. Please try again.");
				setBusy(false);
			}
		},
		[beginSignup, signUpWithBluesky, next],
	);

	/**
	 * Everything the signup control needs, shared by the copy at the top of the page and
	 * the one at the bottom.
	 *
	 * ⚠️ **Both read the same state, so both stay honest about the same total.** Somebody
	 * who scrolls down, adds support, and scrolls back up finds the top button saying
	 * *"Create my account & continue"* rather than still promising free — which is correct:
	 * they chose to pay. What must never happen is the two disagreeing.
	 */
	const signupProps = {
		cta: signedIn
			? total > 0
				? "Confirm and continue"
				: "Save my picks"
			: total > 0
				? "Create my account & continue"
				: "Create my free account",
		busy,
		error,
		success,
		email: signedIn ? null : email,
		onEmailChange: setEmail,
		note: signupNote(signedIn, total > 0, door),
		noteSizers: signupNoteSizers(signedIn),
		onSubmit: submit,
		// Offered only to somebody signed out, and only while the door is actually open —
		// see `blueskySignupOpen` for why a button that refuses is worse than no button.
		onBluesky: signedIn || !blueskySignupOpen ? null : startBluesky,
		handle,
		onHandleChange: setHandle,
		door,
		onDoorChange: setDoor,
	};

	const summaryProps = {
		...signupProps,
		lines: summaryLines,
		accountSizers: SUMMARY_ACCOUNT_SIZERS,
		total,
		onDrop: dropPick,
	};

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade so this wrapper can
		// shrink below its content's min-content width on mobile; without `w-full`,
		// `mx-auto` on a flex item disables the default `align-self: stretch`.
		//
		// 🚨 ONE max-width, never two. This carried `max-w-full max-w-[80rem]` (inherited
		// from the page it replaced), and Tailwind resolves that pair by source order in
		// the generated stylesheet, not by order in the attribute — `.max-w-full` is
		// emitted last, so it won and the page ran the full width of the viewport at every
		// size. Nothing errors; the cap is simply never applied, which reads as a scattered
		// layout rather than as a bug.
		//
		// ⚠️ **88rem is wider than the shared marketing `Section` (`max-w-6xl`, 72rem), and
		// that is deliberate but temporary** (Parker, 2026-08-23): the whole site is due a
		// size and layout pass to widen its columns and size its text up, and this page went
		// first because it was being rebuilt anyway. When that pass lands, this number should
		// become whatever `Section` settles on rather than staying a local exception.
		<div className="mx-auto min-w-0 w-full max-w-[88rem] px-6 py-12 sm:py-16">
			<div className="min-w-0">
				<div>
					{/* ── Join, before anything is asked for ─────────────────── */}
					<Reveal>
						<div className="text-center">
							<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
								A non-profit · no ads, no shareholders, no strings
							</p>
							<h1
								style={serif}
								className="mt-4 text-balance text-4xl font-light leading-tight sm:text-5xl"
							>
								Anthers is free. Forever.
							</h1>
							<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/65">
								No card required, no trial period, no ads or sneaky charges. We believe amazing
								creative and educational content should be free for all, no strings attached.
							</p>

							<FreeInclusions />

							{/* The turn from the list into the act. Without it the card arrives as a
							    form somebody has to work out the purpose of; with it, the five
							    inclusions above are the offer and this is the answer to them. */}
							<p
								style={serif}
								className="mx-auto mt-14 max-w-2xl text-balance text-2xl font-light leading-snug"
							>
								If that sounds good, sign up for free below and let&rsquo;s get started.
							</p>

							<div className="mx-auto mt-6 max-w-md">
								<SignupForm idPrefix="top" {...signupProps} />
							</div>
						</div>

						{/* What support is, as the tail of "it's free" rather than as its own step: the
						    primitive is one sentence, and giving it a numbered step of its own made the
						    page look like it asked three things when it asks two.
						    ⚠️ The old copy said "a monthly amount, from $3". There is no floor of $3 —
						    that is what unlimited Public Access costs, and a creator sets their own
						    levels to any amount at all. Naming a floor describes a mechanism the Seed
						    retirement removed.
						    ⭐ Each card is now a door into the section that asks for it, rather than a
						    description a reader has to hold in their head while scrolling past two more
						    screens to find the control it described. */}
						<div className="mt-14">
							<p className="mx-auto max-w-2xl text-center text-lg leading-relaxed text-base-content/65">
								<strong>Everything above is free forever</strong>, but there is more to love on
								Anthers if you want it. You can add either of these now, or at any point in the
								future.
							</p>
							<div className="mx-auto mt-6 grid max-w-4xl gap-4 sm:grid-cols-2">
								<GoFurtherCard icon={HeartIcon} title="Support creators" target="creator-badges">
									Every creator has work that is free to everyone and work they gate behind a
									monthly subscription level (called a Badge) or a direct purchase.
									<br></br>
									<br></br>
									If you have any creators you want to go ahead and subscribe to, you can do that
									now.
								</GoFurtherCard>
								<GoFurtherCard icon={SparklesIcon} title="Support Anthers" target="anthers-badges">
									Just {money(PUBLIC_ACCESS_PRICE)}/month takes the monthly limit off Public Access
									usage, and it lifts your automatic support for creators from{" "}
									{money(FREE_TIME_POOL)}/month to {money(timePoolFor(PUBLIC_ACCESS_PRICE))}/month.
									<br></br>
									<br></br>
									Your Anthers Badge also funds free access for small users and creators and other
									charitable programs.
								</GoFurtherCard>
							</div>
						</div>
					</Reveal>

					{/* ── 1 · Support for a creator — the primary ask ───────────
					    The `id` is the target of the "Support creators" door up top, and the
					    `scroll-mt` keeps the heading clear of the sticky header when it lands. */}
					<Reveal
						delay={80}
						id="creator-badges"
						className="mt-16 scroll-mt-24 border-t border-base-content/10 pt-14"
					>
						<StepHeading n={1} title="Creator Badges">
							Creators each have monthly subscription tiers called Badges that unlock special
							content, behind-the-scenes access, and more. And when you support a creator with a
							subscription or purchase, Anthers takes no cut, no exceptions.
						</StepHeading>
						<SeedBreakdown
							segments={[
								{
									tone: "pool",
									amount: CREATOR_NET,
									label: "Straight to the creator",
									desc: "recurring support, and it clears whichever of their levels it reaches",
								},
								{
									tone: "pay",
									amount: ANTHERS_PAYMENTS,
									label: "Payments",
									desc: "card & processing, at cost, paid to the processor",
								},
							]}
							note="This is the worst-case scenario (one subscription/month). The more you support the creators you love, the more of every dollar they receive."
						/>
						<p className="mx-auto mt-12 max-w-3xl text-center text-lg leading-relaxed text-base-content/65">
							<strong>Anyone you&rsquo;d like to start with?</strong> Search for someone by name, or
							tap a medium to meet a few. Following is free — support someone when you&rsquo;d like
							to back them.
						</p>
						<CreatorFinder
							creators={creators}
							loading={loadingCreators}
							picks={picks}
							onToggle={toggleCreator}
						/>
						<SectionEcho
							lines={creatorLines}
							onDrop={dropPick}
							empty="No creators picked yet — following is free whenever you're ready."
						/>
					</Reveal>

					{/* ── 2 · Support for Anthers — the optional second thing ───
					    🚨 The one section this page must not let read as a requirement. Plenty of
					    people will be served entirely by purchases, creator support and the free
					    hours, and that is a fine way to use Anthers rather than a lapse to nudge
					    somebody out of. The heading's first words say so before the numbers do. */}
					<Reveal
						delay={80}
						id="anthers-badges"
						className="mt-16 scroll-mt-24 border-t border-base-content/10 pt-14"
					>
						<StepHeading n={2} title="Anthers Badges">
							Anthers' free Public Access has no strings, ever; you can stay free as long as you
							like, supporting creators directly with subscriptions and direct purchases. But if you
							want a little extra from Anthers, you can support us directly, as well. You'll unlock
							new perks for yourself and support free access for small users and creators along with
							a variety of other charitable programs.
						</StepHeading>
						{/* ⭐ The ladder replaced a yes/no card on 2026-08-24. A boolean could only ask
						    about the first rung, so Sprout, Petal and Blossom existed in the model and
						    nowhere in the UI — and "Support Anthers too?" framed the whole section as a
						    request rather than a choice. Choosing a rung is the ask now, Free included,
						    and the breakdown below moves with the choice — starting on Free, which is
						    where an account with no support for Anthers already sits. */}
						<BadgeLadder
							idPrefix="anthers-ladder"
							value={picks.anthers}
							onChange={(v) => setPicks((prev) => ({ ...prev, anthers: v }))}
						/>
						{/* 🚨 **Always rendered, including for Free** (Parker, 2026-08-24). It used to
						    be hidden at $0, which made choosing Free shrink the page — and the
						    background art is positioned against page height, so the whole backdrop
						    jumped. A control whose job is comparison must not resize the thing it
						    sits in when you use it. Both readings are in `anthersReading`; `total` is
						    overridden to the $0 Free is actually charged. */}
						<SeedBreakdown
							total={anthersAmount > 0 ? undefined : 0}
							segments={anthersBreakdown.segments}
							note={anthersBreakdown.note}
							// The reading it is NOT showing, so the panel is as tall as either one.
							sizers={[anthersReading(anthersAmount > 0 ? 0 : PUBLIC_ACCESS_PRICE)]}
						/>
						{/* ⚠️ One empty state now, because there is one way to be empty: Free. This
						    carried a second line for "hasn't chosen yet", which stopped being
						    reachable when Free became the rung a visitor starts on. */}
						<SectionEcho
							lines={anthersLines}
							onDrop={dropPick}
							sizers={ANTHERS_ECHO_SIZERS}
							empty={`Staying free — ${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month.`}
						/>
					</Reveal>

					{/* ── The one place it all adds up ───────────────────────── */}
					<Reveal delay={80} className="mt-16 border-t border-base-content/10 pt-14">
						<h2 style={serif} className="text-center text-3xl font-light leading-tight sm:text-4xl">
							Ready when you are
						</h2>
						<p className="mx-auto mt-4 max-w-2xl text-center text-lg leading-relaxed text-base-content/65">
							Everything you chose along the way, in one place.
						</p>
						<Summary {...summaryProps} />
						{/* ⚠️ This carried the same {money(FREE_TIME_POOL)} sentence the free
						    inclusions now open the page with. Repeating a fact at both ends of a
						    long page reads as a copy bug; what belongs *here* is not the mechanism
						    but the reassurance, at the one moment somebody is deciding whether
						    they have chosen enough. They have. */}
						<p className="mx-auto mt-5 max-w-xl text-center text-xs leading-relaxed text-base-content/45">
							Choosing nothing here is a complete answer — a free account still pays creators for
							the time you give them.
						</p>
					</Reveal>

					{/* Why non-profit */}
					<div className="mx-auto mt-16 max-w-3xl pb-4 text-center">
						<h2 style={serif} className="mb-4 text-2xl font-light sm:text-3xl">
							Why non-profit
						</h2>
						<p className="mx-auto max-w-2xl text-sm leading-relaxed text-base-content/60">
							Anthers is a non-profit because the only way to guarantee that our platform always
							serves creators is to make it legally impossible for it to act otherwise. Anthers
							cannot distribute profits to insiders, cannot be acquired, and cannot have its mission
							diluted by investors. If it ever ceases to operate, its assets go to another exempt
							organization, not to founders or shareholders.
						</p>
					</div>

					{/* ── Questions ─────────────────────────────────────────────
					    🚨 Last on this page, and that is the opposite of where the same block
					    sits on /for-users and /for-creators. Those are pages somebody reads and
					    then acts on, so their FAQ goes above the closing CTA. This page's
					    control is at the TOP — a visitor can join from the first screen and
					    never scroll — so everything below the summary is for the reader who did
					    scroll, and is still deciding. Their remaining doubts belong at the end
					    of that scroll rather than in front of a button they have already passed
					    twice.

					    The six questions are the ones asked with a hand on the button — what
					    this costs, what free covers, whether it can be undone — and they are
					    the same objects /faq renders, from `content/faq.tsx`. */}
					<Reveal delay={80} className="mt-16 border-t border-base-content/10 pt-14">
						<div className="text-center">
							<FAQBlock surface="signup" />
						</div>
					</Reveal>
				</div>
			</div>

			{/* ⚠️ **The only modal left on this page, and it belongs to somebody already signed
			    in.** A visitor signing up meets no layer here at all — they are handed to
			    `/finish`, where the same confirmation ceremony runs on a page whose whole job
			    is finishing. One ceremony, so a charge is described identically wherever it is
			    agreed to. */}
			{pending && (
				<SubscriptionPaymentModal
					anthersSupport={pending.anthersSupport}
					directed={pending.directed}
					badgeName={pending.badgeName}
					preview={pending.preview}
					onComplete={() => {
						setPending(null);
						// `next` rides along so somebody who came from a gated Work is handed back
						// to it; otherwise, to where the webhook's work becomes visible.
						void leave(next ?? "/subscription");
					}}
					onClose={() => {
						// The card was declined or dismissed. The account was already signed in
						// when this opened, so there is nothing to unwind and nowhere to send them.
						setPending(null);
					}}
				/>
			)}
		</div>
	);
}
