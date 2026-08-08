// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resource: "How our pay compares" — a dense, information-first head-to-head of
// what reaches a creator on Anthers versus each platform they already know. One
// tab per platform (YouTube, Spotify, Steam, Bandcamp, Patreon, Substack); each
// tab shows the relevant transaction(s) side by side.
//
// Framing (the support model): lead with the 0% cut. Anthers takes NOTHING from any
// creator transaction — no fee on a Seed, no fee on a sale — and the Time Pool
// (funded by the Anthers-Seeds fans point at the platform) is distributed to
// creators by watch-time.
//   • Since 2026-08-03 the at-cost card fee comes OUT of the price rather than
//     riding on top, because mandatory-fee disclosure law requires an advertised
//     price to contain every mandatory fee. So the honest claim is "Anthers takes
//     no cut" — unconditionally true — NOT "100% to the creator", which is retired.
//   • On a direct sale the creator receives the listed price less at-cost card
//     processing and the buyer's first download. Both go to third parties.
//   • On a Seed there is no platform fee at all; only the pro-rata share of the
//     at-cost card fee on the fan's whole monthly charge comes out.
//
// EVERY row is all-in take-home at the same list price, per 63.01 § Comparisons.
// Rival figures include THEIR payment processing, because every platform pays the
// same card cost — comparing our all-in against their headline cut would flatter us
// and a creator would catch it. Where a rival wins (Steam below ~$1.15) or ties
// (Bandcamp Friday), the row says so. Competitor rates checked 2026-08-03 and
// perishable — re-check before publishing.
//   • On streaming the creator earns their watch-time share of every viewer's Time
//     Pool ($1.50 per Anthers-Seed), the same rate for every medium (equal-time).
//     Anthers profits $0.
//
// Positioning (important): streaming is a secondary financial benefit, not the
// headline. Under equal-time a music hour earns the same Time Pool share as a video
// hour (V3's per-GiB penalty on cheap-to-stream media is gone), so we no longer
// under-pay music — but we deliberately do NOT pitch streaming as out-earning
// YouTube/Spotify per hour. Its real value is reach: your public work is available
// effectively at cost, with no ads and no profit-taking. The earnings levers are
// Seeds and direct sales, and Anthers takes no cut of either.
//
// Anthers figures derive from packages/shared/src/constants.ts (SEED_PRICE $3,
// TIME_POOL_PER_SEED $1.50, BANDWIDTH_PER_GIB $0.01 at cost). There is no platform
// fee on a purchase — it was removed 2026-08-03. Competitor figures are their public
// rates, checked 2026-08-03 and perishable; re-check before publishing.
//
// Styled like the calculators (dense, DaisyUI-native, plain — no Meadow decor), so
// it reads as one set with the rest of Resources.

import {
	CARD_FLAT,
	CARD_RATE,
	SEED_PRICE,
	TIME_POOL_PER_SEED,
	thresholdForBadge,
	timePoolFor,
} from "@anthers/shared/constants";
import { Link } from "@anthers/web-shared/router";
import { useState } from "react";
import { CalcNotes, CalcPageHeader, SegControl } from "../components/calculators/ui";

// ─── Comparison data ─────────────────────────────────────────────────────────

/** How a "cut" reads: a for-profit skim (out of the creator's share), or nothing at
 * all. `foundation` is retained for the type but is no longer used on any row —
 * Anthers takes $0 from every creator transaction. */
type CutKind = "foundation" | "profit" | "none";

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

// A fan's Anthers-Seed count sets the Time Pool they bring each month ($1.50 per
// Seed: Root $1.50 · Sprout $3 · Petal $4.50 · Blossom $6, and it keeps climbing past
// Blossom). Split across everyone they watch by watch-time, that lands roughly
// $0.03–0.60 per view-hour depending on how many Seeds they hold and how much they
// watch — the same rate for every medium (equal-time). Anthers takes none of it.
const RANKS = ["root", "sprout", "petal", "blossom"] as const;
const PAID_POOLS = RANKS.map((b) => timePoolFor(thresholdForBadge(b)));
const money = (n: number) => `$${n.toFixed(2)}`;
const POOL_RANGE = `${money(PAID_POOLS[0])}–${money(PAID_POOLS[PAID_POOLS.length - 1])}`;
/** The reference streamer both this page and /for-creators quote: Sprout (2 Anthers-
 *  Seeds), ~28 watch-hours a month → their Time Pool ÷ those hours. */
const REF_HOURS = 28;
const REF_HR_PAY = money(timePoolFor(thresholdForBadge("sprout")) / REF_HOURS);

// The Seed scenario: Seeds are whole $3 units, so the membership matchups use two of
// them ($6/month) and the rival rows are scaled to the same $6.
const SEED_COUNT = 2;
const SEED_SPEND = SEED_PRICE * SEED_COUNT;
/** What a rival keeps of the same $6 after its headline cut, and its card cost. */
const rivalKeeps = (cutRate: number) => money(SEED_SPEND * (1 - cutRate));
const CARD_ON_SEEDS = money(SEED_SPEND * CARD_RATE + CARD_FLAT);
/** What Anthers delivers on the same $6: the Seeds less the at-cost card fee, and no cut. */
const SEED_NET = money(SEED_SPEND - (SEED_SPEND * CARD_RATE + CARD_FLAT));
/** What Patreon delivers on the same $6: 10% platform fee, then the same card cost. */
const RIVAL_SEED_NET = money(SEED_SPEND * 0.9 - (SEED_SPEND * CARD_RATE + CARD_FLAT));

// Anthers's per-transaction facts, reused across tabs. Anthers's cut is a literal
// $0 everywhere; what comes out of a price is at-cost card processing (to the
// processor) and, on a digital sale, the buyer's first download (to the CDN).
const A_STREAM: Side = {
	keep: "~$0.03–0.60 / hr",
	keepSub: `your watch-time share of the fan's monthly Time Pool — the same rate for every medium (a Sprout fan watching ~${REF_HOURS} hrs pays ~${REF_HR_PAY}/hr)`,
	cut: "$0",
	cutKind: "none",
};
/** A direct sale. Anthers's cut is a literal $0 — what comes out of the listed
 * price is at-cost card processing and the buyer's first download, both paid to
 * third parties. `net` is what actually reaches the creator. */
const aPrice = (list: string, net: string): Side => ({
	keep: net,
	keepSub: `your ${list} list, less at-cost card processing and the first download — Anthers takes none of it`,
	cut: "$0",
	cutKind: "none",
});
const A_SEED: Side = {
	keep: SEED_NET,
	keepSub: `${SEED_COUNT} × $${SEED_PRICE} Seeds less the at-cost card fee (${CARD_ON_SEEDS} on the whole monthly charge) — no platform cut, no payout processing`,
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
				note: "The Seeds a fan gives Anthers set a monthly Time Pool ($1.50 each) that's split across everyone they watch, by watch-time — Anthers takes none of it and profits $0. Per hour that lands roughly where YouTube Premium does, but we don't lead with streaming: there are no ads and no profit-taking, and your real earnings come from Seeds and direct sales. Streaming's value is reach — your public work is available effectively at cost.",
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
				note: `Equal-time means a music hour earns the same Time Pool share as a video hour — no per-stream micro-payment, no penalty for cheap-to-stream media. Depending on how many Seeds the fan gives Anthers that's roughly comparable to Spotify, and ad-free. But streaming isn't where the money is: Seeds and direct album/merch sales are, and Anthers takes no cut of either.`,
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
				anthers: aPrice("$10.00", "$9.40"),
				rival: {
					keep: "$7.00",
					keepSub: "70% — Valve absorbs card processing inside its 30%",
					cut: "30% (≈ $3.00)",
				},
				note: "Both figures are all-in take-home. Anthers takes $0; the $0.60 that leaves your $10 is card processing and the buyer's first download, paid to third parties. Steam's $3.00 is a cut. One honest caveat: below about $1.15 Steam pays MORE, because their 30% on a $1 sale is roughly the flat card fee and they absorb processing — a percentage model beats a flat-fee model at the very bottom.",
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
				anthers: aPrice("$10.00", "$9.40"),
				rival: {
					keep: "$7.91",
					keepSub: "85% less the same card processing everyone pays (→ 90% after $5k in sales)",
					cut: "15% (→ 10% after $5k)",
				},
				note: "Both figures are all-in. Bandcamp's headline is 15%, but processing comes out of the remainder too, so the honest comparison is $9.40 against $7.91 — not $9.40 against $8.50. Worth conceding: on Bandcamp Friday they waive the revenue share entirely, which puts an artist at about $9.41 — their best day is our every day.",
			},
			{
				scenario: "A fan buys your $25 vinyl",
				kind: "Physical purchase",
				anthers: aPrice("$25.00", "$23.97"),
				rival: {
					keep: "$21.47",
					keepSub: "90% less the same card processing",
					cut: "10% (≈ $2.50)",
				},
				note: "Both all-in. Nothing ships through us and there is no fee on a sale, so the only deduction from your $25 is card processing. Excludes production & shipping, a real cost on any platform.",
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
				scenario: `A fan supports you $${SEED_SPEND} / month`,
				kind: "Seeds",
				anthers: A_SEED,
				rival: {
					keep: RIVAL_SEED_NET,
					keepSub: `${rivalKeeps(0.1)} after their 10%, less the same card processing`,
					cut: "10% + processing",
				},
				note: `Both figures are all-in take-home on the same $${SEED_SPEND}. Anthers takes $0 — the only deduction is the at-cost card fee (~${CARD_ON_SEEDS} here), charged once on the fan's WHOLE monthly charge. That is the structural difference: Patreon bills per creator, so a fan backing four creators pays four separate flat fees, while every Seed rides one transaction. Back more creators on Patreon and each one nets less; on Anthers each one nets more.`,
			},
			{
				scenario: "A fan buys a $10 one-time item",
				kind: "Purchase",
				anthers: aPrice("$10.00", "$9.40"),
				rival: {
					keep: "$8.21–8.91",
					keepSub: "88–95% after their cut, less the same card processing",
					cut: "5–12% + processing",
				},
				note: "Patreon now sells one-time digital products too, at the same 10% plus processing — so they belong in this row, not only the membership one.",
			},
		],
	},
	{
		id: "substack",
		label: "Substack",
		blurb: "Paid-newsletter platform. 10% on all subscriptions, plus Stripe payment processing.",
		matchups: [
			{
				scenario: `A fan subscribes at $${SEED_SPEND} / month`,
				kind: "Seeds",
				anthers: A_SEED,
				rival: {
					keep: RIVAL_SEED_NET,
					keepSub: `${rivalKeeps(0.1)} after their 10%, less Stripe processing and a recurring-billing fee`,
					cut: "10% + processing",
				},
				note: `Both all-in on the same $${SEED_SPEND}. Anthers takes no cut; the only deduction is the at-cost card fee (~${CARD_ON_SEEDS}), charged once on the fan's whole monthly charge. Substack's 10% is before Stripe, and subscriptions started after mid-2024 also carry a recurring-billing fee of roughly 0.5–0.7% that is easy to miss.`,
			},
		],
	},
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CreatorPayComparisonPage() {
	const [platformId, setPlatformId] = useState(PLATFORMS[0].id);
	const platform = PLATFORMS.find((p) => p.id === platformId) ?? PLATFORMS[0];

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade — without
		// `w-full`, `mx-auto` on a flex item disables the default
		// `align-self: stretch`, so the wrapper falls back to its content's
		// intrinsic width (up to `max-w-4xl`), which the inner cards push past
		// the mobile viewport. The `sticky -mx-4 px-4` segment control below
		// relies on this wrapper being exactly the viewport-edge width on
		// mobile, so the negative margin bleeds out to the page edge rather
		// than past it.
		<div className="max-w-4xl min-w-0 w-full mx-auto px-4 pb-16">
			<CalcPageHeader
				eyebrow="Creator pay · head-to-head"
				title="How our pay compares"
				lede={
					<>
						Anthers takes <b className="text-base-content">0%</b> of what reaches you: every{" "}
						<b className="text-base-content">Seed</b> given to you and every direct sale carries no
						platform fee at all, and the Time Pool is distributed to creators by watch-time. What
						does come out of a price is the at-cost card processing, paid to the processor, and on a
						digital sale the buyer's first download — never a cent to us. The one thing that funds
						the platform is <b className="text-base-content">the remainder</b> — what's left of each
						Seed to Anthers after the fan's own bandwidth and the Time Pool, funding free access and
						the creator programs, never subtracted from your earnings. Here's what actually reaches
						you, platform by platform.
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
				earnings. Anthers's cut is <b className="text-base-content">$0</b> on every Seed and every
				sale — the only deductions are the real costs of moving money and bytes, paid to third
				parties, and the Time Pool reaches creators whole. Where we clearly win is Seeds and
				purchases. Streaming we treat as a public good, not a paycheck: under equal-time a music
				hour now earns the same as a video hour (no more per-medium penalty), it's ad-free — but we
				won't pretend a view-hour out-earns YouTube or Spotify. It makes your work discoverable at
				cost; your income comes from the fans who Seed and buy.
			</div>

			<CalcNotes>
				<p>
					<b className="text-base-content/70">How the money moves.</b> Nothing Anthers does comes
					out of what reaches creators. Support is all in{" "}
					<b className="text-base-content/70">Seeds</b> — a flat $3/month each. A fan gives Seeds
					straight to creators ($3, no platform cut) and holds{" "}
					<b className="text-base-content/70">Seeds</b> pointed at Anthers; each one splits into a
					Time Pool ($1.50, distributed to the creators they watch by watch-time), the fan's own
					bandwidth (at cost, folded in — no wallet), and{" "}
					<b className="text-base-content/70">the remainder</b> that funds free access and the
					creator programs. On a direct sale Anthers takes nothing at all; the only deductions from
					the listed price are the at-cost card processing and, on a digital sale, the buyer's first
					download — both paid to third parties.
				</p>
				<p>
					<b className="text-base-content/70">Anthers streaming figures</b> are a fan's Time Pool ÷
					their monthly watch-time, the same rate for every medium (equal-time). Each Seed to
					Anthers adds ${TIME_POOL_PER_SEED.toFixed(2)} of Time Pool —{" "}
					{PAID_POOLS.map(
						(p, i) => `${RANKS[i][0].toUpperCase() + RANKS[i].slice(1)} ${money(p)}`,
					).join(" · ")}
					, and up from there — so a fan lands roughly {POOL_RANGE} of pool per month → about
					$0.03–0.60 per view-hour, with our reference streamer (Sprout, ~{REF_HOURS} hrs) at ~
					{REF_HR_PAY}. <b className="text-base-content/70">Competitor figures</b> are each
					platform's public fee and payout structure on the same transaction — rough estimates, not
					quotes, and before their own payment-processing deductions except where noted. A planning
					comparison, not an offer or guarantee.
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
	foundation: {
		tone: "text-base-content/70",
		tag: "funds free access · not a cut",
		tagTone: "text-primary/70",
	},
	none: { tone: "text-success/80", tag: "no cut — $0 to Anthers", tagTone: "text-success/60" },
};

/** One side of a matchup: who, the take-home headline, its basis, and the cut —
 * with the cut's nature (free access / profit / none) named, never hidden as "$0". */
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
