// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Support page (route: /subscribe) — SKETCH of the "Anthers is a creator you
// Seed" model. It's all one primitive: a Seed, $3/month, pointed one of two ways,
// shown as two symmetrical interactive cards wrapped in one outer card:
//
//   • Back the ANTHERS COMMONS (left) — the same Seed, pointed at Anthers. Each Seed
//     scales your streaming allowance, Time Pool, and Anthers-gate access rank.
//   • Back a CREATOR (right) — Seeds, $3/mo each, 100% to the creator. Each Seed level
//     unlocks more of their world, and each is branded with the creator's own Badge —
//     the same mechanic as Anthers's ranks, so users can collect badges across creators.
//
// Both cards share the BadgeLadder (Anthers renders its botanical rank wreaths; a creator
// renders their own cute emblems). Seeds run 0–10; past 4 you keep the top badge with a
// "+" (Blossom+, Legend+) while benefits keep scaling — the rank for gating stays the top.
// The outer card sums BOTH steppers into one monthly-spend breakdown. Dollar figures are
// ILLUSTRATIVE placeholders (pending the financial model); the backend is still the
// fixed-badge system, so the steppers are interactive front-end sketches, not wired to
// checkout.

import { DELIVERY_GIB_PER_HOUR } from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { BADGE_ART } from "@anthers/web-shared/economics";
import type { Badge } from "@anthers/web-shared/types";
import { useState } from "react";

/* ── Illustrative model (SKETCH — pending the financial model) ──────────────── */
const SEED_PRICE = 3; // $/month per Seed
const FREE_GIB = 15; // free streaming floor at 0 Seeds (generous, to avoid a paywall cliff)
const GIB_PER_SEED = 60; // added streaming allowance per Seed (never binds for ~anyone past Seed 1)
const TIMEPOOL_PER_SEED = 1.5; // $/month to creators, per Seed
const MAX_SEEDS = 10; // stepper cap; past 4 the top badge gains a "+"

// Anthers ranks map onto Seed counts: 1→Root, 2→Sprout, 3→Petal, 4+→Blossom.
const RANK_ORDER: Badge[] = ["root", "sprout", "petal", "blossom"];
const LADDER: { label: string; badge: Badge }[] = [
	{ label: "Free", badge: "free" },
	{ label: "Root", badge: "root" },
	{ label: "Sprout", badge: "sprout" },
	{ label: "Petal", badge: "petal" },
	{ label: "Blossom", badge: "blossom" },
];

// A generic example creator's Badges (one per Seed level) + what each unlocks. Cute and
// deliberately NOT botanical, so they read as the creator's own brand, distinct from
// Anthers's flower ranks. Gate i unlocks at i+1 Seeds ($(i+1)*3).
const CREATOR_BADGES = [
	{ emoji: "🐣", name: "New Friend", perk: "Early access to everything new" },
	{ emoji: "🌟", name: "Regular", perk: "Behind-the-scenes & extras" },
	{ emoji: "🎉", name: "Superfan", perk: "Community space + monthly livestream" },
	{ emoji: "👑", name: "Legend", perk: "A thank-you in the credits" },
];

function money(n: number): string {
	return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Illustrative at-cost card fee on a monthly charge (~2.9% + $0.30, batched). */
function cardFee(cost: number): number {
	return cost > 0 ? 0.3 + 0.029 * cost : 0;
}

/** Rough watch-hours a GiB figure buys at the 1080p60 AV1 reference throughput. */
function watchHours(gib: number): number {
	return Math.round(gib / DELIVERY_GIB_PER_HOUR);
}

/** The Anthers rank a given Seed count reaches (null at 0). */
function rankFor(seeds: number): Badge | null {
	return seeds <= 0 ? null : RANK_ORDER[Math.min(seeds, RANK_ORDER.length) - 1];
}

/* ── Small pieces ───────────────────────────────────────────────────────────── */

/** A −/+ integer stepper for a number of Seeds. */
function SeedCountStepper({
	value,
	min,
	max,
	onChange,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (v: number) => void;
}) {
	const set = (v: number) => onChange(Math.max(min, Math.min(max, v)));
	return (
		<div className="flex items-center gap-4">
			<button
				type="button"
				className="btn btn-circle btn-outline"
				onClick={() => set(value - 1)}
				disabled={value <= min}
				aria-label="Fewer Seeds"
			>
				−
			</button>
			<div className="min-w-[4.5rem] text-center">
				<div className="text-3xl font-bold tabular-nums leading-none">{value}</div>
				<div className="mt-1 text-xs text-base-content/50">Seed{value === 1 ? "" : "s"}</div>
			</div>
			<button
				type="button"
				className="btn btn-circle btn-outline"
				onClick={() => set(value + 1)}
				disabled={value >= max}
				aria-label="More Seeds"
			>
				+
			</button>
		</div>
	);
}

/** The one-line status under a stepper. Fixed min-height so a 1- vs 2-line message
 *  (e.g. "Following for free" vs a priced line) never changes the card height. */
function StepperStatus({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-[3rem] items-center justify-center text-center text-sm text-base-content/60">
			{children}
		</div>
	);
}

/** A line in the "what it gives you" benefits list. Reserves two lines of height so
 *  the free-tier vs paid text (which wrap differently) don't resize the card. */
function BenefitRow({
	icon,
	label,
	children,
}: {
	icon: string;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<li className="flex min-h-[2.75rem] items-center gap-2.5">
			<span aria-hidden="true" className="shrink-0">
				{icon}
			</span>
			<span className="leading-snug">
				<span className="text-base-content/80">{label}: </span>
				<span className="text-base-content/70">{children}</span>
			</span>
		</li>
	);
}

/** A creator Seed-gate line — unlocked (✓) or locked (🔒) at the current Seed count. */
function GateRow({
	threshold,
	unlocked,
	perk,
}: {
	threshold: number;
	unlocked: boolean;
	perk: string;
}) {
	return (
		<div className={`flex min-h-[2.25rem] items-center gap-2 ${unlocked ? "" : "opacity-45"}`}>
			<span aria-hidden="true" className="shrink-0 text-sm">
				{unlocked ? "✓" : "🔒"}
			</span>
			<span className="text-sm leading-snug">
				<span className="font-mono text-[11px] text-primary">{money(threshold)}</span>{" "}
				<span className="text-base-content/75">{perk}</span>
			</span>
		</div>
	);
}

/** A dotted line in the "where your money goes" breakdown. */
function BreakdownRow({
	dot,
	label,
	desc,
	amount,
	strong,
}: {
	dot: string;
	label: string;
	desc: string;
	amount: number;
	strong?: boolean;
}) {
	return (
		<div className="flex items-start justify-between gap-2">
			<span className="flex items-start gap-1.5 text-left">
				<span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
				<span className="leading-tight">
					<span className={`font-medium ${strong ? "text-success" : "text-base-content/80"}`}>
						{label}
					</span>
					<span className="block text-[11px] text-base-content/45">{desc}</span>
				</span>
			</span>
			<strong className={`shrink-0 tabular-nums ${strong ? "text-success" : ""}`}>
				{money(amount)}
			</strong>
		</div>
	);
}

/* ── Badge ladder (shared) ──────────────────────────────────────────────────── */

/** The "no badge" rung — an empty dashed ring (Anthers Free, or a creator you only follow). */
const freeRing = (active: boolean) => (
	<span
		className={`inline-block h-10 w-10 rounded-full border-2 border-dashed bg-base-content/5 ${
			active ? "border-base-content/30" : "border-base-content/20"
		}`}
	/>
);

/** A ladder of badges — the current one lit and enlarged, the rest small. Each sits in a
 *  FIXED slot and scales via transform, so stepping animates without reflowing the card.
 *  `plus` appends a "+" to the active (top) badge, for supporting beyond the top tier. */
function BadgeLadder({
	rungs,
	activeIndex,
	plus,
}: {
	rungs: { label: string; render: (active: boolean) => React.ReactNode }[];
	activeIndex: number;
	plus?: boolean;
}) {
	return (
		<div className="flex items-end justify-center gap-2">
			{rungs.map((rung, i) => {
				const active = i === activeIndex;
				const label = active && plus && i === rungs.length - 1 ? `${rung.label}+` : rung.label;
				return (
					<div key={rung.label} className="flex flex-col items-center gap-1">
						<div className="flex h-16 w-16 items-center justify-center">
							<div
								className={`relative flex h-16 w-16 items-center justify-center transition-transform duration-300 ease-out ${
									active ? "scale-100" : "scale-[0.6] opacity-40"
								}`}
							>
								{rung.render(active)}
							</div>
						</div>
						<span
							className={`text-[11px] transition-colors ${
								active ? "font-semibold text-primary" : "text-base-content/40"
							}`}
						>
							{label}
						</span>
					</div>
				);
			})}
		</div>
	);
}

// Anthers ranks render the botanical wreath + emoji from the brand package.
const ANTHERS_RUNGS = LADDER.map((rung) => ({
	label: rung.label,
	render: (active: boolean) =>
		rung.badge === "free" ? (
			freeRing(active)
		) : (
			<>
				{active && (
					<span className="absolute inset-1 rounded-full bg-primary/10 ring-2 ring-primary/30" />
				)}
				<BrandGlyph
					name={BADGE_ART[rung.badge].wreath}
					className={`absolute inset-0 h-full w-full ${
						active ? "text-primary/60" : "text-base-content/45"
					}`}
				/>
				<span aria-hidden="true" className="relative text-2xl">
					{BADGE_ART[rung.badge].emoji}
				</span>
			</>
		),
}));

// A creator's badges render their own cute emblem in a simple disc.
const CREATOR_RUNGS = [
	{ label: "Following", render: (active: boolean) => freeRing(active) },
	...CREATOR_BADGES.map((b) => ({
		label: b.name,
		render: (active: boolean) => (
			<span
				className={`flex h-full w-full items-center justify-center rounded-full text-2xl transition-colors ${
					active ? "bg-primary/15 ring-2 ring-primary/40" : "bg-primary/5 ring-1 ring-primary/20"
				}`}
			>
				{b.emoji}
			</span>
		),
	})),
];

/* ── The two symmetrical support cards (controlled — parent owns the Seed counts) ── */

function AnthersCard({ seeds, onChange }: { seeds: number; onChange: (v: number) => void }) {
	const cost = SEED_PRICE * seeds;
	const gib = FREE_GIB + GIB_PER_SEED * seeds;
	const timePool = TIMEPOOL_PER_SEED * seeds;
	const rank = rankFor(seeds);
	const rankName = rank ? rank[0].toUpperCase() + rank.slice(1) : null;

	return (
		<div className="flex h-full flex-col rounded-2xl border-2 border-accent/30 bg-base-200/60 p-6 shadow-sm">
			<p className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">
				Back Anthers · your streaming + access
			</p>
			<h2 className="mb-4 text-2xl font-bold">Support the Anthers commons</h2>

			<p className="mb-2 mx-auto max-w-2xl leading-relaxed text-base-content/70">
				When you give a Seed to Anthers, you get additional streaming bandwidth across the platform,
				and a larger payment pool spread among the creators you stream. You also unlock special
				Anthers-gated content across all creators on the platform.
			</p>

			<div className="my-4 border-t border-base-content/10 pt-4">
				<BadgeLadder
					rungs={ANTHERS_RUNGS}
					activeIndex={Math.min(seeds, LADDER.length - 1)}
					plus={seeds > RANK_ORDER.length}
				/>
			</div>

			<div className="my-4 flex flex-col items-center gap-2">
				<SeedCountStepper value={seeds} min={0} max={MAX_SEEDS} onChange={onChange} />
				<StepperStatus>
					{seeds === 0 ? (
						"Free — backing Anthers with nothing yet"
					) : (
						<span>
							<span className="text-lg font-bold text-base-content/90">{money(cost)}</span>/month ·{" "}
							{seeds} Seed{seeds === 1 ? "" : "s"} to Anthers
						</span>
					)}
				</StepperStatus>
			</div>

			<div className="border-t border-base-content/10 pt-4">
				<p className="mb-2 text-[11px] uppercase tracking-wider text-base-content/40">
					What it gives you
				</p>
				<ul>
					<BenefitRow icon="📶" label="Streaming">
						<strong>{gib} GiB</strong>/mo of streaming (≈{watchHours(gib)}hrs 1080p),
						{seeds === 0 ? " free forever" : " always at-cost"}
					</BenefitRow>
					<BenefitRow icon="🌻" label="Time Pool">
						{seeds === 0 ? (
							<span>
								<strong>$0.05</strong>/mo → creators, subsidized by the Foundation
							</span>
						) : (
							<span>
								<strong>{money(timePool)}</strong>/mo → creators, for the free content you stream
							</span>
						)}
					</BenefitRow>
					<BenefitRow icon="🔓" label="Access">
						{rankName ? (
							<>
								<strong>{rankName}</strong>-gated content, across every creator
							</>
						) : (
							<span className="text-base-content/50">Free public content only</span>
						)}
					</BenefitRow>
				</ul>
			</div>
		</div>
	);
}

function CreatorCard({ seeds, onChange }: { seeds: number; onChange: (v: number) => void }) {
	const cost = SEED_PRICE * seeds;

	return (
		<div className="flex h-full flex-col rounded-2xl border-2 border-primary/25 bg-primary/5 p-6 shadow-sm">
			<p className="mb-1 text-xs font-semibold uppercase tracking-wider text-primary">
				Back a creator · 0% cut
			</p>
			<h2 className="mb-4 text-2xl font-bold">Support the creators you love</h2>

			<p className="mb-2 mx-auto max-w-2xl leading-relaxed text-base-content/70">
				When you give a Seed to a creator, it reaches them in full: 100%, no cut, no processing
				skim. It's recurring support, like a membership, and each Seed level unlocks more of what
				they make based on Creator Badges they define and design just for their community.
			</p>

			<div className="my-4 border-t border-base-content/10 pt-4">
				<BadgeLadder
					rungs={CREATOR_RUNGS}
					activeIndex={Math.min(seeds, CREATOR_RUNGS.length - 1)}
					plus={seeds > CREATOR_BADGES.length}
				/>
			</div>

			<div className="my-4 flex flex-col items-center gap-2">
				<SeedCountStepper value={seeds} min={0} max={MAX_SEEDS} onChange={onChange} />
				<StepperStatus>
					{seeds === 0 ? (
						"Following for free"
					) : (
						<span>
							<span className="text-lg font-bold text-base-content/90">{money(cost)}</span>/month ·
							100% to the creator
						</span>
					)}
				</StepperStatus>
			</div>

			<div className="border-t border-base-content/10 pt-4">
				<p className="mb-2 text-[11px] uppercase tracking-wider text-base-content/40">
					What you unlock
				</p>
				<div>
					{CREATOR_BADGES.map((b, i) => (
						<GateRow
							key={b.name}
							threshold={(i + 1) * SEED_PRICE}
							unlocked={seeds >= i + 1}
							perk={b.perk}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

/* ── Page ───────────────────────────────────────────────────────────────────── */

export default function SubscribePage() {
	const { user } = useAuth();
	const signedIn = !!user;

	const [anthersSeeds, setAnthersSeeds] = useState(1);
	const [creatorSeeds, setCreatorSeeds] = useState(1);

	// Combined monthly spend, summed across both steppers. Payments is a single at-cost
	// card fee on the whole batched charge, added ON TOP — never carved out of a Seed.
	const creatorCost = SEED_PRICE * creatorSeeds;
	const anthersCost = SEED_PRICE * anthersSeeds;
	const anthersTimePool = TIMEPOOL_PER_SEED * anthersSeeds;
	// Supports Anthers = your bandwidth (at cost) + the Foundation remainder. No payments inside.
	const anthersSupportsAnthers = anthersCost - anthersTimePool;
	const totalPayments = cardFee(creatorCost + anthersCost);
	const toCreators = creatorCost + anthersTimePool;
	const totalMonthly = creatorCost + anthersCost + totalPayments;

	return (
		<div className="mx-auto px-4 py-8" style={{ maxWidth: "80rem" }}>
			<Reveal className="mb-8 text-center">
				<p className="my-2 text-xs uppercase tracking-wider text-base-content/40">
					Non-profit · no profit-taking
				</p>
				<h1 className="mb-4 text-3xl font-bold">Help grow what you love</h1>
				<p className="mb-4 mx-auto max-w-2xl leading-relaxed text-base-content/70">
					Basic access to Anthers is <strong>free for everyone, forever, no ads.</strong>
				</p>
				<p className="mx-auto max-w-2xl leading-relaxed text-base-content/70">
					When you're ready for more, support on Anthers is all in the form of Seeds, each a
					$3/month boost used to support Anthers or individual creators. Wherever they go, know that
					you're directly supporting a non-profit platform and its creators, not shareholders or
					data brokers.
				</p>
			</Reveal>

			{/* Outer card: the two support cards + one combined spend summary. */}
			<Reveal
				delay={120}
				className="rounded-3xl border border-base-300 bg-base-100 p-4 shadow-lg sm:p-6"
			>
				<div className="grid items-stretch gap-4 lg:grid-cols-2">
					<AnthersCard seeds={anthersSeeds} onChange={setAnthersSeeds} />
					<CreatorCard seeds={creatorSeeds} onChange={setCreatorSeeds} />
				</div>

				{/* Combined monthly-spend breakdown (both steppers, summed) */}
				<div className="mt-6 border-t border-base-300 pt-5">
					<p className="mb-3 text-center text-xs font-semibold uppercase tracking-wider text-base-content/50">
						Your monthly support
					</p>
					<div className="mx-auto max-w-md space-y-1.5">
						<BreakdownRow
							dot="bg-success"
							label="Direct to creators"
							desc="Seeds you give creators — 100% to them"
							amount={creatorCost}
							strong
						/>
						<BreakdownRow
							dot="bg-success"
							label="Time Pool"
							desc="via your Anthers Seeds, to creators by watch-time"
							amount={anthersTimePool}
							strong
						/>
						<BreakdownRow
							dot="bg-info"
							label="Supports Anthers"
							desc="your bandwidth (at cost) + free access & programs"
							amount={anthersSupportsAnthers}
						/>
						<BreakdownRow
							dot="bg-base-content/30"
							label="Payments"
							desc="card & processing, at cost"
							amount={totalPayments}
						/>
					</div>
					<div className="mx-auto mt-3 flex max-w-md items-baseline justify-between border-t border-base-content/10 pt-3">
						<span className="font-bold">Total</span>
						<span className="text-xl font-bold tabular-nums">
							{money(totalMonthly)}
							<span className="text-sm font-normal text-base-content/50">/mo</span>
						</span>
					</div>
					<p className="mx-auto mt-1 max-w-md text-center text-xs text-base-content/55">
						<span className="font-semibold text-success">{money(toCreators)}</span> of that reaches
						creators.
					</p>
				</div>
			</Reveal>

			{/* One shared sign-up CTA below the outer card */}
			<Reveal delay={200} className="mx-auto mt-10 max-w-xl text-center">
				{signedIn ? (
					<a href="/discover" className="btn btn-primary btn-lg px-8">
						Find creators to support
					</a>
				) : (
					<a href="/signup" className="btn btn-primary btn-lg px-8">
						Create your free account
					</a>
				)}
				<p className="mt-3 text-sm text-base-content/50">
					Free forever — set up your support whenever you like.
				</p>
			</Reveal>

			{/* Why non-profit */}
			<div className="mx-auto mt-14 max-w-3xl pb-4 text-center">
				<h2 className="mb-3 text-xl font-bold">Why non-profit</h2>
				<p className="mx-auto max-w-2xl text-sm leading-relaxed text-base-content/60">
					Anthers is a non-profit because the only way to guarantee that our platform always serves
					creators is to make it legally impossible for it to act otherwise. Anthers cannot
					distribute profits to insiders, cannot be acquired, and cannot have its mission diluted by
					investors. If it ever ceases to operate, its assets go to another exempt organization, not
					to founders or shareholders.
				</p>
			</div>
		</div>
	);
}
