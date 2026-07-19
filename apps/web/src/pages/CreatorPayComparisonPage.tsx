// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resource: "How our pay compares" — a dense, information-first head-to-head of
// what reaches a creator on Anthers versus each platform they already know. One
// tab per platform (YouTube, Spotify, Steam, Bandcamp, Patreon, Substack); each
// tab shows the relevant transaction(s) side by side.
//
// Framing (V4 "Big Rethink"): lead with the 0% cut. Anthers takes NOTHING out of
// what reaches a creator — 100% of every Seed and every direct sale is theirs, and
// the Time Pool (funded by viewers' chosen Badge plans) is distributed to creators
// by watch-time. The one thing added is the Community Share: a
// small charitable contribution the fan chooses on top as part of their plan price,
// funding free access + creator programs. It is NOT skimmed from creator earnings.
//   • On a direct sale the creator receives the full listed price; the Community
//     Share is a charitable markup on that download's bandwidth (≈50% of it), added
//     on top for the buyer — a fraction of a cent — never subtracted.
//   • On a Seed there is no fee at all — $1, 100% to the creator.
//   • On streaming the creator earns their watch-time share of every viewer's Time
//     Pool, the same rate for every medium (equal-time). Anthers profits $0.
//
// Positioning (important): streaming is a secondary financial benefit, not the
// headline. Under equal-time a music hour earns the same Time Pool share as a video
// hour (V3's per-GiB penalty on cheap-to-stream media is gone), so we no longer
// under-pay music — but we deliberately do NOT pitch streaming as out-earning
// YouTube/Spotify per hour. Its real value is reach: your public work is available
// effectively at cost, with no ads and no profit-taking. The earnings levers are
// Seeds and direct sales, and those are 100% yours.
//
// Anthers figures derive from packages/shared/src/constants.ts (BADGE_PLANS Time
// Pool + Seeds, BANDWIDTH_PER_GIB $0.01 at cost, Digital AFF = 50% of a download's
// bandwidth, Physical & Service AFF 1%). Competitor figures are their public rates.
//
// Styled like the calculators (dense, DaisyUI-native, plain — no Meadow decor), so
// it reads as one set with the rest of Resources.

import { BADGE_PLANS } from "@anthers/shared/constants";
import { Link } from "@anthers/web-shared/router";
import { useState } from "react";
import { CalcNotes, CalcPageHeader, SegControl } from "../components/calculators/ui";

// ─── Comparison data ─────────────────────────────────────────────────────────

/** How a "cut" reads: charitable Community Share, for-profit skim, or nothing. */
type CutKind = "charity" | "profit" | "none";

interface Side {
	/** Headline: what reaches the creator (a $ figure or a share). */
	keep: string;
	/** The basis under the headline. */
	keepSub?: string;
	/** What this party takes on the transaction. */
	cut: string;
	/** Nature of that take (drives the label + tone). Defaults to for-profit. */
	cutKind?: CutKind;
}

interface Matchup {
	/** The representative transaction. */
	scenario: string;
	/** Short tag: Streaming / Digital / Physical / Subscription / Purchase. */
	kind: string;
	anthers: Side;
	rival: Side;
	/** An honest one-line caveat. */
	note?: string;
}

interface Platform {
	id: string;
	label: string;
	/** One line: what they are + their headline take. */
	blurb: string;
	matchups: Matchup[];
}

// The paid Badge plans set the Time Pool a fan brings each month (Root $2 · Sprout
// $4 · Petal $9 · Blossom $18). Split across everyone they watch by watch-time, that
// lands roughly $0.05–0.60 per view-hour depending on plan and how much they watch —
// the same rate for every medium (equal-time). 100% of it reaches creators.
const PAID_POOLS = (["root", "sprout", "petal", "blossom"] as const).map(
	(b) => BADGE_PLANS[b].timePool,
);
const POOL_RANGE = `$${PAID_POOLS[0]}–$${PAID_POOLS[PAID_POOLS.length - 1]}`;

// Anthers's per-transaction facts, reused across tabs. Streaming and Seeds take a
// literal $0 from the creator; a sale's only add is the charitable Community Share,
// a markup on delivery bandwidth added on top for the buyer — never subtracted.
const A_STREAM: Side = {
	keep: "~$0.05–0.60 / hr",
	keepSub: "your watch-time share of the fan's monthly Time Pool — the same rate for every medium",
	cut: "$0",
	cutKind: "none",
};
/** A direct sale: creator keeps the full listed price; the Community Share is the
 * (small) charitable markup on the delivery, added on top for the buyer. */
const aPrice = (amount: string, share: string): Side => ({
	keep: amount,
	keepSub: "100% — your listed price, in full",
	cut: share,
	cutKind: "charity",
});
const A_SEED: Side = {
	keep: "$5.00",
	keepSub: "100% — five $1 Seeds, no fee and no payout processing",
	cut: "$0",
	cutKind: "none",
};

const PLATFORMS: Platform[] = [
	{
		id: "youtube",
		label: "YouTube",
		blurb: "Ad-supported video. Creators get 45% of the ad/Premium revenue their views generate.",
		matchups: [
			{
				scenario: "A fan streams 1 hour of your 1080p video",
				kind: "Streaming",
				anthers: A_STREAM,
				rival: {
					keep: "45% of the revenue",
					keepSub: "≈ $0.05–0.20/hr on Premium (a ~$16 sub pooled by watch-time); pennies on ads",
					cut: "55%",
				},
				note: "A fan's Badge plan sets a monthly Time Pool that's split across everyone they watch, by watch-time — 100% reaches creators, Anthers profits $0. Per hour that lands roughly where YouTube Premium does, but we don't lead with streaming: there are no ads and no profit-taking, and your real earnings come from Seeds and direct sales. Streaming's value is reach — your public work is available effectively at cost.",
			},
		],
	},
	{
		id: "spotify",
		label: "Spotify",
		blurb:
			"Music streaming. ~$0.004 per stream to the rights-holder, before a label or distributor takes its share.",
		matchups: [
			{
				scenario: "A fan listens to 1 hour of your music",
				kind: "Streaming",
				anthers: A_STREAM,
				rival: {
					keep: "~$0.069 / hr",
					keepSub: "$0.004/stream × ~17 songs (3:30 each); an artist keeps less after their label",
					cut: "~30% + labels",
				},
				note: "Equal-time means a music hour earns the same Time Pool share as a video hour — no per-stream micro-payment, no penalty for cheap-to-stream media. Depending on the fan's plan that's roughly comparable to Spotify, and ad-free. But streaming isn't where the money is: Seeds and direct album/merch sales are, and those are 100% yours.",
			},
		],
	},
	{
		id: "steam",
		label: "Steam",
		blurb: "Game storefront. Takes 30% of every sale (25% above $10M, 20% above $50M).",
		matchups: [
			{
				scenario: "A fan buys your $10 game",
				kind: "Digital purchase",
				anthers: aPrice("$10.00", "~$0.01 · on top"),
				rival: { keep: "$7.00", keepSub: "70%", cut: "30% (≈ $3.00)" },
				note: "Anthers's only add here is the Community Share on the download bandwidth — about a cent, a charitable contribution added on top for the buyer, so your $10 reaches you whole. Steam's 30% comes out of your sale.",
			},
		],
	},
	{
		id: "bandcamp",
		label: "Bandcamp",
		blurb:
			"Direct-to-fan music store. 15% on digital (10% after $5k/yr in sales), 10% on physical.",
		matchups: [
			{
				scenario: "A fan buys your $10 album (download)",
				kind: "Digital purchase",
				anthers: aPrice("$10.00", "pennies · on top"),
				rival: {
					keep: "$8.50",
					keepSub: "85%, before payment processing",
					cut: "15% (→ 10% after $5k/yr)",
				},
				note: "Our only add is the Community Share on delivery — pennies of charity added on top; your $10 is untouched. Bandcamp takes 15% of your sale and also deducts payment processing from your cut.",
			},
			{
				scenario: "A fan buys your $25 vinyl",
				kind: "Physical purchase",
				anthers: aPrice("$25.00", "$0.25 · 1% on top"),
				rival: { keep: "$22.50", keepSub: "90%, before processing", cut: "10% (≈ $2.50)" },
				note: "Nothing ships through us, so the Community Share is a flat 1% ($0.25), added on top for the buyer — your $25 is whole. Excludes production & shipping, a real cost on any platform.",
			},
		],
	},
	{
		id: "patreon",
		label: "Patreon",
		blurb:
			"Membership platform. 10% on subscriptions, 5–12% on one-time purchases, plus payment processing.",
		matchups: [
			{
				scenario: "A fan supports you $5 / month",
				kind: "Seeds",
				anthers: A_SEED,
				rival: {
					keep: "$4.50",
					keepSub: "90% before processing → nets ~$4.05",
					cut: "10% + processing",
				},
				note: "A Seed is $1 sent straight to a creator — no fee, no payout processing; the supporter covers the card fee on top (~$5.45 charged for five). Patreon takes 10%, then card processing comes out of what's left.",
			},
			{
				scenario: "A fan buys a $10 one-time item",
				kind: "Purchase",
				anthers: aPrice("$10.00", "pennies · on top"),
				rival: {
					keep: "$8.80–9.50",
					keepSub: "88–95% before processing",
					cut: "5–12% + processing",
				},
			},
		],
	},
	{
		id: "substack",
		label: "Substack",
		blurb: "Paid-newsletter platform. 10% on all subscriptions, plus Stripe payment processing.",
		matchups: [
			{
				scenario: "A fan subscribes at $5 / month",
				kind: "Seeds",
				anthers: A_SEED,
				rival: {
					keep: "$4.50",
					keepSub: "90% before processing → nets ~$4.05",
					cut: "10% + processing",
				},
				note: "Five $1 Seeds reach you in full — no fee and no payout processing; the supporter covers the card fee on top. Substack takes 10%, then Stripe processing (~$0.45 on $5) comes out of your cut.",
			},
		],
	},
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CreatorPayComparisonPage() {
	const [platformId, setPlatformId] = useState(PLATFORMS[0].id);
	const platform = PLATFORMS.find((p) => p.id === platformId) ?? PLATFORMS[0];

	return (
		<div className="max-w-4xl mx-auto px-4 pb-16">
			<CalcPageHeader
				eyebrow="Creator pay · head-to-head"
				title="How our pay compares"
				lede={
					<>
						Anthers takes <b className="text-base-content">0%</b> of what reaches you: every{" "}
						<b className="text-base-content">Seed</b> and every direct sale is 100% yours, and the
						Time Pool is distributed to creators by watch-time. The one thing we add is the{" "}
						<b className="text-base-content">Community Share</b> — a small charitable contribution
						the fan chooses on top of their plan, funding free access and creator programs, never
						subtracted from your earnings. Here's what actually reaches you, platform by platform.
					</>
				}
			/>

			<div className="sticky top-0 z-10 -mx-4 bg-base-100/90 px-4 py-3 backdrop-blur">
				<SegControl
					ariaLabel="Platform to compare against"
					value={platformId}
					onChange={setPlatformId}
					options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
				/>
			</div>

			<div className="mt-4">
				<p className="text-sm text-base-content/60 mb-4">
					<b className="text-base-content">{platform.label}.</b> {platform.blurb}
				</p>

				<div className="space-y-4">
					{platform.matchups.map((m) => (
						<MatchupCard key={m.scenario} m={m} rivalName={platform.label} />
					))}
				</div>
			</div>

			<div className="mt-6 rounded-xl border border-dashed border-base-300 bg-base-200/40 p-4 text-sm leading-relaxed text-base-content/70">
				<b className="text-base-content">The bottom line.</b> Nothing Anthers does comes out of your
				earnings. You keep <b className="text-base-content">100%</b> of every Seed and every sale,
				and the Time Pool reaches creators in full. Where we clearly win is Seeds and purchases.
				Streaming we treat as a public good, not a paycheck: under equal-time a music hour now earns
				the same as a video hour (no more per-medium penalty), it's ad-free — but we won't pretend a
				view-hour out-earns YouTube or Spotify. It makes your work discoverable at cost; your income
				comes from the fans who Seed and buy.
			</div>

			<CalcNotes>
				<p>
					<b className="text-base-content/70">How the money moves.</b> Nothing Anthers does comes
					out of what reaches creators. A fan chooses a monthly{" "}
					<b className="text-base-content/70">Badge plan</b> whose price splits into a Time Pool
					(distributed to the creators they watch, by watch-time), directed <b>Seeds</b> ($1 units,
					100% to a creator), and the <b className="text-base-content/70">Community Share</b> — a
					charitable remainder funding free access and creator programs. Bandwidth is a separate
					at-cost wallet with a free monthly allowance, not a creator-funding lever. On a direct
					sale the creator receives the full listed price; the Community Share there is a charitable
					markup on that download's bandwidth (about half of it) or a flat 1% on physical goods,
					added on top for the buyer.
				</p>
				<p>
					<b className="text-base-content/70">Anthers streaming figures</b> are a fan's Time Pool ÷
					their monthly watch-time, the same rate for every medium (equal-time). The paid plans
					bring{" "}
					{PAID_POOLS.map((p, i) => `${["Root", "Sprout", "Petal", "Blossom"][i]} $${p}`).join(
						" · ",
					)}{" "}
					of Time Pool, so an engaged fan lands roughly {POOL_RANGE} of pool per month → about
					$0.05–0.60 per view-hour. <b className="text-base-content/70">Competitor figures</b> are
					each platform's public fee and payout structure on the same transaction — rough estimates,
					not quotes, and before their own payment-processing deductions except where noted. A
					planning comparison, not an offer or guarantee.
				</p>
				<p>
					Want to model your own audience?{" "}
					<Link to="/resources/creator-monetization" className="link link-primary">
						Creator Monetization Calculator
					</Link>{" "}
					·{" "}
					<Link to="/for-creators" className="link link-primary">
						How the model works
					</Link>
				</p>
			</CalcNotes>
		</div>
	);
}

/** One transaction, Anthers vs the rival, side by side. Anthers is tinted green. */
function MatchupCard({ m, rivalName }: { m: Matchup; rivalName: string }) {
	return (
		<div className="rounded-xl border border-base-300 bg-base-100 overflow-hidden">
			<div className="flex items-center justify-between gap-3 border-b border-base-300 bg-base-200/50 px-4 py-2.5">
				<span className="text-sm font-medium">{m.scenario}</span>
				<span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-base-content/45">
					{m.kind}
				</span>
			</div>
			<div className="grid grid-cols-1 divide-y divide-base-300 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
				<SideCell name="Anthers" side={m.anthers} highlight />
				<SideCell name={rivalName} side={m.rival} />
			</div>
			{m.note && (
				<p className="border-t border-base-300 bg-base-200/30 px-4 py-2.5 text-xs leading-relaxed text-base-content/55">
					{m.note}
				</p>
			)}
		</div>
	);
}

// How each cut renders: tone for the amount + a plain-language tag for its nature.
const CUT_STYLE: Record<CutKind, { tone: string; tag: string; tagTone: string }> = {
	profit: { tone: "text-error/80", tag: "to the platform", tagTone: "text-error/50" },
	charity: {
		tone: "text-base-content/70",
		tag: "Community Share · charity, on top",
		tagTone: "text-primary/70",
	},
	none: { tone: "text-success/80", tag: "no cut — 100% to creators", tagTone: "text-success/60" },
};

/** One side of a matchup: who, the take-home headline, its basis, and the cut —
 * with the cut's nature (charity / profit / none) named, never hidden as "$0". */
function SideCell({ name, side, highlight }: { name: string; side: Side; highlight?: boolean }) {
	const style = CUT_STYLE[side.cutKind ?? "profit"];
	return (
		<div className={`p-4 ${highlight ? "bg-success/[0.06]" : ""}`}>
			<p
				className={`text-xs font-semibold uppercase tracking-wide ${
					highlight ? "text-success" : "text-base-content/60"
				}`}
			>
				{name}
			</p>
			<p className="mt-0.5 text-[10px] uppercase tracking-wide text-base-content/40">
				to the creator
			</p>
			<p
				className={`mt-1 font-mono text-2xl font-bold leading-none tabular-nums ${
					highlight ? "text-success" : "text-base-content"
				}`}
			>
				{side.keep}
			</p>
			{side.keepSub && (
				<p className="mt-1.5 text-xs leading-snug text-base-content/50">{side.keepSub}</p>
			)}
			<div className="mt-2.5 border-t border-base-300/70 pt-2">
				<p className="text-[10px] uppercase tracking-wide text-base-content/40">{name}'s cut</p>
				<p className={`font-mono text-xs ${style.tone}`}>{side.cut}</p>
				<p className={`text-[10px] ${style.tagTone}`}>{style.tag}</p>
			</div>
		</div>
	);
}
