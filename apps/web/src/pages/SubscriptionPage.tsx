import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type {
	Subscription,
	AttentionSummary,
	PoolDistribution,
	BoostAllocation,
} from "../lib/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ALLOC = { creators: 0.92, foundation: 0.08 };
const CREATOR_POOL = 2.76;

const DELIVERY_PER_HOUR_VIDEO = 112.5 * 60 / 1024 * 0.01;
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
/*  Cycle helpers                                                      */
/* ------------------------------------------------------------------ */

function getCurrentCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function offsetCycle(cycle: string, offset: number): string {
	const d = new Date(cycle + "T00:00:00");
	d.setMonth(d.getMonth() + offset);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function cycleLabel(cycle: string): string {
	return new Date(cycle + "T00:00:00").toLocaleString("default", {
		month: "long",
		year: "numeric",
	});
}

type ViewMode = "past" | "current" | "next";

function viewModeFor(cycle: string): ViewMode {
	const current = getCurrentCycle();
	if (cycle === current) return "current";
	if (cycle > current) return "next";
	return "past";
}

/* ------------------------------------------------------------------ */
/*  Month Selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({
	cycle, onChange,
}: {
	cycle: string;
	onChange: (cycle: string) => void;
}) {
	const current = getCurrentCycle();
	const nextCycle = offsetCycle(current, 1);
	const mode = viewModeFor(cycle);

	return (
		<div className="flex items-center gap-3">
			<button
				className="btn btn-ghost btn-xs"
				onClick={() => onChange(offsetCycle(cycle, -1))}
			>
				&larr;
			</button>
			<span className="text-sm font-medium min-w-[140px] text-center">
				{cycleLabel(cycle)}
				{mode === "current" && (
					<span className="text-xs text-base-content/40 ml-1">(current)</span>
				)}
				{mode === "next" && (
					<span className="text-xs text-primary ml-1">(preview)</span>
				)}
			</span>
			{cycle < nextCycle ? (
				<button
					className="btn btn-ghost btn-xs"
					onClick={() => onChange(offsetCycle(cycle, 1))}
				>
					&rarr;
				</button>
			) : (
				<div className="btn btn-ghost btn-xs invisible">&rarr;</div>
			)}
		</div>
	);
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
	const [boosts, setBoosts] = useState<{
		boosts: BoostAllocation[];
		budget: string;
		allocated: string;
		remaining: string;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());
	const [boostSaving, setBoostSaving] = useState<number | null>(null);

	const sessionId = searchParams.get("session_id");
	const viewMode = viewModeFor(selectedCycle);

	// ── Fetch functions ──

	const fetchSubscription = useCallback(async () => {
		try {
			const res = await client.api.subscriptions.me.$get();
			const data = (await res.json()) as { subscription: Subscription };
			setSub(data.subscription);
		} catch {
			setError("Failed to load subscription.");
		} finally {
			setLoading(false);
		}
	}, []);

	const fetchCycleData = useCallback(async (cycle: string) => {
		const [attRes, distRes, boostRes] = await Promise.allSettled([
			client.api.subscriptions.attention.summary.$get({
				query: { cycle },
			}),
			client.api.subscriptions.distributions.$get({
				query: { cycle },
			}),
			client.api.subscriptions.boosts.$get({
				query: { cycle },
			}),
		]);

		if (attRes.status === "fulfilled") {
			setAttention((await attRes.value.json()) as AttentionSummary);
		}
		if (distRes.status === "fulfilled") {
			setDistributions(
				(await distRes.value.json()) as { distributions: PoolDistribution[] },
			);
		}
		if (boostRes.status === "fulfilled") {
			setBoosts(
				(await boostRes.value.json()) as {
					boosts: BoostAllocation[];
					budget: string;
					allocated: string;
					remaining: string;
				},
			);
		}
	}, []);

	useEffect(() => {
		fetchSubscription();
	}, [fetchSubscription]);

	useEffect(() => {
		fetchCycleData(selectedCycle);
	}, [selectedCycle, fetchCycleData]);

	useEffect(() => {
		if (sessionId) {
			setSuccess(
				"Subscription activated! Welcome aboard. It may take a moment for your plan to update.",
			);
			const timer = setTimeout(fetchSubscription, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId, fetchSubscription]);

	// ── Boost editing ──

	const handleBoostChange = async (creatorId: number, newAmount: number) => {
		setBoostSaving(creatorId);
		setError(null);
		try {
			const res = await client.api.subscriptions.boosts.$post({
				json: {
					creatorId,
					amount: newAmount.toFixed(2),
					cycle: selectedCycle,
				},
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				setError(data.error ?? "Failed to update boost.");
			} else {
				// Re-fetch boost data for the cycle
				const boostRes = await client.api.subscriptions.boosts.$get({
					query: { cycle: selectedCycle },
				});
				setBoosts(
					(await boostRes.json()) as {
						boosts: BoostAllocation[];
						budget: string;
						allocated: string;
						remaining: string;
					},
				);
			}
		} catch {
			setError("Failed to update boost.");
		} finally {
			setBoostSaving(null);
		}
	};

	// ── Actions ──

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
		const price = sub?.fundingLevel ?? tier.price;
		const foundationFee = Math.round(price * ALLOC.foundation * 100) / 100;
		const creatorShare = Math.round(price * ALLOC.creators * 100) / 100;
		const poolAmount = Math.min(CREATOR_POOL, creatorShare);
		const boostAmount = Math.max(0, Math.round((creatorShare - poolAmount) * 100) / 100);
		return { price, foundationFee, creatorShare, poolAmount, boostAmount };
	}, [sub, tier]);

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

	// Build a map of creatorId → boost amount for the Boost column
	const boostByCreator = useMemo(() => {
		const map = new Map<number, BoostAllocation>();
		if (boosts) {
			for (const b of boosts.boosts) {
				map.set(b.creatorId, b);
			}
		}
		return map;
	}, [boosts]);

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
					<h1 className="text-2xl font-bold">Your Anthers</h1>
					<span className="text-sm text-base-content/60">Free Plan</span>
				</div>

				{error && (
					<div className="alert alert-error mb-4"><span>{error}</span></div>
				)}
				{success && (
					<div className="alert alert-success mb-4"><span>{success}</span></div>
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

						<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />

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
	const boostBudget = parseFloat(boosts?.budget ?? "0");
	const canEditBoosts = viewMode === "current" || viewMode === "next";

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			{/* Header */}
			<div className="flex items-baseline justify-between mb-2">
				<h1 className="text-2xl font-bold">Your Anthers</h1>
				<span className="text-sm text-base-content/60">
					{tier.name} Plan ({fmt(financials.price)}/mo)
				</span>
			</div>

			{/* Month selector */}
			<div className="flex justify-center mb-4">
				<MonthSelector cycle={selectedCycle} onChange={setSelectedCycle} />
			</div>

			{error && (
				<div className="alert alert-error mb-4"><span>{error}</span></div>
			)}
			{success && (
				<div className="alert alert-success mb-4"><span>{success}</span></div>
			)}

			{/* Next-month preview banner */}
			{viewMode === "next" && (
				<div className="alert alert-info mb-4 text-sm">
					<span>
						Preview for {cycleLabel(selectedCycle)}. Boost changes here will
						take effect at the start of this billing cycle. You can increase
						or decrease boosts freely.
					</span>
				</div>
			)}

			{/* Past month banner */}
			{viewMode === "past" && (
				<div className="alert mb-4 text-sm bg-base-200">
					<span>
						Historical view for {cycleLabel(selectedCycle)}. This is a
						read-only summary of your billing for this period.
					</span>
				</div>
			)}

			{/* Status badges (current month only) */}
			{viewMode === "current" && (
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
			)}

			{/* ═══════════ Subscription split ═══════════ */}
			<div className="border-t-2 border-base-content/20 pt-4">
				<div className="flex justify-between text-sm mb-3">
					<span className="text-base-content/50">
						Anthers Foundation Fee (8%)
					</span>
					<span className="text-base-content/50">
						{fmt(financials.foundationFee)}
					</span>
				</div>

				<div className="flex justify-between text-sm">
					<span>
						Creator Pool{" "}
						<span className="text-base-content/40">(auto, time-proportional)</span>
					</span>
					<span className="font-medium">{fmt(financials.poolAmount)}</span>
				</div>

				{financials.boostAmount > 0 && (
					<div className="flex justify-between text-sm mt-1">
						<span>
							Boost Pool{" "}
							<span className="text-base-content/40">
								({boosts?.budget ? `${fmt(parseFloat(boosts.budget))} budget` : "auto allocation"})
							</span>
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
									const boostAlloc = boostByCreator.get(d.creatorId);
									const boostAmt = boostAlloc ? parseFloat(boostAlloc.amount) : parseFloat(d.boostAmount);
									const total = parseFloat(d.poolAmount) + boostAmt;
									const isSaving = boostSaving === d.creatorId;

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
													{canEditBoosts && boostBudget > 0 ? (
														<div className="flex items-center justify-end gap-1">
															{isSaving && (
																<span className="loading loading-spinner loading-xs" />
															)}
															<input
																type="number"
																className="input input-xs w-20 text-right"
																min={viewMode === "current" ? boostAmt : 0}
																max={boostBudget}
																step="0.01"
																value={boostAmt.toFixed(2)}
																onChange={(e) => {
																	const val = parseFloat(e.target.value);
																	if (!isNaN(val)) {
																		handleBoostChange(d.creatorId, val);
																	}
																}}
																disabled={isSaving}
															/>
														</div>
													) : (
														boostAmt > 0 ? fmt(boostAmt) : "—"
													)}
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

						{/* Boost editing hint */}
						{canEditBoosts && boostBudget > 0 && (
							<p className="text-[11px] text-base-content/30 mt-2">
								{viewMode === "current"
									? "Boosts can only be increased in the current month. Switch to next month's preview to decrease or remove boosts."
									: "You can freely adjust next month's boosts. Changes take effect at the start of the billing cycle."}
							</p>
						)}
					</div>
				) : (
					<div className="mt-4 py-6 text-center text-sm text-base-content/40">
						{viewMode === "next" ? (
							<p>
								Next month's distributions will be calculated based on your
								time with creators during {cycleLabel(selectedCycle)}.
							</p>
						) : (
							<>
								<p>No distributions yet this cycle.</p>
								<p className="mt-1">
									Your creator pool is distributed proportionally based on your
									time with creators — whether you're watching videos, reading
									articles, listening to music, or playing games.
								</p>
							</>
						)}
					</div>
				)}
			</div>

			{/* ═══════════ Bottom summary ═══════════ */}
			<div className="border-t-2 border-base-content/20 pt-4 mt-2 space-y-2 text-sm">
				<div className="flex justify-between">
					<span>Creator support</span>
					<span className="font-medium">{fmt(financials.creatorShare)}</span>
				</div>

				<div className="flex justify-between">
					<span>Anthers Foundation Fee</span>
					<span className="font-medium">{fmt(financials.foundationFee)}</span>
				</div>

				<div className="flex justify-between pt-1 border-t border-base-content/10">
					<span className="font-semibold">Subscription</span>
					<span className="font-semibold">{fmt(financials.price)}</span>
				</div>

				{viewMode !== "next" && (
					<>
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

						{deliveryEstimate.hours > 0 && deliveryEstimate.creditApplied && (
							<p className="text-[11px] text-base-content/30 leading-snug">
								{deliveryEstimate.net > 0
									? `Estimate assumes 1080p video rate. Your $1/mo delivery credit has been applied (${fmt(deliveryEstimate.gross)} gross − $1.00 credit). Audio and text cost far less to deliver.`
									: `Your $1/mo delivery credit covers this. Audio and text cost far less than video to deliver.`
								}
							</p>
						)}

						{deliveryEstimate.net > 0 && (
							<div className="flex justify-between pt-1 border-t border-base-content/10">
								<span className="font-semibold">Estimated total</span>
								<span className="font-semibold">
									~{fmt(financials.price + deliveryEstimate.net)}
								</span>
							</div>
						)}
					</>
				)}
			</div>

			{/* ═══════════ Actions (current month only) ═══════════ */}
			{viewMode === "current" && (
				<div className="mt-6 flex flex-wrap items-center gap-3">
					<Link to="/subscribe" className="btn btn-outline btn-sm">
						Change Plan
					</Link>

					{isCanceling ? (
						<button
							className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`}
							onClick={handleResume}
							disabled={!!actionLoading}
						>
							{actionLoading === "resume" ? "Resuming..." : "Resume Subscription"}
						</button>
					) : (
						<button
							className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
							onClick={handleCancel}
							disabled={!!actionLoading}
						>
							{actionLoading === "cancel" ? "Canceling..." : "Cancel Subscription"}
						</button>
					)}

					<button
						className={`btn btn-ghost btn-sm ${actionLoading === "portal" ? "btn-disabled" : ""}`}
						onClick={handleBillingPortal}
						disabled={!!actionLoading}
					>
						{actionLoading === "portal" ? "Opening..." : "Manage Billing"}
					</button>
				</div>
			)}

			{/* ═══════════ Footer nudges ═══════════ */}
			{viewMode === "current" && nextTier && (
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
