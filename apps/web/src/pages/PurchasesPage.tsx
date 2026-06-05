import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../lib/rpc";
import type { Purchase } from "../lib/types";

/* ------------------------------------------------------------------ */
/*  Extended purchase type with creator info from updated API          */
/* ------------------------------------------------------------------ */

interface PurchaseWithCreator extends Purchase {
	creator?: {
		username: string;
		displayName: string | null;
		avatar: string | null;
	};
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getCurrentMonth(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function offsetMonth(month: string, offset: number): string {
	const [y, m] = month.split("-").map(Number);
	const d = new Date(y, m - 1 + offset, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
	const [y, m] = month.split("-").map(Number);
	return new Date(y, m - 1, 1).toLocaleString("default", {
		month: "long",
		year: "numeric",
	});
}

function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}

type ViewMode = "month" | "preorders";

/* ------------------------------------------------------------------ */
/*  Month Selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({
	month,
	onChange,
	onPreorders,
	mode,
}: {
	month: string;
	onChange: (m: string) => void;
	onPreorders: () => void;
	mode: ViewMode;
}) {
	const current = getCurrentMonth();

	return (
		<div className="flex items-center gap-3">
			{mode === "month" ? (
				<>
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						onClick={() => onChange(offsetMonth(month, -1))}
					>
						&larr;
					</button>
					<span className="text-sm font-medium min-w-[140px] text-center">
						{monthLabel(month)}
						{month === current && (
							<span className="text-xs text-base-content/40 ml-1">(current)</span>
						)}
					</span>
					{month < current ? (
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => onChange(offsetMonth(month, 1))}
						>
							&rarr;
						</button>
					) : (
						<button
							type="button"
							className="btn btn-ghost btn-xs text-primary"
							onClick={onPreorders}
						>
							Pre-Orders &rarr;
						</button>
					)}
				</>
			) : (
				<>
					<button type="button" className="btn btn-ghost btn-xs" onClick={() => onChange(current)}>
						&larr; {monthLabel(current)}
					</button>
					<span className="text-sm font-medium text-primary">Pre-Orders</span>
				</>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function PurchasesPage() {
	const [purchases, setPurchases] = useState<PurchaseWithCreator[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth());
	const [viewMode, setViewMode] = useState<ViewMode>("month");

	const fetchPurchases = useCallback(async (month?: string) => {
		setLoading(true);
		try {
			const query: Record<string, string> = {};
			if (month) query.month = month;

			const res = await client.api.payments.purchases.$get({ query });
			const data = (await res.json()) as { purchases: PurchaseWithCreator[] };
			setPurchases(data.purchases);
		} catch {
			// Non-critical
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (viewMode === "month") {
			fetchPurchases(selectedMonth);
		} else {
			// TODO: Pre-orders — fetch pre-ordered content across all future dates.
			// The pre-order system is not yet implemented. When it is, this view
			// will show all pre-ordered items regardless of their delivery date,
			// since pre-orders can span months (some a month away, some many months).
			setPurchases([]);
			setLoading(false);
		}
	}, [selectedMonth, viewMode, fetchPurchases]);

	const handleMonthChange = (month: string) => {
		setViewMode("month");
		setSelectedMonth(month);
	};

	const handlePreorders = () => {
		setViewMode("preorders");
	};

	// Compute totals
	const totalSpent = purchases.reduce((sum, p) => sum + parseFloat(p.amount), 0);
	const totalFees = purchases.reduce((sum, p) => sum + parseFloat(p.processingFee), 0);
	const totalCreator = purchases.reduce((sum, p) => sum + parseFloat(p.creatorEarnings), 0);

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<div className="flex items-baseline justify-between mb-2">
				<h1 className="text-2xl font-bold">Purchases</h1>
			</div>

			{/* Month selector */}
			<div className="flex justify-center mb-6">
				<MonthSelector
					month={selectedMonth}
					onChange={handleMonthChange}
					onPreorders={handlePreorders}
					mode={viewMode}
				/>
			</div>

			{/* Pre-orders placeholder */}
			{viewMode === "preorders" && (
				<div className="card bg-base-200">
					<div className="card-body text-center text-base-content/50">
						<p className="font-medium">Pre-Orders</p>
						<p className="text-sm mt-1">
							No pre-orders yet. When you pre-order content, it will appear here regardless of its
							release date.
						</p>
						{/* TODO: Implement pre-order system. Pre-orders are one-time
						    purchases for content that hasn't been released yet. Unlike
						    subscription billing which is monthly, pre-orders can be for
						    content releasing at any future date, so they're shown in a
						    single unified list rather than month-by-month. */}
					</div>
				</div>
			)}

			{/* Purchase list */}
			{viewMode === "month" &&
				(loading ? (
					<div className="flex justify-center py-8">
						<span className="loading loading-spinner loading-md" />
					</div>
				) : purchases.length > 0 ? (
					<>
						<div className="space-y-3">
							{purchases.map((p) => (
								<div key={p.id} className="card bg-base-200">
									<div className="card-body p-4">
										<div className="flex items-start justify-between gap-3">
											<div className="flex items-center gap-3 min-w-0">
												{/* Cover image */}
												{p.project?.coverImage ? (
													<Link to={`/${p.creator?.username}/${p.project.slug}`}>
														<img
															src={p.project.coverImage}
															alt=""
															className="w-12 h-12 rounded object-cover flex-shrink-0"
														/>
													</Link>
												) : (
													<div className="w-12 h-12 rounded bg-base-300 flex-shrink-0" />
												)}

												<div className="min-w-0">
													{/* Project title → library link */}
													<Link
														to={`/${p.creator?.username}/${p.project?.slug}`}
														className="font-medium link link-hover block truncate"
													>
														{p.project?.title ?? "Unknown"}
													</Link>

													{/* Creator → profile link */}
													{p.creator && (
														<Link
															to={`/${p.creator.username}`}
															className="text-sm text-base-content/50 link link-hover"
														>
															@{p.creator.username}
														</Link>
													)}
												</div>
											</div>

											<div className="text-right flex-shrink-0">
												<div className="font-medium">{fmt(parseFloat(p.amount))}</div>
												<div className="text-xs text-base-content/40">
													{new Date(p.createdAt).toLocaleDateString()}
												</div>
											</div>
										</div>
									</div>
								</div>
							))}
						</div>

						{/* Summary */}
						{purchases.length > 0 && (
							<div className="border-t-2 border-base-content/20 pt-4 mt-6 space-y-2 text-sm">
								<div className="flex justify-between">
									<span>Purchases ({purchases.length})</span>
									<span className="font-medium">{fmt(totalSpent)}</span>
								</div>
								<div className="flex justify-between text-base-content/50">
									<span>Processing fees</span>
									<span>{fmt(totalFees)}</span>
								</div>
								<div className="flex justify-between text-base-content/50">
									<span>To creators</span>
									<span>{fmt(totalCreator)}</span>
								</div>
								<p className="text-[11px] text-base-content/30 mt-1">
									Purchase fees are pass-through processing costs. Creators receive the full
									purchase price — fees are added on top.
								</p>
							</div>
						)}
					</>
				) : (
					<div className="card bg-base-200">
						<div className="card-body text-center text-base-content/50">
							<p>No purchases in {monthLabel(selectedMonth)}.</p>
							<p className="text-sm mt-1">
								Direct purchases show up here — games, music downloads, digital goods, and other
								one-time items.
							</p>
						</div>
					</div>
				))}
		</div>
	);
}
