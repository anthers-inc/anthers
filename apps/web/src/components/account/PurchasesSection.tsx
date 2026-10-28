// SPDX-License-Identifier: Apache-2.0

/*
 * The Purchases half of the account page — every one-time receipt, month by month.
 *
 * A purchase is a single exchange and outlives the Work it bought, so the list holds rows
 * that name nothing openable any more; PurchaseRow decides per row whether a link is
 * offered. The month selector scopes both the list and the totals beneath it.
 *
 * This is the second section of the account page, under BadgesSection: Badges are the
 * standing monthly amount, and these are the one-time buys.
 */

import { workUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Purchase } from "@anthers/web-shared/types";
import { useCallback, useEffect, useState } from "react";

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

// Pre-Orders view mode removed — the pre-order system is not yet implemented
// (milestone 8 of Direct Purchases), so the tab always rendered empty. Restore
// the "preorders" variant and the MonthSelector button when the lane ships.

/* ------------------------------------------------------------------ */
/*  Month Selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({ month, onChange }: { month: string; onChange: (m: string) => void }) {
	const current = getCurrentMonth();

	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				className="btn btn-ghost btn-xs"
				onClick={() => onChange(offsetMonth(month, -1))}
			>
				&larr;
			</button>
			<span className="text-sm font-medium min-w-[140px] text-center">
				{monthLabel(month)}
				{month === current && <span className="text-xs text-base-content/40 ml-1">(current)</span>}
			</span>
			{month < current ? (
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={() => onChange(offsetMonth(month, 1))}
				>
					&rarr;
				</button>
			) : null}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Purchase Row                                                       */
/* ------------------------------------------------------------------ */

/**
 * One receipt.
 *
 * Not every purchase names something openable: a Work that has since been removed leaves a
 * receipt with no page behind it. `work.publicId` comes from the live row (null once the
 * Work is gone), so it — not the title, which is a snapshot and always reads — is what
 * decides whether a link is offered.
 */
function PurchaseRow({ purchase: p }: { purchase: Purchase }) {
	const to =
		p.work?.publicId != null ? workUrl({ slug: p.work.slug, publicId: p.work.publicId }) : null;

	const label = p.work?.title ?? "Untitled";

	return (
		<div className="card bg-base-200">
			<div className="card-body p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-center gap-3 min-w-0">
						{/* The Work's thumbnail */}
						{p.work?.thumbnail && to ? (
							<Link to={to}>
								<img
									src={p.work.thumbnail}
									alt=""
									className="w-12 h-12 rounded object-cover flex-shrink-0"
								/>
							</Link>
						) : (
							<div className="w-12 h-12 rounded bg-base-300 flex-shrink-0" />
						)}

						<div className="min-w-0">
							{to ? (
								<Link to={to} className="font-medium link link-hover block truncate">
									{label}
								</Link>
							) : (
								<span className="font-medium block truncate">{label}</span>
							)}

							{/* Creator → profile link. */}
							{p.creator?.handle && (
								<Link
									to={profileUrl(p.creator.handle)}
									className="text-sm text-base-content/50 link link-hover"
								>
									@{p.creator.handle}
								</Link>
							)}
						</div>
					</div>

					<div className="text-right flex-shrink-0">
						<div className="font-medium">{fmt(parseFloat(p.amount))}</div>
						<div className="text-xs text-base-content/40">
							{new Date(p.createdAt).toLocaleDateString()}
						</div>
						{/* A physical purchase has something still happening: a parcel. The receipt
						    is the record, and the order is where the buyer follows it, confirms it
						    arrived, or reports a problem. */}
						{p.type === "physical" && (
							<Link to={`/orders/${p.id}`} className="link text-xs">
								Track this order
							</Link>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function PurchasesSection() {
	const [purchases, setPurchases] = useState<Purchase[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth());

	const fetchPurchases = useCallback(async (month?: string) => {
		setLoading(true);
		try {
			const query: Record<string, string> = {};
			if (month) query.month = month;

			const res = await client.api.payments.purchases.$get({ query });
			const data = (await res.json()) as { purchases: Purchase[] };
			setPurchases(data.purchases);
		} catch {
			// Non-critical
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchPurchases(selectedMonth);
	}, [selectedMonth, fetchPurchases]);

	const handleMonthChange = (month: string) => {
		setSelectedMonth(month);
	};

	// Compute totals
	const totalSpent = purchases.reduce((sum, p) => sum + parseFloat(p.amount), 0);
	const totalFees = purchases.reduce((sum, p) => sum + parseFloat(p.processingFee), 0);
	const totalCreator = purchases.reduce((sum, p) => sum + parseFloat(p.creatorEarnings), 0);

	return (
		<section aria-labelledby="purchases-section-heading">
			<div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4">
				<div>
					<h2 id="purchases-section-heading" className="text-xl font-bold">
						Purchases
					</h2>
					<p className="text-sm text-base-content/50">
						Everything you've bought outright, by the month you bought it.
					</p>
				</div>
				<MonthSelector month={selectedMonth} onChange={handleMonthChange} />
			</div>

			{/* Purchase list */}
			{loading ? (
				<div className="flex justify-center py-8">
					<span className="loading loading-spinner loading-md" />
				</div>
			) : purchases.length > 0 ? (
				<>
					<div className="space-y-3">
						{purchases.map((p) => (
							<PurchaseRow key={p.id} purchase={p} />
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
								You pay the listed price plus sales tax, and nothing else. Card processing comes out
								of that price at cost — Anthers takes no cut. Downloads are free, forever, on any
								number of devices.
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
			)}
		</section>
	);
}
