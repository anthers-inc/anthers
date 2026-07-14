// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resource: "How our pay compares" — a dense, information-first head-to-head of
// what reaches a creator on Anthers versus each platform they already know. One
// tab per platform (YouTube, Spotify, Steam, Bandcamp, Patreon, Substack); each
// tab shows the relevant transaction(s) side by side.
//
// Framing (important): Anthers DOES take a cut — the Community Share. We do not
// claim otherwise, and we deliberately avoid "no cut" / "we keep $0" language: on
// streaming the Community Share comes out of the fan's usage payment *before* the
// Time Pool is even defined, so we plainly take a share of what the user pays. What
// makes it different from a for-profit platform is HOW and WHERE we take it, and
// what it funds:
//   • It's a charitable markup on the infrastructure a transaction uses (≈50% of a
//     stream/download's bandwidth; a flat 1% on physical goods) — not a flat
//     percentage skimmed off every dollar you earn.
//   • On a sale it's added on top for the buyer, so your listed price reaches you
//     in full; on streaming it's carved from usage; on Boost there's no fee at all.
//   • The Foundation keeps it to fund free access, creator programs, and lean
//     administration — a non-profit spending its cut on the commons, not profit.
// So each Anthers row shows its actual cut (the Community Share), tagged as charity,
// rather than a misleading "$0".
//
// This uses our CURRENT V3 model math even where it loses. Streaming is our weakest
// number — the Time Pool is funded per-GiB of bandwidth, so cheap-to-stream media
// (music) generates a small pool, and per hour we pay less than Spotify. We show
// that straight: the point is to validate the model and find where it needs to
// improve, not to flatter it.
//
// Anthers figures: packages/shared/src/constants.ts (Time Pool $0.015/GiB, AF Fee
// $0.005/GiB, bandwidth $0.01/GiB at cost, physical AFF 1%, Boost 100%) at the V3
// reference bitrates. Competitor figures are their public rates.
//
// Styled like the calculators (dense, DaisyUI-native, plain — no Meadow decor), so
// it reads as one set with the rest of Resources.

import { useState } from "react";
import { Link } from "react-router-dom";
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

// Anthers's per-transaction facts, reused across tabs. Each carries its real cut —
// the Community Share (charity) — never "$0", except Boost, which truly has no fee.
const A_STREAM_VIDEO: Side = {
	keep: "~$0.026 / hr",
	keepSub: "Time Pool · $0.015/GiB × 1.70 GiB/hr (1080p60), split by watch-time",
	cut: "~$0.009 / hr",
	cutKind: "charity",
};
const A_STREAM_MUSIC: Side = {
	keep: "~$0.0008 / hr",
	keepSub: "music streams ~34× lighter than video, so alone it funds a tiny pool",
	cut: "<$0.001 / hr",
	cutKind: "charity",
};
/** A direct sale: creator keeps the full listed price; the Community Share is the
 * (small) markup on the delivery, added on top for the buyer. */
const aPrice = (amount: string, share: string): Side => ({
	keep: amount,
	keepSub: "100% — your listed price, in full",
	cut: share,
	cutKind: "charity",
});
const A_BOOST: Side = {
	keep: "$5.00",
	keepSub: "100% — Boost, no fee and no payout processing",
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
				scenario: "A fan streams 1 hour of your HD video",
				kind: "Streaming",
				anthers: A_STREAM_VIDEO,
				rival: {
					keep: "45% of the revenue",
					keepSub: "≈ $0.05–0.20/hr on Premium (a ~$16 sub pooled by watch-time); pennies on ads",
					cut: "55%",
				},
				note: "Of the ~$0.05 of usage the fan spends that hour, ~$0.026 reaches you (Time Pool), ~$0.009 is our Community Share (charity), and ~$0.017 is bandwidth at cost. YouTube keeps 55% of the ad/Premium revenue as profit — and on ads the viewer's data is the product.",
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
				anthers: A_STREAM_MUSIC,
				rival: {
					keep: "~$0.069 / hr",
					keepSub: "$0.004/stream × ~17 songs (3:30 each); an artist keeps less after their label",
					cut: "~30% + labels",
				},
				note: "Our weakest number: on music alone we pay far less than Spotify, because the Time Pool is funded by bandwidth and music is cheap to stream (so our Community Share on it is tiny too). Equal-time lifts every minute to the blended video rate (~$0.026/hr) when the same fan also watches video — still under Spotify. Real support comes from purchases and Boost.",
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
				note: "Anthers's cut here is the Community Share on the download bandwidth — about a cent, added on top for the buyer, so your $10 reaches you whole. Steam's 30% comes out of your sale.",
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
				note: "Our Community Share is the delivery markup, pennies added on top; your $10 is untouched. Bandcamp takes 15% of your sale and also deducts payment processing from your cut.",
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
				kind: "Subscription",
				anthers: A_BOOST,
				rival: {
					keep: "$4.50",
					keepSub: "90% before processing → nets ~$4.05",
					cut: "10% + processing",
				},
				note: "Boost is the one place we take nothing — no fee, no payout processing; the supporter covers the card fee on top (~$5.45 charged). Patreon takes 10%, then card processing comes out of what's left.",
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
				kind: "Subscription",
				anthers: A_BOOST,
				rival: {
					keep: "$4.50",
					keepSub: "90% before processing → nets ~$4.05",
					cut: "10% + processing",
				},
				note: "Boost takes no fee and no payout processing — the supporter covers the card fee on top. Substack takes 10%, then Stripe processing (~$0.45 on $5) comes out of your cut.",
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
						Anthers takes a cut too — we won't pretend otherwise. But it's a small{" "}
						<b className="text-base-content">charitable fee</b> (the Community Share) on the
						infrastructure a sale uses, not a percentage skimmed off everything you earn: it's added
						on top of your price on purchases, it's nothing at all on Boost, and it funds free
						access and creator programs instead of profit. Here's what actually reaches you,
						platform by platform, on our current model math — including where we come out behind.
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
				<b className="text-base-content">The bottom line.</b> We take a cut — the Community Share —
				but it's small, it's charity, and it's structured differently: added on top of your price on
				sales (so you keep <b className="text-base-content">100%</b> of what you charge), nothing at
				all on Boost, and carved only from usage on streaming. Where we clearly win is purchases and
				Boost. Where we fall behind is streaming — for music, well behind Spotify — because the Time
				Pool is funded from usage after the Community Share and at-cost bandwidth. That's the number
				we're working to raise.
			</div>

			<CalcNotes>
				<p>
					<b className="text-base-content/70">How our cut works.</b> Anthers does take a cut — the{" "}
					<b className="text-base-content/70">Community Share</b> — just not the way a for-profit
					platform does. It's a charitable markup on the infrastructure a transaction uses: roughly
					half the bandwidth a stream or download costs, or a flat 1% on physical goods. On a sale
					it's added on top for the buyer, so your listed price reaches you in full; on streaming
					it's taken from the fan's usage payment before the Time Pool; on Boost there's no fee at
					all. The Foundation keeps it to fund free access, creator programs, and lean
					administration — a non-profit spending its cut on the commons rather than owner profit.
					What we never do is skim a flat percentage off every dollar you earn.
				</p>
				<p>
					<b className="text-base-content/70">Anthers figures</b> are our current V3 model math
					(Time Pool $0.015/GiB, Community Share $0.005/GiB or 1% physical, bandwidth $0.01/GiB at
					cost, Boost 100%) at the AV1 reference bitrates (1080p60 ≈ 1.70 GiB/hr, Opus music ≈ 0.05
					GiB/hr). <b className="text-base-content/70">Competitor figures</b> are each platform's
					public fee and payout structure applied to the same transaction — rough estimates, not
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
	charity: {
		tone: "text-base-content/70",
		tag: "Community Share · charity",
		tagTone: "text-primary/70",
	},
	none: { tone: "text-success/80", tag: "no fee — 100% to you", tagTone: "text-success/60" },
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
