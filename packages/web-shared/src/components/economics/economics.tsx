// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two Meadow economics cards — the interactive "Where your support for Anthers goes"
// Badge picker and the one-time-purchase example — plus the badge ladder and the
// hover-tooltip (i). All numbers derive from the support model (see
// @anthers/shared/constants + fees): a user gives a monthly amount, all in, pointed at
// a creator (no platform cut) or at Anthers. What goes to Anthers
// splits into Time Pool (half) + the at-cost Payments line (card 2.9%+$0.30) +
// the remainder funding free access and the charitable programs. There is no
// bandwidth term — delivery costs $0 at any volume (retired 2026-08-12). Sales tax
// (~6.5%) is the ONLY thing added on top, because a government-imposed tax is the
// sole carve-out mandatory-fee disclosure law allows. Anthers keeps $0.

import type { BrandIconName } from "@anthers/brand";
import {
	BADGE_ORDER,
	type Badge,
	type BadgeKey,
	badgeLabel,
	cardFeeDisplay,
	SALES_TAX_RATE,
	thresholdForBadge,
	timePoolFor,
} from "@anthers/shared/constants";
import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { FONTS } from "../../styles/fonts";
import { BrandGlyph } from "../decor/BrandGlyph";
import { BadgeMark } from "./BadgeMark";

// Re-exported because `./economics` is this area's entry point in the package exports map.
export { BadgeMark } from "./BadgeMark";

const serif = { fontFamily: FONTS.fraunces };

// ─── Rates — single source of truth: @anthers/shared (the same numbers the API
// charges). Only the presentation (the badge's shape, field color and emoji) lives here. ───
const TAX_PCT = SALES_TAX_RATE;

const money = (n: number) => `$${n.toFixed(2)}`;

const TAX_TIP =
	"An average U.S. combined sales-tax rate. Your actual rate depends on your state and may be higher or lower.";

// ─── Badge presentation. Every Badge is a patch: a shape and a field color bound in the
// same edging, with an emoji sewn onto it. ───
/**
 * 🚨 **Keyed by `Badge`, not `BadgeKey`, because Free has no mark** (Parker, 2026-08-24).
 * A mark *is* a Badge, and Free is the absence of one rather than a Badge worth $0 — so
 * there is no free art to draw, and a surface that wants to show Free shows its name.
 *
 * It carried a `free: { emoji: "🌰" }` entry until then, and nothing on this page ever
 * used it: the picker below branches on `b === "free"` and renders a bare label. That is
 * the shape of the hazard — a convention every caller had to remember, sitting next to an
 * entry that rewarded forgetting. `/subscribe`'s ladder duly forgot, drew the acorn, and
 * looked deliberate. Dropping `free` from the key makes the compiler carry the rule
 * instead: indexing this with a possibly-free key is now a type error.
 */
export const BADGE_ART: Record<Badge, { emoji: string; shape: string; color: string }> = {
	// ⭐ One shape across Anthers' four, with the field color carrying the progression from
	// earth to bloom. A creator picks freely from the same library — including this shape —
	// and what makes the two ladders read as one collection is the edging every badge
	// shares, exactly as a scout set does.
	root: { emoji: "🫚", shape: "circle", color: "cream" },
	sprout: { emoji: "🌱", shape: "circle", color: "meadow" },
	petal: { emoji: "🌷", shape: "circle", color: "clay" },
	blossom: { emoji: "🌼", shape: "circle", color: "sun" },
};

/**
 * One of Anthers' own Badges, by name.
 *
 * ⭐ **One component, because three surfaces used to draw this by hand and each of them
 * encoded the layer structure.** A change to what a Badge looks like is one edit here, and
 * it renders through the same `BadgeMark` a creator's rung does — which is what actually
 * keeps the two ladders looking like one kind of object rather than two that agree today.
 *
 * 🚨 **Free has no mark, because a mark IS a Badge and Free is the absence of one** (Parker,
 * 2026-08-24). `BADGE_ART` is keyed by `Badge` rather than `BadgeKey` so that indexing it
 * with a possibly-free key is a type error rather than a stray acorn.
 */
export function AnthersBadgeMark({
	badge,
	lit = true,
	size = "h-12 w-12",
}: {
	badge: Badge;
	lit?: boolean;
	size?: string;
}) {
	const art = BADGE_ART[badge];
	return (
		<BadgeMark
			shape={art.shape}
			color={art.color}
			emoji={art.emoji}
			label={`${badgeLabel(badge)} badge`}
			clipId={`anthers-badge-${badge}`}
			dim={!lit}
			size={size}
		/>
	);
}

/** Ascending ladder (Root → Blossom) for the Badges section: the patch + emoji + $/mo. */
export const BADGE_LADDER: {
	name: string;
	emoji: string;
	threshold: string;
	shape: string;
	color: string;
}[] = BADGE_ORDER.filter((b): b is Badge => b !== "free").map((b) => ({
	name: badgeLabel(b),
	emoji: BADGE_ART[b].emoji,
	threshold: `$${thresholdForBadge(b)}/mo`,
	shape: BADGE_ART[b].shape,
	color: BADGE_ART[b].color,
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

/** An indented sub-line showing part of where a month's support goes. */
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

// ─── (2) Support for Anthers — interactive Badge picker ───

/** The five Badges as selectable chips: emoji + label + $/mo. */
function BadgePicker({ value, onChange }: { value: BadgeKey; onChange: (b: BadgeKey) => void }) {
	return (
		<div className="mb-6 grid grid-cols-5 gap-2">
			{BADGE_ORDER.map((b) => {
				const active = b === value;
				const price = thresholdForBadge(b);
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
								<AnthersBadgeMark badge={b} lit={active} size="h-11 w-11" />
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
	const price = n;
	const timePool = timePoolFor(n);
	// "Supports Anthers" is the remainder — what funds free access and the charitable
	// programs.

	const supportsAnthers = n === 0 ? 0 : price - timePool - cardFeeDisplay(price);
	const toCreators = n === 0 ? 0 : timePool;

	// The at-cost Payments line sits INSIDE the price; sales tax is the only thing
	// added on top. Free ($0) has neither.
	const card = cardFeeDisplay(price);
	const tax = price * TAX_PCT;
	const processing = card;
	const total = price + tax;

	const barParts = [
		{ key: "timePool", amount: timePool, cls: "bg-primary" },
		{ key: "supports", amount: supportsAnthers, cls: "bg-info" },
		{ key: "processing", amount: processing, cls: "bg-base-content/15" },
	];
	const barTotal = total || 1;

	return (
		<div className="rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			<h3 style={serif} className="mb-1 text-lg font-medium">
				Where your support for Anthers goes
			</h3>
			<p className="mb-5 text-xs text-base-content/50">Pick a level. Everything updates live.</p>

			<BadgePicker value={badge} onChange={setBadge} />

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
							<span className="text-base-content/55"> — a month to Anthers</span>
						</div>
						<span className="w-14 text-right font-mono tabular-nums">{money(price)}</span>
					</div>
					<div className="mt-2.5 ml-1 flex flex-col gap-1.5 border-l border-base-content/10 pl-4">
						<SplitRow
							dot="bg-primary"
							label="Time Pool"
							desc="to the creators you watch, by time spent — paid out in full"
							amount={timePool}
						/>
						<SplitRow
							dot="bg-info"
							label="Supports Anthers"
							desc={
								n === 0
									? "free access for all is supported by paying users"
									: "free access & charitable programs"
							}
							amount={supportsAnthers}
						/>
					</div>
				</div>

				<div className="flex items-center justify-between gap-3 text-sm">
					<span className="text-base-content/75">
						<span className="font-medium text-base-content/90">Payments</span>
						<span className="text-base-content/55">
							{" "}
							— card processing, at cost, from inside what you give{" "}
						</span>
					</span>
					<span className="shrink-0 font-mono tabular-nums">~{money(processing)}</span>
				</div>

				{price > 0 && (
					<div className="flex items-center justify-between gap-3 text-sm">
						<span className="text-base-content/75">
							<span className="font-medium text-base-content/90">Sales tax</span>
							<span className="text-base-content/55"> — added on top, owed to your state </span>
							<InfoDot tip={TAX_TIP} />
						</span>
						<span className="shrink-0 font-mono tabular-nums">~{money(tax)}</span>
					</div>
				)}
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
					to the creators you watch — plus everything you give a creator directly, with no platform
					cut.
				</p>
			</div>
			<p className="mt-4 text-xs text-base-content/45">
				Streaming and downloads cost nothing on top of this — no allowance, no wallet, no per-GiB
				charge, and no limit on how many devices you use.
			</p>
		</div>
	);
}

// ─── (3) One-time purchases — static example (zero-cut) ───

export function PurchaseExample({
	price = 20,
	sizeGiB = 10,
}: {
	price?: number;
	sizeGiB?: number;
}) {
	// The list price IS the advertised price: card processing comes out of it, and sales
	// tax is the only thing added. Anthers keeps $0 — there is no platform fee on a
	// purchase (removed 2026-08-03) and no delivery charge (removed 2026-08-12).
	const card = cardFeeDisplay(price);
	const creator = price - card;
	const tax = price * TAX_PCT;
	const total = price + tax;

	const segments: Seg[] = [
		{
			label: "To the creator",
			desc: "what the seller receives — Anthers takes nothing",
			amount: creator,
			bar: "bg-primary",
			dot: "bg-primary",
		},
		{
			label: "Card processing",
			desc: "paid to the payment processor, at cost",
			amount: card,
			bar: "bg-base-content/15",
			dot: "bg-base-content/20",
		},
		{
			label: "Sales tax",
			desc: (
				<>
					added on top, owed to your state <InfoDot tip={TAX_TIP} />
				</>
			),
			amount: tax,
			bar: "bg-info",
			dot: "bg-info",
		},
	];

	return (
		<div className="relative rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			<div className="mb-5 flex items-baseline justify-between gap-3">
				<span className="text-sm text-base-content/55">
					Example — a {money(price)} indie game, {sizeGiB} GB
				</span>
				<span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
					Anthers takes $0
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
					the {money(price)} listed, plus your state's sales tax — of which{" "}
					<span className="font-semibold text-primary tabular-nums">{money(creator)}</span> reaches
					the creator.
				</p>
			</div>
			<p className="mt-4 text-xs text-base-content/45">
				That's it — the price you see is the price you pay, and Anthers keeps none of it. Card
				processing goes to the payment processor. Downloading it costs nothing, now or ever, on as
				many devices as you like.
			</p>
		</div>
	);
}
