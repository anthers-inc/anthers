// SPDX-License-Identifier: AGPL-3.0-or-later

import { BANDWIDTH_PER_GIB, DELIVERY_GIB_PER_HOUR } from "@anthers/shared/constants";
import { type BadgePlanView, badgePlanViews } from "@anthers/shared/fees";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { BADGE_ART } from "@anthers/web-shared/economics";
import { client } from "@anthers/web-shared/rpc";
import type { AccountResponse, Badge } from "@anthers/web-shared/types";
import { useEffect, useState } from "react";

// The five Badge plans are static — derived entirely from BADGE_PLANS — so we
// render them synchronously instead of fetching /subscriptions/badges. That removes
// the loading skeleton (and its empty-card flash on every remount); the only async
// piece is a logged-in user's current badge, which just drives the "Your plan"
// highlight and never blocks the cards. Same source of truth as the API route
// (both call badgePlanViews()), so page and server can't drift.
const PLANS: BadgePlanView[] = badgePlanViews();

/* ------------------------------------------------------------------ */
/*  V4 economics — non-profit, no profit-taking                        */
/* ------------------------------------------------------------------ */
/*
 * A user CHOOSES a Badge plan (free/root/sprout/petal/blossom). The plan's
 * whole-dollar price decomposes into:
 *   Time Pool  → to creators, distributed by watch-time
 *   Seeds      → $1 units, 100% direct to the creators you give them to
 *   Community Share → the derived remainder, to the Anthers Foundation
 * Bandwidth is NOT part of the plan — it's a separate, at-cost prepaid wallet
 * ($0.01/GiB) with a per-tier free monthly allowance drawn down first.
 */

function fmt(n: number | string): string {
	return `$${Number(n).toFixed(2)}`;
}

/** Rough watch-hours a GiB figure buys at the 1080p60 AV1 reference throughput. */
function watchHours(gib: number): number {
	return Math.round(gib / DELIVERY_GIB_PER_HOUR);
}

/* ------------------------------------------------------------------ */
/*  Legend divider                                                    */
/* ------------------------------------------------------------------ */

/**
 * The vine separating the legend's columns — `divider-botanical`, the same
 * flourish used as a horizontal rule across the marketing pages, stood on end.
 *
 * It's positioned absolutely rather than rendered between the columns for two
 * reasons: the legend is a `sm:grid-cols-3`, so a real element there would land
 * in a fourth cell and break the layout; and a rotated element keeps its
 * *unrotated* layout box, which would reserve a square of dead space as wide as
 * the vine is tall. Out of flow, it costs nothing.
 *
 * `left-0` sits the box's left edge on the column's, so `-50%` centres it on
 * that edge and the extra `-1rem` walks it out to the middle of the `sm:gap-8`
 * (2rem) between columns — keep the two in step if the gap changes. Hidden below
 * `sm`, where the columns stack and a vertical rule would divide nothing.
 *
 * The positioning and `hidden sm:block` live on a wrapper rather than on the
 * glyph itself: <BrandGlyph> sets `display:inline-block` as an *inline style*,
 * which outranks any display utility, so `hidden` on a glyph silently does
 * nothing and it shows up on mobile anyway.
 */
function LegendDivider() {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute top-1/2 left-0 hidden h-16 w-16 sm:block"
			style={{ transform: "translate(calc(-50% - 1rem), -50%) rotate(90deg)" }}
		>
			<BrandGlyph name="divider-botanical" className="h-full w-full text-primary/30" />
		</span>
	);
}

/* ------------------------------------------------------------------ */
/*  Helper tip                                                        */
/* ------------------------------------------------------------------ */

/**
 * An (i) carrying a line of helper text. daisyUI's `.tooltip` handles hover and
 * keyboard (it opens on `:focus-visible`) by itself; the click toggle is here for
 * touch, where neither fires — without it the text is simply unreachable on a
 * phone. `aria-label` carries the text too, since the tooltip itself is CSS
 * `content:` that screen readers can't be relied on to announce.
 *
 * Opens to the right, not daisyUI's default centre-above: its only home is the
 * Free card, leftmost in the grid at every breakpoint, so a centred tooltip runs
 * off the left of the viewport and loses the first characters of every line.
 * daisyUI has no auto-flip. Revisit the placement if this ever sits somewhere
 * with room on both sides.
 */
function InfoTip({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	return (
		<span
			className={`tooltip tooltip-primary tooltip-right ${open ? "tooltip-open" : ""}`}
			data-tip={text}
		>
			<button
				type="button"
				aria-label={text}
				className="flex h-4 w-4 items-center justify-center rounded-full border border-base-content/25 text-[9px] font-semibold text-base-content/50 leading-none transition-colors hover:border-primary hover:text-primary"
				onClick={() => setOpen((v) => !v)}
				onBlur={() => setOpen(false)}
			>
				i
			</button>
		</span>
	);
}

/* ------------------------------------------------------------------ */
/*  Plan card                                                         */
/* ------------------------------------------------------------------ */

function PlanCard({
	plan,
	isCurrent,
	isDefault,
	saving,
	onChoose,
}: {
	plan: BadgePlanView;
	isCurrent: boolean;
	/** Free, shown to a logged-out visitor — the plan they'll land on by default. */
	isDefault: boolean;
	saving: boolean;
	onChoose: () => void;
}) {
	const isFree = plan.id === "free";
	// Both states wear the ring, but only a real current plan disables the button:
	// a logged-out visitor still needs it live to reach signup.
	const highlighted = isCurrent || isDefault;
	const tag = isCurrent ? "Your plan" : isDefault ? "Default" : null;
	return (
		<div
			className={`card bg-base-200/60 shadow-xl border-2 transition-all ${
				highlighted ? "ring-2 ring-primary border-primary" : "border-base-300"
			}`}
		>
			{/* [&>p]:grow-0 undoes daisyUI's `.card-body :where(p) { flex-grow: 1 }`. The grid
				stretches every card to the tallest one, and that rule would spend each shorter
				card's leftover height by inflating its paragraphs — so the same line sat at a
				different y on every card. Let the prose keep its natural height; card-actions'
				mt-auto absorbs the slack instead. */}
			<div className="card-body p-5 [&>p]:grow-0">
				{isFree ? (
					// Free has no badge — center the label so it's clear it's badgeless.
					// min-h-9 matches the badge glyph's height so every card's header row is
					// the same height and the content below stays aligned across the grid.
					<div className="flex min-h-9 items-center justify-center gap-2">
						<h3 className="text-lg font-bold">{plan.name}</h3>
						{tag && <span className="badge badge-primary badge-sm">{tag}</span>}
					</div>
				) : (
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center">
								<BrandGlyph
									name={BADGE_ART[plan.id].wreath}
									className="absolute inset-0 h-full w-full text-primary/55"
								/>
								<span aria-hidden="true" className="text-base">
									{BADGE_ART[plan.id].emoji}
								</span>
							</span>
							<h3 className="text-lg font-bold">{plan.name}</h3>
						</div>
						{tag && <span className="badge badge-primary badge-sm">{tag}</span>}
					</div>
				)}

				<div className="flex items-baseline gap-1 mt-1 mb-3">
					<span className="text-3xl font-bold">{fmt(plan.price)}</span>
					<span className="text-base-content/40 text-sm">/mo</span>
				</div>

				{/* Where the price goes */}
				<p className="text-[11px] uppercase tracking-wider text-base-content/40 mb-1">
					Where it goes
				</p>
				<div className="space-y-1 text-sm">
					<div className="flex items-center justify-between">
						<span className="flex items-center gap-1 text-base-content/70">
							Time Pool
							{/* Free's Time Pool is the one line item that needs explaining — it's the
								only plan where money reaches creators without the user paying any. */}
							{isFree && plan.subsidised && (
								<InfoTip text="Free forever. The Anthers Foundation subsidises this plan's Time Pool, so creators are still paid for your time while you pay $0." />
							)}
						</span>
						<strong>{fmt(plan.timePool)}</strong>
					</div>
					<div className="flex items-center justify-between">
						<span className="text-base-content/70">Seeds</span>
						<strong>{fmt(plan.seeds)}</strong>
					</div>
					<div className="flex items-center justify-between">
						<span className="text-base-content/70">Community Share</span>
						<strong>{fmt(plan.communityShare)}</strong>
					</div>
				</div>

				<div className="flex items-center justify-between text-sm border-t border-base-content/10 mt-2 pt-2 text-success">
					<span className="font-medium">To creators</span>
					<strong>{fmt(plan.toCreators)}</strong>
				</div>

				{/* What's included (bandwidth allowance is separate from the price) */}
				<p className="text-[11px] uppercase tracking-wider text-base-content/40 mt-3 mb-1">
					Includes
				</p>
				<p className="text-sm text-base-content/70">
					<strong>{plan.freeBwGiB} GiB</strong>/month of free bandwidth
				</p>
				<p className="text-[11px] text-base-content/40 leading-tight">
					≈ {watchHours(plan.freeBwGiB)} hrs of 1080p60 video (much more for audio, text, and
					images). Beyond that, bandwidth is billed at-cost.
				</p>

				<div className="card-actions mt-auto pt-4">
					<button
						type="button"
						className={`btn btn-sm w-full ${isCurrent ? "btn-disabled btn-ghost" : "btn-primary"}`}
						onClick={onChoose}
						disabled={isCurrent || saving}
					>
						{isCurrent
							? "Current plan"
							: saving
								? "Saving…"
								: isDefault
									? "Free forever"
									: isFree
										? "Switch to Free"
										: `Choose ${plan.name}`}
					</button>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function SubscribePage() {
	const { user } = useAuth();

	const [currentBadge, setCurrentBadge] = useState<Badge | null>(null);
	const [saving, setSaving] = useState<Badge | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// The plans render immediately from PLANS; the only fetch is a logged-in user's
	// current badge, which just highlights "Your plan". Logged-out visitors skip it,
	// and a failure is non-fatal — the cards still render, just without the highlight.
	useEffect(() => {
		if (!user) {
			setCurrentBadge(null);
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await client.api.subscriptions.me.$get();
				if (!res.ok) return;
				const data = (await res.json()) as AccountResponse;
				if (!cancelled) setCurrentBadge(data.badge);
			} catch {
				// Non-fatal: leave the highlight off.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [user]);

	const handleChoose = async (badge: Badge) => {
		if (!user) {
			window.location.href = "/login?next=/subscribe";
			return;
		}
		setSaving(badge);
		setError(null);
		setNotice(null);
		try {
			// TODO: Stripe charges the plan price (or the delta on a change) before this applies.
			const res = await client.api.subscriptions.account.$post({ json: { badge } });
			if (!res.ok) {
				setError("Failed to change your plan. Please try again.");
				return;
			}
			const data = (await res.json()) as AccountResponse;
			setCurrentBadge(data.badge);
			setNotice(`You're on the ${data.plan.name} plan.`);
		} catch {
			setError("Failed to change your plan. Please try again.");
		} finally {
			setSaving(null);
		}
	};

	return (
		<div className="mx-auto px-4 py-8" style={{ maxWidth: "88rem" }}>
			<Reveal className="text-center mb-8">
				<p className="text-xs uppercase tracking-wider text-base-content/40 mb-1">
					501(c)(3) non-profit
				</p>
				<h1 className="text-3xl font-bold mb-2">Choose your plan</h1>
				<p className="text-base-content/70 max-w-2xl mx-auto">
					Pick a Badge plan. Every whole dollar is itemized below — here's exactly where it goes:
				</p>
			</Reveal>

			{/* Legend — what each line item on the cards means (so the cards stay clean) */}
			<Reveal
				delay={120}
				className="max-w-4xl mx-auto mb-8 rounded-xl border border-primary/25 bg-primary/5 px-10 py-4"
			>
				{/* The wider gap from `sm` up is what the vine dividers stand in — at gap-4 the
					vine is fractionally wider than the gap itself and crowds the next column. */}
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-10">
					<div className="relative">
						<LegendDivider />
						<p className="font-semibold text-primary">Time Pool</p>
						<p className="text-xs text-base-content/70 leading-snug">
							Split across the creators you watch, by time spent.
						</p>
					</div>
					<div className="relative">
						<LegendDivider />
						<p className="font-semibold text-primary">Seeds</p>
						<p className="text-xs text-base-content/70 leading-snug">
							$1 each — you direct them to specific creators, 100% to them.
						</p>
					</div>
					<div className="relative">
						<LegendDivider />
						<p className="font-semibold text-primary">Community Share</p>
						<p className="text-xs text-base-content/70 leading-snug">
							Your charitable contribution to the Anthers Foundation.
						</p>
					</div>
				</div>
			</Reveal>

			{error && (
				<div className="alert alert-error mb-6 max-w-lg mx-auto">
					<span>{error}</span>
				</div>
			)}
			{notice && (
				<div className="alert alert-success mb-6 max-w-lg mx-auto">
					<span>{notice}</span>
				</div>
			)}

			{/* Plan cards — rendered synchronously from the static plan table, so there's
				no fetch, no loading skeleton, and no empty-card flash on remount. */}
			<Reveal
				delay={240}
				className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4"
			>
				{PLANS.map((plan) => (
					<PlanCard
						key={plan.id}
						plan={plan}
						isCurrent={currentBadge === plan.id}
						// Signing up puts you on Free unless you pick otherwise, so a logged-out
						// visitor sees it highlighted as where they'll land.
						isDefault={!user && plan.id === "free"}
						saving={saving === plan.id}
						onChoose={() => handleChoose(plan.id)}
					/>
				))}
			</Reveal>

			{!user && (
				<p className="text-center text-sm text-base-content/50 mt-6">
					<a href="/login?next=/subscribe" className="link link-primary">
						Sign in
					</a>{" "}
					to choose a plan.
				</p>
			)}

			{/* Bandwidth is a separate cheap wallet */}
			<div className="mt-12 card bg-base-200/60 shadow-xl p-6 max-w-3xl mx-auto">
				<h2 className="text-xl font-bold mb-4 text-center">
					Pay only for the bandwidth you use, at cost
				</h2>
				<p className="mb-2 text-base-content/60 leading-relaxed text-center">
					We care about supporting creators and their audiences, not turning a profit on usage.
				</p>
				<p className="mb-2 text-base-content/60 leading-relaxed text-center">
					Every plan, even the Free tier, includes a free monthly bandwidth allowance. If you stream
					past it, bandwidth is billed from a small prepaid wallet at our pass-through cost of{" "}
					<strong>{fmt(BANDWIDTH_PER_GIB)}/GiB</strong>. There's no markup and no profit margin, and
					if it ever becomes cheaper for us, those savings go to you.
				</p>
				<p className="mb-2 text-base-content/60 leading-relaxed text-center">
					To put things in perspective: The average YouTube user streams ~25 hours/month. With
					1080p30 video, you could put <strong>$5.00</strong> in your bandwidth wallet and cover
					that for <strong>well over a year</strong>.
				</p>
				<p className="mb-2 text-base-content/60 leading-relaxed text-center">
					Turns out, it's really not that expensive to give everyone access to great media.
				</p>
				{/*<p className="mb-2 text-base-content/60 leading-relaxed text-center">*/}
				{/*	Top up the*/}
				{/*	wallet and manage auto-top-up from{" "}*/}
				{/*	<a href="/subscription" className="link link-primary">*/}
				{/*		Your Anthers*/}
				{/*	</a>*/}
				{/*	.*/}
				{/*</p>*/}
			</div>

			{/* Why non-profit */}
			<div className="mt-12 max-w-3xl mx-auto text-center pb-4">
				<h2 className="text-xl font-bold mb-3">Why non-profit</h2>
				<p className="text-sm text-base-content/60 leading-relaxed max-w-2xl mx-auto">
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
