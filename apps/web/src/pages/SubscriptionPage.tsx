import { useState, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type {
	Subscription,
	AttentionSummary,
	PoolDistribution,
} from "../lib/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ALLOC = { creators: 0.92, foundation: 0.08 };
const CREATOR_POOL = 2.76;

/** 1080p60 midpoint ~15 Mbps. Delivery at $0.01/GiB. ~$0.066/hr. */
const DELIVERY_PER_HOUR_VIDEO = 112.5 * 60 / 1024 * 0.01;
/** Flat delivery credit for all paid subscribers. */
const DELIVERY_CREDIT = 1.00;

const TIER_THRESHOLDS: { id: string; name: string; price: number }[] = [
	{ id: "free", name: "Free", price: 0 },
	{ id: "root", name: "Root", price: 3 },
	{ id: "sprout", name: "Sprout", price: 7 },
	{ id: "petal", name: "Petal", price: 15 },
	{ id: "bloom", name: "Bloom", price: 30 },
];

function tierFor(id: string) {
	return TIER_THRESHOLDS.find((t) => t.id === id) ?? TIER_THRESHOLDS[0];
}

function nextTierFor(id: string) {
	const idx = TIER_THRESHOLDS.findIndex((t) => t.id === id);
	if (idx < 0 || idx >= TIER_THRESHOLDS.length - 1) return null;
	return TIER_THRESHOLDS[idx + 1];
}

function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}

function formatHours(seconds: number): string {
	const hrs = seconds / 3600;
	if (hrs >= 1) return `${hrs.toFixed(1)} hrs`;
	const mins = Math.round(seconds / 60);
	return mins > 0 ? `${mins}m` : "0m";
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function SubscriptionPage() {
	const [searchParams] = useSearchParams();
	const [sub, setSub] = useState<Subscription | null>(null);
	const [attention, setAttention] = useState<AttentionSummary | null>(null);
	const [distributions, setDistributions] = useState<{
		distributions: PoolDistribution[];
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	const sessionId = searchParams.get("session_id");

	useEffect(() => {
		fetchSubscription();
		fetchAttention();
		fetchDistributions();
	}, []);

	useEffect(() => {
		if (sessionId) {
			setSuccess(
				"Subscription activated! Welcome aboard. It may take a moment for your plan to update.",
			);
			const timer = setTimeout(fetchSubscription, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId]);

	async function fetchSubscription() {
		try {
			const res = await client.api.subscriptions.me.$get();
			const data = (await res.json()) as { subscription: Subscription };
			setSub(data.subscription);
		} catch {
			setError("Failed to load subscription.");
		} finally {
			setLoading(false);
		}
	}

	async function fetchAttention() {
		try {
			const res = await client.api.subscriptions.attention.summary.$get();
			const data = (await res.json()) as AttentionSummary;
			setAttention(data);
		} catch {
			// Non-critical
		}
	}

	async function fetchDistributions() {
		try {
			const res = await client.api.subscriptions.distributions.$get();
			const data = (await res.json()) as {
				distributions: PoolDistribution[];
			};
			setDistributions(data);
		} catch {
			// Non-critical
		}
	}

	const handleCancel = async () => {
		setActionLoading("cancel");
		setError(null);
		try {
			const res = await client.api.subscriptions.cancel.$post();
			const data = (await res.json()) as { subscription: Subscription };
			setSub(data.subscription);
			setSuccess("Your subscription will cancel at the end of the current billing period.");
		} catch {
			setError("Failed to cancel subscription.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleResume = async () => {
		setActionLoading("resume");
		setError(null);
		try {
			const res = await client.api.subscriptions.resume.$post();
			const data = (await res.json()) as { subscription: Subscription };
			setSub(data.subscription);
			setSuccess("Subscription resumed.");
		} catch {
			setError("Failed to resume subscription.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleBillingPortal = async () => {
		setActionLoading("portal");
		try {
			const res = await client.api.subscriptions["billing-portal"].$post();
			const data = (await res.json()) as { portalUrl: string };
			window.location.href = data.portalUrl;
		} catch {
			setError("Failed to open billing portal.");
			setActionLoading(null);
		}
	};

	/* ---- Derived values ---- */

	const tier = sub ? tierFor(sub.tier) : TIER_THRESHOLDS[0];
	const isPaid = tier.price > 0;
	const isCanceling = sub ? !!sub.canceledAt : false;

	const financials = useMemo(() => {
		const price = tier.price;
		const foundationFee = Math.round(price * ALLOC.foundation * 100) / 100;
		const creatorShare = Math.round(price * ALLOC.creators * 100) / 100;
		const poolAmount = Math.min(CREATOR_POOL, creatorShare);
		const boostAmount = Math.max(0, Math.round((creatorShare - poolAmount) * 100) / 100);
		return { price, foundationFee, creatorShare, poolAmount, boostAmount };
	}, [tier]);

	const distTotals = useMemo(() => {
		if (!distributions) return null;
		const dists = distributions.distributions;
		let totalSeconds = 0;
		let totalPool = 0;
		let totalBoost = 0;
		for (const d of dists) {
			totalSeconds += d.attentionSeconds ?? 0;
			totalPool += parseFloat(d.poolAmount);
			totalBoost += parseFloat(d.boostAmount);
		}
		return {
			totalSeconds,
			totalPool: Math.round(totalPool * 100) / 100,
			totalBoost: Math.round(totalBoost * 100) / 100,
			totalCreator: Math.round((totalPool + totalBoost) * 100) / 100,
			count: dists.length,
		};
	}, [distributions]);

	const deliveryEstimate = useMemo(() => {
		const hrs = attention?.hoursUsed ?? 0;
		const gross = Math.round(hrs * DELIVERY_PER_HOUR_VIDEO * 100) / 100;
		const net = isPaid ? Math.max(0, Math.round((gross - DELIVERY_CREDIT) * 100) / 100) : gross;
		return { hours: hrs, gross, net, creditApplied: isPaid };
	}, [attention, isPaid]);

	const nextTier = sub ? nextTierFor(sub.tier) : null;

	const cycleLabel = attention
		? new Date(attention.cycleStart + "T00:00:00").toLocaleString("default", {
			month: "long",
			year: "numeric",
		})
		: null;

	/* ---- Render ---- */

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	if (!sub) {
		return (
			<div className="max-w-2xl mx-auto px-4 py-8 text-center">
				<h1 className="text-2xl font-bold mb-4">No Subscription</h1>
				<p className="mb-4">You don't have an active subscription yet.</p>
				<Link to="/subscribe" className="btn btn-primary">
					Choose a Plan
				</Link>
			</div>
		);
	}

	/* ---- Free user view ---- */
	if (!isPaid) {
		return (
			<div className="max-w-2xl mx-auto px-4 py-8">
				<div className="flex items-baseline justify-between mb-6">
					<h1 className="text-2xl font-bold">
						{cycleLabel ? `Your Anthers — ${cycleLabel}` : "Your Anthers"}
					</h1>
					<span className="text-sm text-base-content/60">Free Plan</span>
				</div>

				{error && (
					<div className="alert alert-error mb-4">
						<span>{error}</span>
					</div>
				)}
				{success && (
					<div className="alert alert-success mb-4">
						<span>{success}</span>
					</div>
				)}

				<div className="card bg-base-200">
					<div className="card-body">
						<div className="flex items-center justify-between">
							<div>
								<h2 className="card-title">Free Plan</h2>
								<div className="badge badge-success badge-sm mt-1">Active</div>
							</div>
							<Link to="/subscribe" className="btn btn-primary btn-sm">
								Upgrade
							</Link>
						</div>

						{attention && (
							<div className="mt-4">
								<div className="flex items-center justify-between text-sm mb-1">
									<span className="text-base-content/60">Time with Creators</span>
									<span className="font-medium">{attention.hoursUsed} hrs</span>
								</div>
								<p className="text-xs text-base-content/40">
									All media types count equally — a minute of video, audio,
									reading, or gameplay is the same when funding your creators.
								</p>
							</div>
						)}

						<div className="mt-4 text-sm text-base-content/60">
							Delivery covered by the Anthers Foundation (up to 10 hrs/mo).
						</div>

						{sub.currentPeriodEnd && (
							<div className="text-sm text-base-content/60 mt-2">
								Next billing date:{" "}
								<span className="font-medium">
									{new Date(sub.currentPeriodEnd).toLocaleDateString()}
								</span>
							</div>
						)}

						{nextTier && (
							<div className="mt-4 pt-3 border-t border-base-content/10">
								<Link to="/subscribe" className="text-sm text-primary hover:underline">
									Subscribe at {nextTier.name} (${nextTier.price}/mo) to
									start funding your creators directly &rarr;
								</Link>
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	/* ---- Paid user view ---- */

	const hasDists = distributions && distributions.distributions.length > 0;

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			{/* Header */}
			<div className="flex items-baseline justify-between mb-6">
				<h1 className="text-2xl font-bold">
					{cycleLabel ? `Your Anthers — ${cycleLabel}` : "Your Anthers"}
				</h1>
				<span className="text-sm text-base-content/60">
					{tier.name} Plan ({fmt(tier.price)}/mo)
				</span>
			</div>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}
			{success && (
				<div className="alert alert-success mb-4">
					<span>{success}</span>
				</div>
			)}

			{/* Status badges */}
			<div className="flex items-center gap-2 mb-4">
				{sub.isActive ? (
					<div className="badge badge-success badge-sm">Active</div>
				) : (
					<div className="badge badge-error badge-sm">Inactive</div>
				)}
				{isCanceling && (
					<div className="badge badge-warning badge-sm">
						Cancels at period end
					</div>
				)}
				{sub.currentPeriodEnd && (
					<span className="text-xs text-base-content/40">
						{isCanceling ? "Access until" : "Next billing date"}:{" "}
						{new Date(sub.currentPeriodEnd).toLocaleDateString()}
					</span>
				)}
			</div>

			{/* ═══════════ Subscription split ═══════════ */}
			<div className="border-t-2 border-base-content/20 pt-4">
				{/* Foundation Fee */}
				<div className="flex justify-between text-sm mb-3">
					<span className="text-base-content/50">
						Anthers Foundation Fee (8%)
					</span>
					<span className="text-base-content/50">
						{fmt(financials.foundationFee)}
					</span>
				</div>

				{/* Creator Pool */}
				<div className="flex justify-between text-sm">
					<span>
						Creator Pool{" "}
						<span className="text-base-content/40">(auto, time-proportional)</span>
					</span>
					<span className="font-medium">{fmt(financials.poolAmount)}</span>
				</div>

				{/* Boost Pool */}
				{financials.boostAmount > 0 && (
					<div className="flex justify-between text-sm mt-1">
						<span>
							Boost Pool{" "}
							<span className="text-base-content/40">(auto allocation)</span>
						</span>
						<span className="font-medium">{fmt(financials.boostAmount)}</span>
					</div>
				)}

				{/* ── Per-creator distribution table ── */}
				{hasDists ? (
					<div className="mt-4 overflow-x-auto">
						<table className="table table-sm">
							<thead>
								<tr className="text-base-content/50">
									<th className="font-normal">Creator</th>
									<th className="font-normal text-right">Time</th>
									<th className="font-normal text-right">Pool</th>
									{financials.boostAmount > 0 && (
										<th className="font-normal text-right">Boost</th>
									)}
									<th className="font-normal text-right">Total</th>
								</tr>
							</thead>
							<tbody>
								{distributions!.distributions.map((d) => {
									const total = parseFloat(d.poolAmount) + parseFloat(d.boostAmount);
									return (
										<tr key={d.id}>
											<td>
												<Link
													to={`/${d.creator?.username}`}
													className="link link-hover"
												>
													{d.creator?.displayName || d.creator?.username}
												</Link>
											</td>
											<td className="text-right text-base-content/50">
												{formatHours(d.attentionSeconds ?? 0)}
											</td>
											<td className="text-right">{fmt(parseFloat(d.poolAmount))}</td>
											{financials.boostAmount > 0 && (
												<td className="text-right">
													{parseFloat(d.boostAmount) > 0
														? fmt(parseFloat(d.boostAmount))
														: "—"}
												</td>
											)}
											<td className="text-right font-medium">
												{fmt(total)}
											</td>
										</tr>
									);
								})}
							</tbody>
							{distTotals && distTotals.count > 1 && (
								<tfoot>
									<tr className="border-t border-base-content/20">
										<td className="text-base-content/50">
											{distTotals.count} creators
										</td>
										<td className="text-right text-base-content/50">
											{formatHours(distTotals.totalSeconds)}
										</td>
										<td className="text-right font-medium">
											{fmt(distTotals.totalPool)}
										</td>
										{financials.boostAmount > 0 && (
											<td className="text-right font-medium">
												{distTotals.totalBoost > 0
													? fmt(distTotals.totalBoost)
													: "—"}
											</td>
										)}
										<td className="text-right font-bold">
											{fmt(distTotals.totalCreator)}
										</td>
									</tr>
								</tfoot>
							)}
						</table>
					</div>
				) : (
					<div className="mt-4 py-6 text-center text-sm text-base-content/40">
						<p>No distributions yet this cycle.</p>
						<p className="mt-1">
							Your creator pool is distributed proportionally based on your
							time with creators — whether you're watching videos, reading
							articles, listening to music, or playing games.
						</p>
					</div>
				)}
			</div>

			{/* ═══════════ Bottom summary ═══════════ */}
			<div className="border-t-2 border-base-content/20 pt-4 mt-2 space-y-2 text-sm">
				{/* Creator support */}
				<div className="flex justify-between">
					<span>Creator support</span>
					<span className="font-medium">{fmt(financials.creatorShare)}</span>
				</div>

				{/* Foundation Fee */}
				<div className="flex justify-between">
					<span>Anthers Foundation Fee</span>
					<span className="font-medium">{fmt(financials.foundationFee)}</span>
				</div>

				{/* Subscription total line */}
				<div className="flex justify-between pt-1 border-t border-base-content/10">
					<span className="font-semibold">Subscription</span>
					<span className="font-semibold">{fmt(financials.price)}</span>
				</div>

				{/* Delivery estimate */}
				<div className="flex justify-between text-base-content/50">
					<span>
						Delivery
						{deliveryEstimate.hours > 0 && (
							<span className="text-base-content/30">
								{" "}({deliveryEstimate.hours} hrs across all media)
							</span>
						)}
					</span>
					<span>
						{deliveryEstimate.hours > 0 ? (
							deliveryEstimate.net > 0
								? <>~{fmt(deliveryEstimate.net)}</>
								: <span className="text-success">covered</span>
						) : "—"}
					</span>
				</div>

				{/* Delivery note */}
				{deliveryEstimate.hours > 0 && deliveryEstimate.creditApplied && (
					<p className="text-[11px] text-base-content/30 leading-snug">
						{deliveryEstimate.net > 0
							? `Estimate assumes 1080p video rate. Your $1/mo delivery credit has been applied (${fmt(deliveryEstimate.gross)} gross − $1.00 credit). Audio and text cost far less to deliver.`
							: `Your $1/mo delivery credit covers this. Audio and text cost far less than video to deliver.`
						}
					</p>
				)}

				{/* Estimated total */}
				{deliveryEstimate.net > 0 && (
					<div className="flex justify-between pt-1 border-t border-base-content/10">
						<span className="font-semibold">Estimated total</span>
						<span className="font-semibold">
							~{fmt(financials.price + deliveryEstimate.net)}
						</span>
					</div>
				)}
			</div>

			{/* ═══════════ Actions ═══════════ */}
			<div className="mt-6 flex flex-wrap items-center gap-3">
				<Link to="/subscribe" className="btn btn-outline btn-sm">
					Change Plan
				</Link>

				{isCanceling ? (
					<button
						className={`btn btn-success btn-sm ${
							actionLoading === "resume" ? "btn-disabled" : ""
						}`}
						onClick={handleResume}
						disabled={!!actionLoading}
					>
						{actionLoading === "resume" ? "Resuming..." : "Resume Subscription"}
					</button>
				) : (
					<button
						className={`btn btn-outline btn-error btn-sm ${
							actionLoading === "cancel" ? "btn-disabled" : ""
						}`}
						onClick={handleCancel}
						disabled={!!actionLoading}
					>
						{actionLoading === "cancel" ? "Canceling..." : "Cancel Subscription"}
					</button>
				)}

				<button
					className={`btn btn-ghost btn-sm ${
						actionLoading === "portal" ? "btn-disabled" : ""
					}`}
					onClick={handleBillingPortal}
					disabled={!!actionLoading}
				>
					{actionLoading === "portal" ? "Opening..." : "Manage Billing"}
				</button>
			</div>

			{/* ═══════════ Footer nudges ═══════════ */}
			{nextTier && (
				<div className="mt-4">
					<Link to="/subscribe" className="text-sm text-primary hover:underline">
						Adjust your support level anytime &rarr;{" "}
						<span className="text-base-content/40">
							You're ${nextTier.price - tier.price} from {nextTier.name} perks
						</span>
					</Link>
				</div>
			)}
		</div>
	);
}
