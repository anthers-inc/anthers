// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two Meadow economics cards — the interactive "Where your subscription goes"
// calculator and the one-time-purchase example — plus the badge ladder and the
// hover-tooltip (i). All numbers derive from the V3 model (see `20260711 - V3
// Subscription Economics`): usage $0.03/GiB = bandwidth $0.01 + Community Share
// (AF fee) $0.005 + Time Pool $0.015; Boost is 100% to creators; card 2.9%+$0.30
// and sales tax ~6.5% ride on top and leave the system; badges at $3/$7/$15/$30
// of the (usage+boost) subtotal.

import type { BrandIconName } from "@anthers/brand";
import {
	BADGE_THRESHOLDS,
	BANDWIDTH_PER_GIB,
	CARD_FLAT,
	CARD_RATE,
	SALES_TAX_RATE,
	TIME_POOL_PER_GIB,
	USAGE_AFF_PER_GIB,
	USAGE_PER_GIB,
} from "@anthers/shared/constants";
import { ChevronDownIcon, ChevronUpIcon, InformationCircleIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { FONTS } from "../../styles/fonts";
import { BrandGlyph } from "../decor/BrandGlyph";

const serif = { fontFamily: FONTS.fraunces };

// ─── V3 rates — single source of truth: @anthers/shared/constants (the same
// numbers the API charges). Only the presentation (which share of a usage dollar
// each part is, badge emoji/wreaths) lives here. ───
const BANDWIDTH_SHARE = BANDWIDTH_PER_GIB / USAGE_PER_GIB; // 1/3 → real egress, at cost
const TIMEPOOL_SHARE = TIME_POOL_PER_GIB / USAGE_PER_GIB; // 1/2 → creators, by watch-time
const COMMUNITY_SHARE = USAGE_AFF_PER_GIB / USAGE_PER_GIB; // 1/6 → Anthers Foundation
const DIGITAL_AFF_PER_GIB = USAGE_AFF_PER_GIB; // digital-purchase Foundation fee (= 50% of bandwidth)
const CARD_PCT = CARD_RATE;
const TAX_PCT = SALES_TAX_RATE;

const money = (n: number) => `$${n.toFixed(2)}`;

const TAX_TIP =
	"An average U.S. combined sales-tax rate. Your actual rate depends on your state and may be higher or lower.";

// ─── Badges (highest threshold first). Thresholds from shared constants; emoji +
// wreath are presentation. ───
type Badge = { name: string; emoji: string; min: number; wreath: BrandIconName };
const BADGES: Badge[] = [
	{ name: "Blossom", emoji: "🌼", min: BADGE_THRESHOLDS.blossom, wreath: "wreath-blossom" },
	{ name: "Petal", emoji: "🌷", min: BADGE_THRESHOLDS.petal, wreath: "wreath-petal" },
	{ name: "Sprout", emoji: "🌱", min: BADGE_THRESHOLDS.sprout, wreath: "wreath-sprout" },
	{ name: "Root", emoji: "🫚", min: BADGE_THRESHOLDS.root, wreath: "wreath-root" },
];
const badgeFor = (subtotal: number) => BADGES.find((b) => subtotal >= b.min) ?? null;

/** Ascending ladder (Root → Blossom) for the badges section: wreath + emoji + $. */
export const BADGE_LADDER: {
	name: string;
	emoji: string;
	threshold: string;
	wreath: BrandIconName;
}[] = [
	{ name: "Root", emoji: "🫚", threshold: `$${BADGE_THRESHOLDS.root}+`, wreath: "wreath-root" },
	{
		name: "Sprout",
		emoji: "🌱",
		threshold: `$${BADGE_THRESHOLDS.sprout}+`,
		wreath: "wreath-sprout",
	},
	{ name: "Petal", emoji: "🌷", threshold: `$${BADGE_THRESHOLDS.petal}+`, wreath: "wreath-petal" },
	{
		name: "Blossom",
		emoji: "🌼",
		threshold: `$${BADGE_THRESHOLDS.blossom}+`,
		wreath: "wreath-blossom",
	},
];

// ─── shared bits ───

/** A small (i) with a hover tooltip. */
export function InfoDot({ tip }: { tip: string }) {
	return (
		<span className="tooltip tooltip-top align-middle" data-tip={tip}>
			<InformationCircleIcon className="inline h-4 w-4 text-base-content/40 transition-colors hover:text-primary" />
		</span>
	);
}

/** A styled integer stepper with stacked up/down chevrons; `format` renders the value. */
function Stepper({
	value,
	onChange,
	min = 0,
	step = 1,
	format,
}: {
	value: number;
	onChange: (n: number) => void;
	min?: number;
	step?: number;
	format: (n: number) => string;
}) {
	return (
		<div className="inline-flex items-stretch overflow-hidden rounded-xl border border-base-content/15 bg-base-100">
			<span
				style={serif}
				className="flex min-w-[4.75rem] items-center justify-center px-3 text-base font-medium tabular-nums"
			>
				{format(value)}
			</span>
			<div className="flex flex-col border-l border-base-content/15">
				<button
					type="button"
					aria-label="Increase"
					onClick={() => onChange(value + step)}
					className="flex flex-1 items-center bg-primary/10 px-1.5 text-primary transition-colors hover:bg-primary/25"
				>
					<ChevronUpIcon className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					aria-label="Decrease"
					disabled={value <= min}
					onClick={() => onChange(Math.max(min, value - step))}
					className="flex flex-1 items-center border-t border-base-content/15 bg-primary/10 px-1.5 text-primary transition-colors hover:bg-primary/25 disabled:opacity-30"
				>
					<ChevronDownIcon className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}

/** The wreathed badge mark that updates as the calculator changes. */
function BadgeMark({ badge }: { badge: Badge | null }) {
	if (!badge) {
		return (
			<div className="flex w-16 flex-col items-center text-center">
				<div className="flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-base-content/25 text-2xl opacity-40">
					🌰
				</div>
				<span className="mt-1 text-[11px] leading-tight text-base-content/45">Below Root</span>
			</div>
		);
	}
	return (
		<div className="flex w-16 flex-col items-center text-center">
			<div className="relative flex h-14 w-14 items-center justify-center">
				<BrandGlyph
					name={badge.wreath}
					className="absolute inset-0 h-full w-full text-primary/60"
				/>
				<span aria-hidden="true" className="text-2xl">
					{badge.emoji}
				</span>
			</div>
			<span style={serif} className="mt-1 text-xs font-medium">
				{badge.name}
			</span>
		</div>
	);
}

type Seg = { label: string; desc: React.ReactNode; amount: number; bar: string; dot: string };

function Breakdown({ segments, approxLast }: { segments: Seg[]; approxLast?: boolean }) {
	const barTotal = segments.reduce((s, r) => s + r.amount, 0) || 1;
	return (
		<>
			<div className="mb-5 flex h-2.5 overflow-hidden rounded-full bg-base-content/10">
				{segments.map((r) => (
					<div
						key={r.label}
						className={r.bar}
						style={{ width: `${(r.amount / barTotal) * 100}%` }}
					/>
				))}
			</div>
			<dl className="flex flex-col gap-2.5 text-sm">
				{segments.map((r, i) => (
					<div key={r.label} className="flex items-baseline justify-between gap-3">
						<span className="flex items-baseline gap-2 text-base-content/75">
							<span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${r.dot}`} />
							<span>
								<span className="font-medium text-base-content/90">{r.label}</span>
								<span className="text-base-content/55"> — {r.desc}</span>
							</span>
						</span>
						<span className="shrink-0 font-mono tabular-nums">
							{approxLast && i === segments.length - 1 ? "~" : ""}
							{money(r.amount)}
						</span>
					</div>
				))}
			</dl>
		</>
	);
}

// ─── (2) Subscriptions & Boosts — interactive ───

/** A primary card line: label + desc, then (right) the stepper and the dollar amount. */
function PrimaryRow({
	title,
	desc,
	amount,
	control,
}: {
	title: string;
	desc: string;
	amount: number;
	control: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3 text-sm">
			<div className="min-w-0">
				<span className="font-medium text-base-content/90">{title}</span>
				<span className="text-base-content/55"> — {desc}</span>
			</div>
			<div className="flex shrink-0 items-center gap-3">
				{control}
				<span className="w-14 text-right font-mono tabular-nums">{money(amount)}</span>
			</div>
		</div>
	);
}

/** An indented sub-line showing part of where the Usage dollar goes. */
function SplitRow({
	dot,
	label,
	desc,
	amount,
}: {
	dot: string;
	label: string;
	desc: string;
	amount: number;
}) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-xs">
			<span className="flex items-baseline gap-2 text-base-content/60">
				<span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
				<span>
					<span className="font-medium text-base-content/75">{label}</span> · {desc}
				</span>
			</span>
			<span className="shrink-0 font-mono tabular-nums text-base-content/60">{money(amount)}</span>
		</div>
	);
}

export function SubscriptionCalculator() {
	const [usageGiB, setUsageGiB] = useState(100); // bought in 100-GiB increments, like real plans
	const [boosts, setBoosts] = useState(0); // whole Boost units, $1 each

	const usage = usageGiB * USAGE_PER_GIB;
	const bandwidth = usage * BANDWIDTH_SHARE;
	const timePool = usage * TIMEPOOL_SHARE;
	const community = usage * COMMUNITY_SHARE;
	const boost = boosts;
	const subtotal = usage + boost;
	const card = subtotal > 0 ? subtotal * CARD_PCT + CARD_FLAT : 0;
	const tax = subtotal * TAX_PCT;
	const processing = card + tax;
	const total = subtotal + processing;
	const toCreators = timePool + boost;

	const barParts = [
		{ key: "bandwidth", amount: bandwidth, cls: "bg-base-content/30" },
		{ key: "timePool", amount: timePool, cls: "bg-primary" },
		{ key: "community", amount: community, cls: "bg-info" },
		{ key: "boost", amount: boost, cls: "bg-secondary" },
		{ key: "processing", amount: processing, cls: "bg-base-content/15" },
	];
	const barTotal = total || 1;

	return (
		<div className="relative rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			<div className="absolute right-6 top-6">
				<BadgeMark badge={badgeFor(subtotal)} />
			</div>
			<h3 style={serif} className="mb-1 text-lg font-medium">
				Where your subscription goes
			</h3>
			<p className="mb-5 max-w-[16rem] text-xs text-base-content/50">
				Adjust your Usage and Boosts—everything updates live.
			</p>

			<div className="mb-6 flex h-2.5 overflow-hidden rounded-full bg-base-content/10">
				{barParts.map((p) => (
					<div key={p.key} className={p.cls} style={{ width: `${(p.amount / barTotal) * 100}%` }} />
				))}
			</div>

			<div className="flex flex-col gap-4">
				<div>
					<PrimaryRow
						title="Usage"
						desc="open, watch-anything access"
						amount={usage}
						control={
							<Stepper
								value={usageGiB}
								onChange={setUsageGiB}
								step={100}
								format={(g) => `${g} GiB`}
							/>
						}
					/>
					<div className="mt-2.5 ml-1 flex flex-col gap-1.5 border-l border-base-content/10 pl-4">
						<SplitRow
							dot="bg-base-content/30"
							label="Bandwidth"
							desc="data transfer, at cost"
							amount={bandwidth}
						/>
						<SplitRow
							dot="bg-primary"
							label="Time Pool"
							desc="to creators, by time spent"
							amount={timePool}
						/>
						<SplitRow
							dot="bg-info"
							label="Community Share"
							desc="free access + charity"
							amount={community}
						/>
					</div>
				</div>

				<PrimaryRow
					title="Boost"
					desc="$1 each, 100% to the creators you love"
					amount={boost}
					control={<Stepper value={boosts} onChange={setBoosts} step={1} format={(n) => `${n}×`} />}
				/>

				<div className="flex items-center justify-between gap-3 text-sm">
					<span className="text-base-content/75">
						<span className="font-medium text-base-content/90">Processing</span>
						<span className="text-base-content/55"> — card fees + est. sales tax </span>
						<InfoDot tip={TAX_TIP} />
					</span>
					<span className="shrink-0 font-mono tabular-nums">~{money(processing)}</span>
				</div>
			</div>

			<div className="mt-5 border-t border-base-content/10 pt-4">
				<div className="flex items-baseline justify-between">
					<span style={serif} className="text-lg font-medium">
						Total you pay
					</span>
					<span style={serif} className="text-lg font-medium tabular-nums">
						~{money(total)}
						<span className="text-sm font-normal text-base-content/50"> / mo</span>
					</span>
				</div>
				<p className="mt-1 text-sm text-base-content/65">
					of which{" "}
					<span className="font-semibold text-primary tabular-nums">{money(toCreators)}</span> goes
					directly to creators, in full.
				</p>
			</div>
			<p className="mt-4 text-xs text-base-content/45">
				That's it—no hidden fees, ever. Card fees drop to ~0.8% if you pay by ACH.
			</p>
		</div>
	);
}

// ─── (3) One-time purchases — static example ───

export function PurchaseExample({
	price = 20,
	sizeGiB = 10,
}: {
	price?: number;
	sizeGiB?: number;
}) {
	const delivery = sizeGiB * (USAGE_PER_GIB * BANDWIDTH_SHARE); // $0.01/GiB
	const community = sizeGiB * DIGITAL_AFF_PER_GIB; // 50% of bandwidth
	const base = price + delivery + community;
	const card = base * CARD_PCT + CARD_FLAT;
	const tax = base * TAX_PCT;
	const processing = card + tax;
	const total = base + processing;

	const segments: Seg[] = [
		{
			label: "Game Price",
			desc: "paid directly to the creator, in full",
			amount: price,
			bar: "bg-primary",
			dot: "bg-primary",
		},
		{
			label: "Delivery",
			desc: "the literal data transfer, at cost",
			amount: delivery,
			bar: "bg-base-content/30",
			dot: "bg-base-content/30",
		},
		{
			label: "Community Share",
			desc: "free-tier access + charitable programs",
			amount: community,
			bar: "bg-info",
			dot: "bg-info",
		},
		{
			label: "Processing",
			desc: (
				<>
					card fees + est. sales tax <InfoDot tip={TAX_TIP} />
				</>
			),
			amount: processing,
			bar: "bg-base-content/15",
			dot: "bg-base-content/20",
		},
	];

	return (
		<div className="relative rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			<div className="mb-5 flex items-baseline justify-between gap-3">
				<span className="text-sm text-base-content/55">
					Example — a {money(price)} indie game, {sizeGiB} GB
				</span>
				<span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
					Creator gets {money(price)}
				</span>
			</div>

			<Breakdown segments={segments} approxLast />

			<div className="mt-5 border-t border-base-content/10 pt-4">
				<div className="flex items-baseline justify-between">
					<span style={serif} className="text-lg font-medium">
						Total you pay
					</span>
					<span style={serif} className="text-lg font-medium tabular-nums">
						~{money(total)}
					</span>
				</div>
				<p className="mt-1 text-sm text-base-content/65">
					of which <span className="font-semibold text-primary tabular-nums">{money(price)}</span>{" "}
					(the full price) goes to the creator.
				</p>
			</div>
			<p className="mt-4 text-xs text-base-content/45">
				That's it—no hidden fees, ever. Card fees drop to ~0.8% if you pay by ACH.
			</p>
		</div>
	);
}
