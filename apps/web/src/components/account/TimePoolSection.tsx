// SPDX-License-Identifier: Apache-2.0
/**
 * The Time tab's first card — the full Time Pool breakdown for one month.
 *
 * ⭐ **The pool has two halves on one row** (Parker, 2026-11-12): what the time split paid a
 * creator, and what the supporter directed by hand as a Sticker. Both are the same pot, so
 * the table shows them as columns beside each other and totals them together rather than
 * presenting Stickers as a second pool. The month defaults to the current one and steps
 * backwards; a future month has no pool to show.
 *
 * The card is controlled by the Time tab so the Activity Details card below it can follow
 * the same month. Before 2026-11-12 this arithmetic lived on the Badges tab, where the Badge
 * column made the pool look like part of the Badge rather than part of time.
 */

import { currentCycleKey, cycleStart, previousCycleKey } from "@anthers/shared/billing-cycle";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import type { AttentionSummary, PoolDistribution } from "@anthers/web-shared/types";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import { useEffect, useMemo, useState } from "react";
import { timePoolTotals } from "../../lib/time-pool-table";

function fmt(n: number | string): string {
	return `$${Number(n).toFixed(2)}`;
}

function formatHours(seconds: number): string {
	const hrs = seconds / 3600;
	if (hrs >= 1) return `${hrs.toFixed(1)} hrs`;
	const mins = Math.round(seconds / 60);
	return mins > 0 ? `${mins}m` : "0m";
}

function monthLabel(cycle: string): string {
	return cycleStart(cycle).toLocaleString("default", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

function initials(displayName: string | null, handle: string): string {
	return (displayName || handle)
		.split(/\s+/)
		.map((word) => word[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Month selector                                                     */
/* ------------------------------------------------------------------ */

function MonthSelector({ cycle, onChange }: { cycle: string; onChange: (cycle: string) => void }) {
	const current = currentCycleKey();
	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				className="btn btn-ghost btn-xs"
				aria-label="Earlier month"
				onClick={() => onChange(previousCycleKey(cycle))}
			>
				&larr;
			</button>
			<span className="min-w-[140px] text-center text-sm font-medium">
				{monthLabel(cycle)}
				{cycle === current && <span className="ml-1 text-xs text-base-content/40">(current)</span>}
			</span>
			{cycle < current ? (
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					aria-label="Later month"
					onClick={() => onChange(nextCycle(cycle))}
				>
					&rarr;
				</button>
			) : (
				<div className="btn btn-ghost btn-xs invisible">&rarr;</div>
			)}
		</div>
	);
}

/** The month after this one, up to the current month. */
function nextCycle(cycle: string): string {
	const current = currentCycleKey();
	const start = cycleStart(cycle);
	const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
	const key = next.toISOString().slice(0, 10);
	return key > current ? current : key;
}

/* ------------------------------------------------------------------ */
/*  Page card                                                          */
/* ------------------------------------------------------------------ */

export default function TimePoolSection({
	cycle,
	onCycleChange,
}: {
	cycle: string;
	onCycleChange: (cycle: string) => void;
}) {
	const [distributions, setDistributions] = useState<PoolDistribution[] | null>(null);
	const [summary, setSummary] = useState<AttentionSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setDistributions(null);
		setSummary(null);
		setError(null);

		const query = `?cycle=${encodeURIComponent(cycle)}`;
		Promise.allSettled([
			apiFetch(`/api/subscriptions/distributions${query}`).then(async (res) => {
				if (!res.ok) throw new Error("Could not load the Time Pool.");
				return (await res.json()) as { distributions: PoolDistribution[] };
			}),
			apiFetch(`/api/subscriptions/attention/summary${query}`).then(async (res) => {
				if (!res.ok) throw new Error("Could not load the time summary.");
				return (await res.json()) as AttentionSummary;
			}),
		]).then(([dist, attention]) => {
			if (!alive) return;
			if (dist.status === "fulfilled") setDistributions(dist.value.distributions);
			else setError("Could not load the Time Pool.");
			if (attention.status === "fulfilled") setSummary(attention.value);
		});

		return () => {
			alive = false;
		};
	}, [cycle]);

	const rows = useMemo(() => {
		const mapped = (distributions ?? []).map((distribution) => {
			const byTime = Number(distribution.poolAmount);
			const directed = Number(distribution.stickerAmount ?? 0);
			const timeSeconds = distribution.attentionSeconds ?? 0;
			return {
				id: distribution.id,
				handle: distribution.creator?.handle ?? "",
				displayName:
					distribution.creator?.displayName ??
					(distribution.creatorId === null ? "A former creator" : null),
				avatar: distribution.creator?.avatar ?? null,
				byTime,
				directed,
				timeSeconds,
				total: byTime + directed,
			};
		});
		return mapped
			.filter((row) => row.total > 0 || row.timeSeconds > 0)
			.sort(
				(a, b) =>
					b.total - a.total || (a.displayName ?? a.handle).localeCompare(b.displayName ?? b.handle),
			);
	}, [distributions]);

	const totals = timePoolTotals(
		rows.map((row) => ({ poolAmount: row.byTime, stickerAmount: row.directed })),
	);
	const poolSeconds = rows.reduce((sum, row) => sum + row.timeSeconds, 0);
	const loading = distributions === null && !error;

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div>
						<h3 className="card-title text-lg">
							Time Pool
							<InfoTip text="Half of what you give Anthers funds the Time Pool, divided among the Public Access creators you spent time with. Gated or purchased work is already paid for by whoever cleared the gate or bought it, so it draws nothing from the pool. A free account's pool comes from Anthers' Time Pool Fund." />
						</h3>
						<p className="text-sm text-base-content/60">
							What your time sends to creators, and what you directed by hand from the same pot.
						</p>
					</div>
					<MonthSelector cycle={cycle} onChange={onCycleChange} />
				</div>

				{error && (
					<div className="alert alert-error mt-3">
						<span>{error}</span>
					</div>
				)}

				{loading ? (
					<p className="mt-3 text-sm text-base-content/50">Loading the month…</p>
				) : (
					<>
						<div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
							<div>
								<div className="text-xs uppercase text-base-content/50">Time Pool</div>
								<div className="text-lg font-bold text-success tabular-nums">
									{fmt(totals.total)}
								</div>
								<div className="text-[11px] text-base-content/40">all creators</div>
							</div>
							<div>
								<div className="text-xs uppercase text-base-content/50">By Time</div>
								<div className="text-lg font-bold tabular-nums">{fmt(totals.poolAmount)}</div>
								<div className="text-[11px] text-base-content/40">
									divided by Public Access time
								</div>
							</div>
							<div>
								<div className="text-xs uppercase text-base-content/50">Directed by You</div>
								<div className="text-lg font-bold tabular-nums">{fmt(totals.stickerAmount)}</div>
								<div className="text-[11px] text-base-content/40">
									Stickers, out of the same pool
								</div>
							</div>
						</div>

						{(poolSeconds > 0 || (summary?.hoursUsed ?? 0) > 0) && (
							<p className="mt-3 text-xs text-base-content/45">
								{poolSeconds > 0
									? `${formatHours(poolSeconds)} of Public Access time earned this pool.`
									: "No Public Access time earned this pool."}
								{summary && summary.hoursUsed > 0
									? ` All time with creators, gated or purchased included: ${summary.hoursUsed} hrs.`
									: ""}
							</p>
						)}

						{rows.length === 0 ? (
							<div className="py-6 text-center text-sm text-base-content/45">
								<p>No Time Pool activity in {monthLabel(cycle)}.</p>
								<p className="mt-1">
									The pool divides by Public Access time. Video, audio, text, and gameplay all count
									equally.
								</p>
							</div>
						) : (
							<div className="mt-3">
								<div className="flex items-center gap-3 border-b border-base-content/10 px-1 pb-1 text-[10px] uppercase tracking-wider text-base-content/40">
									<div className="w-7" />
									<span className="min-w-0 flex-1">Creator</span>
									<span className="hidden w-24 text-right sm:block">Time</span>
									<span className="w-20 text-right">By Time</span>
									<span className="hidden w-20 text-right sm:block">Directed</span>
									<span className="w-20 text-right">Total</span>
								</div>
								{rows.map((row) => {
									const share =
										poolSeconds > 0 ? Math.round((row.timeSeconds / poolSeconds) * 100) : 0;
									return (
										<div key={row.id} className="flex items-center gap-3 px-1 py-1.5 text-sm">
											<div className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-base-300 text-[10px] font-bold text-white">
												{row.avatar ? (
													<img
														src={row.avatar}
														alt=""
														className="h-7 w-7 rounded-full object-cover"
													/>
												) : (
													initials(row.displayName, row.handle)
												)}
											</div>
											{row.handle ? (
												<Link
													to={profileUrl(row.handle)}
													className="link-hover min-w-0 flex-1 truncate text-base-content/70"
												>
													{row.displayName || row.handle}
												</Link>
											) : (
												<span className="min-w-0 flex-1 truncate text-base-content/70">
													{row.displayName || "A former creator"}
												</span>
											)}
											<span className="hidden w-24 text-right text-xs tabular-nums text-base-content/40 sm:block">
												{row.timeSeconds > 0 ? (
													<>
														{formatHours(row.timeSeconds)}
														{share > 0 ? ` (${share}%)` : ""}
													</>
												) : (
													"—"
												)}
											</span>
											<span className="w-20 text-right tabular-nums text-success">
												{fmt(row.byTime)}
											</span>
											<span className="hidden w-20 text-right tabular-nums text-base-content/60 sm:block">
												{row.directed > 0 ? fmt(row.directed) : "—"}
											</span>
											<span className="w-20 text-right font-medium tabular-nums">
												{fmt(row.total)}
											</span>
										</div>
									);
								})}
								<div className="mt-2 flex items-center gap-3 border-t border-base-content/10 px-1 pt-2 text-sm">
									<div className="w-7" />
									<span className="flex-1 font-medium text-base-content/60">Totals</span>
									<span className="hidden w-24 text-right text-xs tabular-nums text-base-content/40 sm:block">
										{poolSeconds > 0 ? formatHours(poolSeconds) : "—"}
									</span>
									<strong className="w-20 text-right tabular-nums text-success">
										{fmt(totals.poolAmount)}
									</strong>
									<span className="hidden w-20 text-right font-semibold tabular-nums sm:block">
										{fmt(totals.stickerAmount)}
									</span>
									<strong className="w-20 text-right tabular-nums">{fmt(totals.total)}</strong>
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
