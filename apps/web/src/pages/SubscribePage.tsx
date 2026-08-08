// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Support page (route: /subscribe) — SKETCH of the "Anthers is a creator you
// Seed" model. It's all one primitive: a Seed, $3/month, pointed one of two ways,
// shown as two symmetrical interactive cards wrapped in one outer card:
//
//   • Back the ANTHERS COMMONS (left) — the same Seed, pointed at Anthers. Each Seed
//     scales your streaming allowance, Time Pool, and the Anthers Gates you clear.
//   • Back a CREATOR (right) — Seeds, $3/mo each, no platform cut. Each Seed level
//     unlocks more of their world, and each is branded with the creator's own Badge —
//     the same mechanic as Anthers' Badges, so users can collect them across creators.
//
// Both cards share the BadgeLadder (Anthers renders its botanical wreaths; a creator
// renders their own cute emblems). Seeds run 0–10; past 4 you keep the top Badge with a
// "+" (Blossom+, Legend+) while benefits keep scaling — the gating Badge stays the top.
// The outer card sums BOTH steppers into one monthly-spend breakdown. Every dollar figure
// comes from @anthers/shared/constants — the same dials the API charges against — so this
// page can't drift from the model; the creator-Badge names/perks are the only invented
// part. The Anthers stepper commits for real through SubscriptionPaymentModal; the
// creator stepper stays illustrative, since giving Seeds to a creator needs a creator.

import {
	CARD_FLAT,
	CARD_RATE,
	DELIVERY_GIB_PER_HOUR,
	FREE_FLOOR_GIB,
	FREE_TIME_POOL,
	GIB_PER_SEED,
	SEED_PRICE,
	TIME_POOL_PER_SEED,
} from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { BADGE_ART } from "@anthers/web-shared/economics";
import { client } from "@anthers/web-shared/rpc";
import type { Badge } from "@anthers/web-shared/types";
import { useState } from "react";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../components/subscribe/SubscriptionPaymentModal";

/* ── Model dials — all from @anthers/shared/constants, never re-typed here ───── */
const FREE_GIB = FREE_FLOOR_GIB; // free streaming floor at 0 Seeds (avoids a paywall cliff)
const TIMEPOOL_PER_SEED = TIME_POOL_PER_SEED; // $/month to creators, per Seed given to Anthers
const FREE_TIMEPOOL = FREE_TIME_POOL; // $/month to creators at 0 Seeds, funded as free access
const MAX_SEEDS = 10; // stepper cap (a page choice, not a model dial); past 4 the badge gains a "+"

// Anthers Badges map onto Seed counts: 1→Root, 2→Sprout, 3→Petal, 4+→Blossom.
const BADGE_NAMES: Badge[] = ["root", "sprout", "petal", "blossom"];
const LADDER: { label: string; badge: Badge }[] = [
	{ label: "Free", badge: "free" },
	{ label: "Root", badge: "root" },
	{ label: "Sprout", badge: "sprout" },
	{ label: "Petal", badge: "petal" },
	{ label: "Blossom", badge: "blossom" },
];

// A generic example creator's Badges (one per Seed level) + what each unlocks. Cute and
// deliberately NOT botanical, so they read as the creator's own brand, distinct from
// Anthers' flower Badges. Gate i unlocks at i+1 Seeds ($(i+1)*3).
const CREATOR_BADGES = [
	{ emoji: "🐣", name: "New Friend", perk: "Early access to everything new" },
	{ emoji: "🌟", name: "Regular", perk: "Behind-the-scenes & extras" },
	{ emoji: "🎉", name: "Superfan", perk: "Community space + monthly livestream" },
	{ emoji: "👑", name: "Legend", perk: "A thank-you in the credits" },
];

function money(n: number): string {
	return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The at-cost card fee on a monthly charge (2.9% + $0.30 on the whole batch). */
function cardFee(cost: number): number {
	return cost > 0 ? CARD_FLAT + CARD_RATE * cost : 0;
}

/** Rough watch-hours a GiB figure buys at the 1080p60 AV1 reference throughput. */
function watchHours(gib: number): number {
	return Math.round(gib / DELIVERY_GIB_PER_HOUR);
}

/** The Anthers Badge a given Seed count reaches (null at 0). */
function badgeAt(seeds: number): Badge | null {
	return seeds <= 0 ? null : BADGE_NAMES[Math.min(seeds, BADGE_NAMES.length) - 1];
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
						<div className="flex h-14 w-14 items-center justify-center sm:h-16 sm:w-16">
							<div
								className={`relative flex h-14 w-14 items-center justify-center transition-transform duration-300 ease-out sm:h-16 sm:w-16 ${
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

// Anthers Badges render the botanical wreath + emoji from the brand package.
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
	const badge = badgeAt(seeds);
	const badgeName = badge ? badge[0].toUpperCase() + badge.slice(1) : null;

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
					plus={seeds > BADGE_NAMES.length}
				/>
			</div>

			<div className="my-4 flex flex-col items-center gap-2">
				<SeedCountStepper value={seeds} min={0} max={MAX_SEEDS} onChange={onChange} />
				<StepperStatus>
					{seeds === 0 ? (
						"Forever-free access to the Anthers platform"
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
								<strong>{money(FREE_TIMEPOOL)}</strong>/mo → creators, covered as free access
							</span>
						) : (
							<span>
								<strong>{money(timePool)}</strong>/mo → creators, for the free content you stream
							</span>
						)}
					</BenefitRow>
					<BenefitRow icon="🔓" label="Access">
						{badgeName ? (
							<>
								<strong>{badgeName}</strong>-gated content, across every creator
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
				When you give a Seed to a creator, it goes straight to them — Anthers takes no cut, no fee,
				no skim. It's recurring support, like a membership, and each Seed level unlocks more of what
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
						"Following but not supporting, only public-access content"
					) : (
						<span>
							<span className="text-lg font-bold text-base-content/90">{money(cost)}</span>/month ·
							no platform cut
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

	// Default both steppers to 0 so the page opens on the fully-free view (no Seeds to
	// either Anthers or a creator) — a visitor sees $0/mo first, then opts up if they like.
	const [anthersSeeds, setAnthersSeeds] = useState(0);
	const [creatorSeeds, setCreatorSeeds] = useState(0);

	// The commit ceremony. This page used to render both steppers and no way to act on
	// them — /subscription's "Adjust Seeds" pointed here, which was a dead end. It opens
	// the SAME modal the locked-post inline unlock uses, deliberately: one ceremony, so
	// proration, the next-charge date and the saved card are described identically
	// wherever a user commits.
	const [pending, setPending] = useState<{
		anthersSeeds: number;
		badgeName: string;
		preview: SubscriptionPreview;
	} | null>(null);
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState<string | null>(null);

	const commitAnthersSeeds = async () => {
		setCommitting(true);
		setCommitError(null);
		try {
			const res = await client.api.subscriptions.preview[":seeds"].$get({
				param: { seeds: String(anthersSeeds) },
			});
			if (!res.ok) {
				setCommitError("Couldn't load the details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({
				anthersSeeds,
				// The Seed count is the honest label: a commit needn't land on a Badge, and
				// naming the Badge below the count would understate what's being given.
				badgeName: `${anthersSeeds} Seed${anthersSeeds === 1 ? "" : "s"}`,
				preview,
			});
		} catch {
			setCommitError("Couldn't load the details. Please try again.");
		} finally {
			setCommitting(false);
		}
	};

	// Combined monthly spend, summed across both steppers. Payments is a single at-cost
	// card fee on the whole batched charge, and it sits INSIDE the price — the Seed
	// subtotal IS the total, with sales tax the only thing added later. It splits
	// pro-rata, so directed Seeds amortise the fixed $0.30 and creators net more.
	const creatorCost = SEED_PRICE * creatorSeeds;
	const anthersCost = SEED_PRICE * anthersSeeds;
	const anthersTimePool = TIMEPOOL_PER_SEED * anthersSeeds;
	const seedSubtotal = creatorCost + anthersCost;
	const totalPayments = cardFee(seedSubtotal);
	// Split the one card fee across the two destinations by their share of the charge.
	const creatorPayments = seedSubtotal > 0 ? (totalPayments * creatorCost) / seedSubtotal : 0;
	const anthersPayments = totalPayments - creatorPayments;
	// What creators actually receive from directed Seeds, net of their share.
	const creatorDirectNet = creatorCost - creatorPayments;
	// Supports Anthers = your bandwidth (at cost) + the remainder that funds free
	// access and the charitable programs, after this side's share of Payments. The
	// remainder is the shock absorber; Time Pool is a fixed target and never moves.
	const anthersSupportsAnthers = anthersCost - anthersTimePool - anthersPayments;
	const toCreators = creatorDirectNet + anthersTimePool;
	const totalMonthly = seedSubtotal;

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade so this
		// wrapper can shrink below its inner cards' min-content width — without
		// `w-full`, `mx-auto` on a flex item disables the default
		// `align-self: stretch`, so the wrapper falls back to its content's
		// intrinsic width (up to the cap), which the inner cards push past the
		// mobile viewport. The wide-screen cap is `max-w-[80rem]` (was an inline
		// style, which wins over `max-w-full` and so defeated the cap below the
		// cap, leaving the page able to grow to 1280px on mobile).
		<div className="mx-auto min-w-0 w-full max-w-full max-w-[80rem] px-4 py-8">
			<Reveal className="mb-8 text-center">
				<p className="my-2 text-xs uppercase tracking-wider text-base-content/40">
					Non-profit · no profit-taking
				</p>
				<h1 className="mb-4 text-3xl font-bold">Help grow what you love</h1>
				<p className="mb-4 mx-auto max-w-2xl leading-relaxed text-base-content/70">
					Basic access to Anthers is <strong>free for everyone, forever, no ads.</strong>
				</p>
				<p className="mx-auto max-w-5xl leading-relaxed text-base-content/70">
					When you're ready for more, support on Anthers is all in the form of Seeds, each{" "}
					{money(SEED_PRICE)}/month, used to support Anthers or individual creators. Wherever they
					go, know that you're directly supporting a non-profit platform and its creators, not
					shareholders or data brokers.
				</p>
			</Reveal>

			{/* Outer card: the two support cards + one combined spend summary. */}
			<Reveal
				delay={120}
				className="rounded-3xl border border-base-300 bg-base-100 p-4 shadow-lg sm:p-6"
			>
				<div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
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
							desc="Seeds you give creators — no platform cut"
							amount={creatorDirectNet}
							strong
						/>
						<BreakdownRow
							dot="bg-success"
							label="Time Pool"
							desc={
								anthersSeeds === 0
									? `free access sends ${money(FREE_TIMEPOOL)}/mo to creators for you`
									: "via the Seeds you give Anthers, to creators by watch-time"
							}
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
							desc="card & processing, at cost — paid to the processor"
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
					{totalMonthly > 0 && (
						<p className="mx-auto max-w-md text-right text-xs text-base-content/45">
							plus any applicable sales tax
						</p>
					)}
					<p className="mx-auto mt-1 max-w-md text-center text-xs text-base-content/55">
						{totalMonthly > 0 ? (
							<>
								<span className="font-semibold text-success">{money(toCreators)}</span> of that
								reaches creators.
							</>
						) : (
							<>
								You pay $0 — Anthers still sends{" "}
								<span className="font-semibold text-success">{money(FREE_TIMEPOOL)}</span>/mo to
								creators for you.
							</>
						)}
					</p>
				</div>
			</Reveal>

			{/* One shared CTA below the outer card. Signed in with Seeds set for Anthers, it
			    commits them; otherwise it points at the next useful thing. */}
			<Reveal delay={200} className="mx-auto mt-10 max-w-xl text-center">
				{!signedIn ? (
					<a href="/signup" className="btn btn-primary btn-lg px-8">
						Create your free account
					</a>
				) : anthersSeeds > 0 ? (
					<button
						type="button"
						className={`btn btn-primary btn-lg px-8 ${committing ? "btn-disabled" : ""}`}
						onClick={commitAnthersSeeds}
						disabled={committing}
					>
						{committing
							? "Loading…"
							: `Give ${anthersSeeds} Seed${anthersSeeds === 1 ? "" : "s"} to Anthers`}
					</button>
				) : (
					<a href="/discover" className="btn btn-primary btn-lg px-8">
						Find creators to support
					</a>
				)}
				{commitError && <p className="mt-3 text-sm text-error">{commitError}</p>}
				<p className="mt-3 text-sm text-base-content/50">
					{signedIn && anthersSeeds > 0
						? "You'll see the exact charge before anything is confirmed."
						: signedIn && creatorSeeds > 0
							? "Seeds for a creator are given from that creator's page."
							: "Free forever — set up your support whenever you like."}
				</p>
			</Reveal>

			{pending && (
				<SubscriptionPaymentModal
					anthersSeeds={pending.anthersSeeds}
					badgeName={pending.badgeName}
					preview={pending.preview}
					onComplete={() => {
						setPending(null);
						// The webhook applies the Seed count, so send the user where it shows.
						window.location.href = "/subscription";
					}}
					onClose={() => setPending(null)}
				/>
			)}

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
