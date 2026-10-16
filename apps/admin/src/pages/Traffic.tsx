// SPDX-License-Identifier: Apache-2.0
/**
 * Traffic: where visitors come from and what they open, measured first-party (routes/
 * admin.ts § Traffic; services/traffic.ts is the pipeline's only writer).
 *
 * Two honesty rules the page carries rather than hides. **Sessions are per-day** — the
 * rollup has no identity column, so a person who visited on three days is three
 * sessions, and nothing on this page adds that column across days. **The funnel's
 * stages are counted from different tables** — landing views, signups, first supports
 * are aggregates over the same window, never a join, because traffic rows cannot know
 * who a visitor was. Rates read from it are honest; cohort conversion claimed from it
 * would be a figure nobody measured.
 */

import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../components/ui";
import { useAdminData } from "../lib/load";

interface TrafficDay {
	day: string;
	views: number;
	sessions: number | null;
}

interface TrafficData {
	period: number;
	timeseries: TrafficDay[];
	sources: Array<{ source: string; views: number }>;
	topPaths: Array<{ path: string; views: number }>;
	funnel: { landingViews: number; signups: number; firstSupports: number };
	sessionsSeen: number;
}

const PERIODS = [7, 30, 90, 365] as const;

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

const SOURCE_LABELS: Record<string, string> = {
	direct: "Direct",
	search: "Search",
	social: "Social",
	other: "Other sites",
};

/** One funnel stage → the next, as honest aggregate ratios. */
function FunnelRow({
	label,
	value,
	prev = null,
	prevLabel,
}: {
	label: string;
	value: number;
	prev?: number | null;
	prevLabel?: string;
}) {
	const rate =
		prev != null && prev > 0 ? `${((value / prev) * 100).toFixed(1)}% of ${prevLabel}` : null;
	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="text-xs uppercase tracking-wide text-base-content/50">{label}</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value)}</div>
			{rate && <div className="mt-0.5 text-xs text-base-content/60">{rate}</div>}
		</div>
	);
}

export default function Traffic() {
	const [period, setPeriod] = useState<number>(30);
	const { data, loading, error, reload } = useAdminData<TrafficData>(
		`/api/admin/traffic?period=${period}`,
	);

	if (error) {
		return (
			<div>
				<PageHeader title="Traffic" onRefresh={reload} />
				<ErrorAlert>{error}</ErrorAlert>
			</div>
		);
	}
	if (!data) return <Loading />;

	const maxViews = Math.max(...data.timeseries.map((d) => d.views), 1);
	const { funnel } = data;

	return (
		<div>
			<PageHeader
				title="Traffic"
				description="First-party page-view and card measurement. Rows carry no identity — visits, never visitors."
				onRefresh={reload}
				loading={loading}
			/>

			<div className="mb-4 flex gap-2">
				{PERIODS.map((p) => (
					<button
						key={p}
						type="button"
						className={`btn btn-sm ${period === p ? "btn-primary" : "btn-outline"}`}
						onClick={() => setPeriod(p)}
					>
						{p === 365 ? "1 year" : `${p} days`}
					</button>
				))}
			</div>

			<SectionHeading>Daily page views</SectionHeading>
			<div className="rounded-box border border-base-300 bg-base-100 p-4 mb-6">
				{data.timeseries.length === 0 ? (
					<p className="text-sm text-base-content/60">No traffic recorded in this window yet.</p>
				) : (
					<>
						<div className="flex items-end gap-px h-32">
							{data.timeseries.map((d) => (
								<div
									key={d.day}
									title={`${d.day}: ${d.views} views${d.sessions != null ? `, ${d.sessions} sessions` : ""}`}
									className="flex-1 rounded-t-sm bg-primary opacity-80 min-h-[2px]"
									style={{ height: `${(d.views / maxViews) * 100}%` }}
								/>
							))}
						</div>
						<div className="flex justify-between text-xs text-base-content/40 mt-1">
							<span>{data.timeseries[0]!.day}</span>
							<span>{data.timeseries[data.timeseries.length - 1]!.day}</span>
						</div>
					</>
				)}
			</div>

			<SectionHeading>Acquisition funnel</SectionHeading>
			<p className="text-xs text-base-content/60 mb-2">
				Stages are aggregates over the same window, counted from different tables — traffic rows
				carry no identity, so stages are never joined into cohorts.
			</p>
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
				<FunnelRow label="Landing page views" value={funnel.landingViews} />
				<FunnelRow
					label="Signups"
					value={funnel.signups}
					prev={funnel.landingViews}
					prevLabel="landing views"
				/>
				<FunnelRow
					label="First-time supporters"
					value={funnel.firstSupports}
					prev={funnel.signups}
					prevLabel="signups"
				/>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				<div>
					<SectionHeading>Sources</SectionHeading>
					<table className="table table-sm bg-base-100 rounded-box">
						<thead>
							<tr>
								<th>Source</th>
								<th className="text-right">Views</th>
							</tr>
						</thead>
						<tbody>
							{data.sources.length === 0 ? (
								<tr>
									<td colSpan={2} className="text-sm text-base-content/60">
										No traffic recorded yet.
									</td>
								</tr>
							) : (
								data.sources.map((s) => (
									<tr key={s.source}>
										<td>{SOURCE_LABELS[s.source] ?? s.source}</td>
										<td className="text-right tabular-nums">{formatNumber(s.views)}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
					<p className="text-xs text-base-content/40 mt-1">
						Distinct sessions seen in the raw window (a liveness figure, not a total):{" "}
						{formatNumber(data.sessionsSeen)}
					</p>
				</div>
				<div>
					<SectionHeading>Top pages</SectionHeading>
					<table className="table table-sm bg-base-100 rounded-box">
						<thead>
							<tr>
								<th>Path</th>
								<th className="text-right">Views</th>
							</tr>
						</thead>
						<tbody>
							{data.topPaths.length === 0 ? (
								<tr>
									<td colSpan={2} className="text-sm text-base-content/60">
										No traffic recorded yet.
									</td>
								</tr>
							) : (
								data.topPaths.map((p) => (
									<tr key={p.path}>
										<td className="font-mono text-xs break-all">{p.path}</td>
										<td className="text-right tabular-nums">{formatNumber(p.views)}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>

			<div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
				<StatCard title="Raw retention" value="30 days" sub="Then aggregated, raw rows deleted" />
				<StatCard title="Identity" value="None" sub="Session id only, dying with the tab" />
				<StatCard title="Impressions" value="Own tables" sub="Never on attention_events" />
			</div>
		</div>
	);
}
