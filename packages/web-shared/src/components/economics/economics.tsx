// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two Meadow economics cards — the interactive "Where your subscription goes"
// Badge-plan picker and the one-time-purchase example — plus the badge ladder and
// the hover-tooltip (i). All numbers derive from the V4 "Big Rethink" model (see
// @anthers/shared/constants + fees): a user CHOOSES a Badge plan whose whole-dollar
// price decomposes into Time Pool + Seeds + Community Share. A Seed is $1, 100% to
// creators. Bandwidth is decoupled into a separate at-cost wallet ($0.01/GiB) with a
// per-tier free monthly allowance. Card 2.9%+$0.30 and sales tax ~6.5% ride on top
// and leave the system; Anthers keeps $0.

import type { BrandIconName } from "@anthers/brand";
import {
	AFF_INFRA_RATE,
	BADGE_ORDER,
	BADGE_PLANS,
	BANDWIDTH_PER_GIB,
	type Badge,
	badgeLabel,
	CARD_FLAT,
	CARD_RATE,
	SALES_TAX_RATE,
} from "@anthers/shared/constants";
import { badgePriceBreakdown } from "@anthers/shared/fees";
import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { FONTS } from "../../styles/fonts";
import { BrandGlyph } from "../decor/BrandGlyph";

const serif = { fontFamily: FONTS.fraunces };

// ─── V4 rates — single source of truth: @anthers/shared (the same numbers the API
// charges). Only the presentation (badge emoji/wreaths, which share of a plan-dollar
// each part is) lives here. ───
const DIGITAL_AFF_PER_GIB = BANDWIDTH_PER_GIB * AFF_INFRA_RATE; // digital-purchase Foundation fee (= 50% of bandwidth)
const CARD_PCT = CARD_RATE;
const TAX_PCT = SALES_TAX_RATE;

const money = (n: number) => `$${n.toFixed(2)}`;

const TAX_TIP =
	"An average U.S. combined sales-tax rate. Your actual rate depends on your state and may be higher or lower.";

// ─── Badge presentation. Every badge shares one round botanical frame
// (`frame-round`) — a single, consistent wreath across all ranks; the emoji inside is
// what differs. ───
const BADGE_ART: Record<Badge, { emoji: string; wreath: BrandIconName }> = {
	free: { emoji: "🌰", wreath: "frame-round" },
	root: { emoji: "🫚", wreath: "frame-round" },
	sprout: { emoji: "🌱", wreath: "frame-round" },
	petal: { emoji: "🌷", wreath: "frame-round" },
	blossom: { emoji: "🌼", wreath: "frame-round" },
};

/** Ascending ladder (Root → Blossom, the paid plans) for the badges section: wreath + emoji + $/mo. */
export const BADGE_LADDER: {
	name: string;
	emoji: string;
	threshold: string;
	wreath: BrandIconName;
}[] = BADGE_ORDER.filter((b) => b !== "free").map((b) => ({
	name: badgeLabel(b),
	emoji: BADGE_ART[b].emoji,
	threshold: `$${BADGE_PLANS[b].price}/mo`,
	wreath: BADGE_ART[b].wreath,
}));

// ─── shared bits ───

/** A small (i) with a hover tooltip. */
export function InfoDot({ tip }: { tip: string }) {
	return (
		<span className="tooltip tooltip-top align-middle" data-tip={tip}>
			<InformationCircleIcon className="inline h-4 w-4 text-base-content/40 transition-colors hover:text-primary" />
		</span>
	);
}

/** The wreathed badge mark for the currently selected plan. */
function BadgeMark({ badge }: { badge: Badge }) {
	const art = BADGE_ART[badge];
	return (
		<div className="flex w-16 flex-col items-center text-center">
			<div className="relative flex h-14 w-14 items-center justify-center">
				<BrandGlyph name={art.wreath} className="absolute inset-0 h-full w-full text-primary/60" />
				<span aria-hidden="true" className="text-2xl">
					{art.emoji}
				</span>
			</div>
			<span style={serif} className="mt-1 text-xs font-medium">
				{badgeLabel(badge)}
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

/** An indented sub-line showing part of where the plan dollar goes. */
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

// ─── (2) Subscriptions & Seeds — interactive Badge-plan picker ───

/** The five Badge plans as selectable chips: emoji + label + price. */
function PlanPicker({ value, onChange }: { value: Badge; onChange: (b: Badge) => void }) {
	return (
		<div className="mb-6 grid grid-cols-5 gap-1.5">
			{BADGE_ORDER.map((b) => {
				const active = b === value;
				const price = BADGE_PLANS[b].price;
				return (
					<button
						key={b}
						type="button"
						onClick={() => onChange(b)}
						aria-pressed={active}
						className={`flex flex-col items-center gap-0.5 rounded-xl border px-1 py-2 text-center transition-colors ${
							active
								? "border-primary bg-primary/10"
								: "border-base-content/10 bg-base-100 hover:border-primary/40"
						}`}
					>
						<span aria-hidden="true" className="text-lg leading-none">
							{BADGE_ART[b].emoji}
						</span>
						<span
							style={serif}
							className={`text-xs font-medium ${active ? "text-primary" : "text-base-content/80"}`}
						>
							{badgeLabel(b)}
						</span>
						<span className="font-mono text-[10px] text-base-content/50">
							{price === 0 ? "Free" : `$${price}`}
						</span>
					</button>
				);
			})}
		</div>
	);
}

export function SubscriptionCalculator() {
	const [badge, setBadge] = useState<Badge>("root");
	const plan = BADGE_PLANS[badge];
	const b = badgePriceBreakdown(badge);
	const price = b.price.toNumber();
	const timePool = b.timePool.toNumber();
	const seeds = b.seeds.toNumber();
	const community = b.communityShare.toNumber();
	const toCreators = b.toCreators.toNumber();

	// Card + tax ride on the plan price and leave the system. Free costs $0, so none.
	const card = price > 0 ? price * CARD_PCT + CARD_FLAT : 0;
	const tax = price * TAX_PCT;
	const processing = card + tax;
	const total = price + processing;

	const barParts = [
		{ key: "timePool", amount: timePool, cls: "bg-primary" },
		{ key: "seeds", amount: seeds, cls: "bg-secondary" },
		{ key: "community", amount: community, cls: "bg-info" },
		{ key: "processing", amount: processing, cls: "bg-base-content/15" },
	];
	const barTotal = total || 1;

	return (
		<div className="relative rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			<div className="absolute right-6 top-6">
				<BadgeMark badge={badge} />
			</div>
			<h3 style={serif} className="mb-1 text-lg font-medium">
				Where your subscription goes
			</h3>
			<p className="mb-5 max-w-[16rem] text-xs text-base-content/50">
				Pick a Badge plan—everything updates live.
			</p>

			<PlanPicker value={badge} onChange={setBadge} />

			<div className="mb-6 flex h-2.5 overflow-hidden rounded-full bg-base-content/10">
				{barParts.map((p) => (
					<div key={p.key} className={p.cls} style={{ width: `${(p.amount / barTotal) * 100}%` }} />
				))}
			</div>

			<div className="flex flex-col gap-4">
				<div>
					<div className="flex items-center justify-between gap-3 text-sm">
						<div className="min-w-0">
							<span className="font-medium text-base-content/90">{badgeLabel(badge)} plan</span>
							<span className="text-base-content/55"> — your monthly price</span>
						</div>
						<span className="w-14 text-right font-mono tabular-nums">{money(price)}</span>
					</div>
					<div className="mt-2.5 ml-1 flex flex-col gap-1.5 border-l border-base-content/10 pl-4">
						<SplitRow
							dot="bg-primary"
							label="Time Pool"
							desc="to creators, by time spent"
							amount={timePool}
						/>
						<SplitRow
							dot="bg-secondary"
							label="Seeds"
							desc={
								plan.seeds > 0
									? `${plan.seeds}× $1, 100% to creators you pick`
									: "included on paid plans"
							}
							amount={seeds}
						/>
						<SplitRow
							dot="bg-info"
							label="Community Share"
							desc={b.subsidised ? "subsidised on Free" : "free access + charity"}
							amount={community}
						/>
					</div>
				</div>

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
				Bandwidth is separate: your first {plan.freeBwGiB} GiB each month are free, then it's just{" "}
				{money(BANDWIDTH_PER_GIB)}/GiB from a prepaid wallet. No hidden fees, ever.
			</p>
		</div>
	);
}

// ─── (3) One-time purchases — static example (zero-cut, Digital AFF) ───

export function PurchaseExample({
	price = 20,
	sizeGiB = 10,
}: {
	price?: number;
	sizeGiB?: number;
}) {
	const delivery = sizeGiB * BANDWIDTH_PER_GIB; // $0.01/GiB, at cost
	const community = sizeGiB * DIGITAL_AFF_PER_GIB; // Digital AFF = 50% of bandwidth
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
