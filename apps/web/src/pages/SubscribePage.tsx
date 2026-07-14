// SPDX-License-Identifier: AGPL-3.0-or-later

import { BANDWIDTH_PER_GIB, DELIVERY_GIB_PER_HOUR } from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { BADGE_ART } from "@anthers/web-shared/economics";
import { client } from "@anthers/web-shared/rpc";
import type { AccountResponse, Badge, BadgePlan } from "@anthers/web-shared/types";
import { useEffect, useMemo, useState } from "react";

/* ------------------------------------------------------------------ */
/*  V4 economics — non-profit, no profit-taking                        */
/* ------------------------------------------------------------------ */
/*
 * A user CHOOSES a Badge plan (free/root/sprout/petal/blossom). The plan's
 * whole-dollar price decomposes into:
 *   Time Pool  → to creators, distributed by watch-time
 *   Seeds      → $1 units, 100% direct to the creators you sow them on
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
/*  Plan card                                                         */
/* ------------------------------------------------------------------ */

function PlanCard({
	plan,
	isCurrent,
	saving,
	onChoose,
}: {
	plan: BadgePlan;
	isCurrent: boolean;
	saving: boolean;
	onChoose: () => void;
}) {
	const isFree = plan.id === "free";
	return (
		<div
			className={`card bg-base-200/60 shadow-xl border-2 transition-all ${
				isCurrent ? "ring-2 ring-primary border-primary" : "border-base-300"
			}`}
		>
			<div className="card-body p-5">
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
					{isCurrent && <span className="badge badge-primary badge-sm">Your plan</span>}
				</div>

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
						<span className="text-base-content/70">Time Pool</span>
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
					<strong>{plan.freeBwGiB} GiB</strong> of free bandwidth each month
				</p>
				<p className="text-[11px] text-base-content/40 leading-tight">
					≈ {watchHours(plan.freeBwGiB)} hrs of 1080p60 video (much more for audio, text, and
					images). Beyond that, bandwidth is billed at cost from your wallet.
				</p>

				{isFree && plan.subsidised && (
					<p className="text-[11px] text-base-content/40 mt-1">
						The free plan's small Time Pool is subsidised by the Anthers Foundation — you pay $0.
					</p>
				)}

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

	const [plans, setPlans] = useState<BadgePlan[]>([]);
	const [currentBadge, setCurrentBadge] = useState<Badge | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState<Badge | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		const fetchData = async () => {
			try {
				const [badgeRes, meRes] = await Promise.all([
					client.api.subscriptions.badges.$get(),
					user ? client.api.subscriptions.me.$get() : Promise.resolve(null),
				]);
				const badgeData = (await badgeRes.json()) as { badges: BadgePlan[] };
				setPlans(badgeData.badges);
				if (meRes) {
					const meData = (await meRes.json()) as AccountResponse;
					setCurrentBadge(meData.badge);
				}
			} catch {
				setError("Failed to load the plans. Please try again.");
			} finally {
				setLoading(false);
			}
		};
		fetchData();
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

	const sortedPlans = useMemo(() => plans, [plans]);

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
				className="max-w-4xl mx-auto mb-8 rounded-xl border border-primary/25 bg-primary/5 px-5 py-4"
			>
				<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
					<div>
						<p className="font-semibold text-primary">Time Pool</p>
						<p className="text-xs text-base-content/70 leading-snug">
							Split across the creators you watch, by time spent.
						</p>
					</div>
					<div>
						<p className="font-semibold text-primary">Seeds</p>
						<p className="text-xs text-base-content/70 leading-snug">
							$1 each — you direct them to specific creators, 100% to them.
						</p>
					</div>
					<div>
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

			{/* Plan cards — skeletons hold the layout height while badges load, so the
				grassy floor never jumps up into view then snaps back down. */}
			{loading ? (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
					{[0, 1, 2, 3, 4].map((i) => (
						<div key={`plan-skeleton-${i}`} className="skeleton h-[31rem] rounded-2xl" />
					))}
				</div>
			) : (
				<Reveal
					delay={240}
					className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4"
				>
					{sortedPlans.map((plan) => (
						<PlanCard
							key={plan.id}
							plan={plan}
							isCurrent={currentBadge === plan.id}
							saving={saving === plan.id}
							onChoose={() => handleChoose(plan.id)}
						/>
					))}
				</Reveal>
			)}

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
				<h2 className="text-xl font-bold mb-2 text-center">Bandwidth is separate — and at cost</h2>
				<p className="text-sm text-base-content/60 leading-relaxed text-center">
					Your plan is about funding creators, not buying gigabytes. Every plan includes a free
					monthly bandwidth allowance (from {plans[0]?.freeBwGiB ?? 5} GiB on Free up to{" "}
					{plans[plans.length - 1]?.freeBwGiB ?? 50} GiB on Blossom). If you stream past it,
					bandwidth is billed from a small prepaid <strong>wallet</strong> at DigitalOcean's
					pass-through cost of <strong>{fmt(BANDWIDTH_PER_GIB)}/GiB</strong> — no markup, no
					platform margin. Top up the wallet and manage auto-top-up from{" "}
					<a href="/subscription" className="link link-primary">
						Your Anthers
					</a>
					.
				</p>
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
