// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two Meadow economics cards — the interactive "Where your Seeds to Anthers go"
// rank picker and the one-time-purchase example — plus the badge ladder and the
// hover-tooltip (i). All numbers derive from the support model (see
// @anthers/shared/constants + fees): a Seed is a flat $3, pointed at a creator
// (100% to them) or at Anthers (an Anthers-Seed). Each Anthers-Seed splits into
// your bandwidth (at cost, folded in) + Time Pool ($1.50) + the Foundation
// remainder. The at-cost Payments line (card 2.9%+$0.30) and sales tax ~6.5% ride
// ON TOP and leave the system; Anthers keeps $0.

import type { BrandIconName } from "@anthers/brand";
import {
	AFF_INFRA_RATE,
	BADGE_ORDER,
	BANDWIDTH_PER_GIB,
	type BadgeKey,
	badgeLabel,
	CARD_FLAT,
	CARD_RATE,
	SALES_TAX_RATE,
	seedCost,
	thresholdForBadge,
	timePoolFor,
} from "@anthers/shared/constants";
import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { FONTS } from "../../styles/fonts";
import { BrandGlyph } from "../decor/BrandGlyph";

const serif = { fontFamily: FONTS.fraunces };

// ─── Rates — single source of truth: @anthers/shared (the same numbers the API
// charges). Only the presentation (badge emoji/wreaths) lives here. ───
const DIGITAL_AFF_PER_GIB = BANDWIDTH_PER_GIB * AFF_INFRA_RATE; // digital-purchase Foundation fee (= 50% of bandwidth)
const CARD_PCT = CARD_RATE;
const TAX_PCT = SALES_TAX_RATE;

const money = (n: number) => `$${n.toFixed(2)}`;

const TAX_TIP =
	"An average U.S. combined sales-tax rate. Your actual rate depends on your state and may be higher or lower.";

// ─── Badge presentation. Every rank shares one round botanical frame
// (`frame-round`) — a single, consistent wreath across all ranks; the emoji inside is
// what differs. ───
export const BADGE_ART: Record<BadgeKey, { emoji: string; wreath: BrandIconName }> = {
	free: { emoji: "🌰", wreath: "frame-round" },
	root: { emoji: "🫚", wreath: "frame-round" },
	sprout: { emoji: "🌱", wreath: "frame-round" },
	petal: { emoji: "🌷", wreath: "frame-round" },
	blossom: { emoji: "🌼", wreath: "frame-round" },
};

/** Ascending ladder (Root → Blossom) for the ranks section: wreath + emoji + $/mo (= $3 × Seeds). */
export const BADGE_LADDER: {
	name: string;
	emoji: string;
	threshold: string;
	wreath: BrandIconName;
}[] = BADGE_ORDER.filter((b) => b !== "free").map((b) => ({
	name: badgeLabel(b),
	emoji: BADGE_ART[b].emoji,
	threshold: `$${seedCost(thresholdForBadge(b))}/mo`,
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

/** An indented sub-line showing part of where each Seed goes. */
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

// ─── (2) Anthers-Seeds — interactive rank picker ───

/** The five ranks as selectable chips: emoji + label + $/mo (= $3 × Anthers-Seeds). */
function PlanPicker({ value, onChange }: { value: BadgeKey; onChange: (b: BadgeKey) => void }) {
	return (
		<div className="mb-6 grid grid-cols-5 gap-2">
			{BADGE_ORDER.map((b) => {
				const active = b === value;
				const price = seedCost(thresholdForBadge(b));
				return (
					<button
						key={b}
						type="button"
						onClick={() => onChange(b)}
						aria-pressed={active}
						className={`flex flex-col items-center gap-1 rounded-xl border px-1.5 py-3 text-center transition-colors ${
							active
								? "border-primary bg-primary/10"
								: "border-base-content/10 bg-base-100 hover:border-primary/40"
						}`}
					>
						{b === "free" ? (
							// Free has no badge — just the centered label, so it's clear it's badgeless.
							<span
								style={serif}
								className={`flex flex-1 items-center justify-center text-sm font-medium ${active ? "text-primary" : "text-base-content/80"}`}
							>
								Free
							</span>
						) : (
							<>
								<span className="relative flex h-11 w-11 items-center justify-center">
									<BrandGlyph
										name={BADGE_ART[b].wreath}
										className={`absolute inset-0 h-full w-full ${active ? "text-primary/70" : "text-primary/40"}`}
									/>
									<span aria-hidden="true" className="text-xl leading-none">
										{BADGE_ART[b].emoji}
									</span>
								</span>
								<span
									style={serif}
									className={`text-sm font-medium ${active ? "text-primary" : "text-base-content/80"}`}
								>
									{badgeLabel(b)}
								</span>
								<span className="font-mono text-[11px] text-base-content/50">${price}</span>
							</>
						)}
					</button>
				);
			})}
		</div>
	);
}

export function SubscriptionCalculator() {
	const [badge, setBadge] = useState<BadgeKey>("root");
	const n = thresholdForBadge(badge);
	const price = seedCost(n);
	const timePool = timePoolFor(n);
	// "Supports Anthers" bundles your bandwidth (at cost) + the Foundation remainder.
	const supportsAnthers = n === 0 ? 0 : price - timePool;
	const toCreators = n === 0 ? 0 : timePool;

	// The at-cost Payments line + tax ride ON TOP of the Seeds. Free ($0) has none.
	const card = price > 0 ? price * CARD_PCT + CARD_FLAT : 0;
	const tax = price * TAX_PCT;
	const processing = card + tax;
	const total = price + processing;

	const barParts = [
		{ key: "timePool", amount: timePool, cls: "bg-primary" },
		{ key: "supports", amount: supportsAnthers, cls: "bg-info" },
		{ key: "processing", amount: processing, cls: "bg-base-content/15" },
	];
	const barTotal = total || 1;

	return (
		<div className="rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			<h3 style={serif} className="mb-1 text-lg font-medium">
				Where your Seeds to Anthers go
			</h3>
			<p className="mb-5 text-xs text-base-content/50">
				Pick a level — each Seed is $3. Everything updates live.
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
							<span className="font-medium text-base-content/90">{badgeLabel(badge)}</span>
							<span className="text-base-content/55">
								{" "}
								— {n} Seed{n === 1 ? "" : "s"} to Anthers
							</span>
						</div>
						<span className="w-14 text-right font-mono tabular-nums">{money(price)}</span>
					</div>
					<div className="mt-2.5 ml-1 flex flex-col gap-1.5 border-l border-base-content/10 pl-4">
						<SplitRow
							dot="bg-primary"
							label="Time Pool"
							desc="to the creators you watch, by time spent — 100% to them"
							amount={timePool}
						/>
						<SplitRow
							dot="bg-info"
							label="Supports Anthers"
							desc={
								n === 0
									? "free access for all is supported by paying users"
									: "your bandwidth (at cost) + free access & charitable programs"
							}
							amount={supportsAnthers}
						/>
					</div>
				</div>

				<div className="flex items-center justify-between gap-3 text-sm">
					<span className="text-base-content/75">
						<span className="font-medium text-base-content/90">Payments</span>
						<span className="text-base-content/55"> — card fees (on top) + est. sales tax </span>
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
					to the creators you watch — plus every Seed you give a creator directly, at 100%.
				</p>
			</div>
			<p className="mt-4 text-xs text-base-content/45">
				Bandwidth is folded in: every account streams a free floor each month, and each Seed adds
				more — all at cost ({money(BANDWIDTH_PER_GIB)}/GiB), no wallet, no hidden fees.
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
	const foundation = sizeGiB * DIGITAL_AFF_PER_GIB; // Digital AFF = 50% of bandwidth
	const base = price + delivery + foundation;
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
			desc: "the literal download transfer, provided at cost",
			amount: delivery,
			bar: "bg-secondary",
			dot: "bg-secondary",
		},
		{
			label: "Foundation fee",
			desc: "supports free access for all  + charitable programs",
			amount: foundation,
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
