// SPDX-License-Identifier: Apache-2.0
/**
 * The Time tab's second card — the person's own activity record and its picture.
 *
 * This is the answer the Privacy Policy points at: the record of what was watched is not a
 * hidden analytics byproduct, it is the user's own file, and they can read every row of it
 * here. Nothing about the rows is computed for display; what is stored is what is shown,
 * evidence included.
 *
 * ⭐ **The card follows the month selected in the Time Pool card above it** (Parker,
 * 2026-11-12). It used to carry its own two-button span on the Activity & Data tab; the
 * month now arrives as a prop, so the pool and the record always describe the same period.
 * The picture and the record below it are still different things: the picture is computed
 * for display from the credited time, and the record is the stored ranges themselves.
 */

import { cycleStart, daysInCycle } from "@anthers/shared/billing-cycle";
import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from "recharts";

interface ActivityEntry {
	id: number;
	creatorId: number;
	workId: number | null;
	eventType: string;
	durationSeconds: number;
	startedAt: string | null;
	endedAt: string | null;
	tabVisible: boolean | null;
	elementVisible: boolean | null;
	playing: boolean | null;
	surface: string | null;
	device: string | null;
	workTitle: string | null;
	url: string | null;
}

/**
 * Activity history — a person's own attention ranges, exactly as recorded.
 *
 * This is the answer the Privacy Policy points at: the record of what was watched is
 * not a hidden analytics byproduct, it is the user's own file, and they can read
 * every row of it here. Nothing about the rows is computed for display — what is
 * stored is what is shown, evidence included, which is what makes the record inspectable
 * rather than a summary somebody chose to write.
 *
 * Above that record sits a picture, and the difference between the two is the section's
 * whole design (Parker, 2026-10-13, after the treatments in the Anthers vault's
 * `Internal Wiki/Transient/Activity Graph Mocks 20261013.html`, recorded in the task note
 * that carried the work):
 * a stacked bar per UTC day of a **billing cycle** — defaulting to the current one, the same
 * key `settle-cycle` settles on — with each day's stored ranges added up **per creator, in
 * full**. The picture is computed for display and says so; the drill-down it opens is not
 * computed at all. Two rules keep the picture honest:
 *
 * - **A range counts toward the creator it touched, whole.** Where two ranges overlapped,
 *   the even split between them is a payment calculation, not what happened — a video and
 *   an article at once both happened fully — so the split appears nowhere in the history,
 *   and a day's bars may sum to more than elapsed wall-clock time. The rows the bar opens
 *   are the evidence, whole.
 * - **The UTC day is the bucket, because the cycle is.** The month every account renews on
 *   is keyed in UTC (`@anthers/shared/billing-cycle`), so the picture buckets the same way;
 *   a range belongs to the day it started.
 *
 * The entries are ranges, and each one says so: when it started, when it ended,
 * whether the Work was playing, and which device it came from. Where two ranges
 * overlap (a video in one tab and an article in another), both are listed whole —
 * the even split between them is a payment calculation, not what happened, and a
 * history that showed only the split would be narrating the ledger rather than
 * the activity.
 */
/** The computed picture's shape, from `/attention/history/summary`. */
interface ActivitySummaryDay {
	day: string;
	seconds: number;
	ranges: number;
	creators: { creatorId: number; name: string; seconds: number; ranges: number }[];
}
interface ActivitySummary {
	cycle: string;
	days: ActivitySummaryDay[];
	totals: { seconds: number; creators: number };
}

/** One hue per creator, cycled by the creator's rank in the period; the palette sits inside the light and dark variants. */
const CREATOR_COLORS = [
	"var(--color-primary)",
	"var(--color-accent)",
	"oklch(76% 0.11 300)",
	"oklch(70% 0.09 235)",
	"var(--color-secondary)",
	"oklch(78% 0.09 130)",
	"oklch(80% 0.08 30)",
	"oklch(56% 0.05 260)",
];

/** When a stored range started, in the short form the record's rows use. */
function formatWhen(value: string | null): string {
	if (!value) return "never";
	const then = new Date(value).getTime();
	const mins = Math.round((Date.now() - then) / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
	return new Date(value).toLocaleDateString();
}

/** Seconds to the short form the section's copy uses — whole ranges added, never the split. */
function fmtMinutes(seconds: number): string {
	const m = Math.round(seconds / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 === 0 ? `${h} hr` : `${h} hr ${m % 60} min`;
}

/** How many bars get their own hue before the remainder folds into one "Other creators" slice. */
const MAX_CREATOR_BARS = 8;

export default function ActivityDetailsSection({ cycle }: { cycle: string }) {
	const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [page, setPage] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(false);
	// The picture's span is the month chosen in the Time Pool card above, and the day the
	// record below is narrowed to opens from one of its bars. With no day open the record
	// is every range in that cycle.
	const [summary, setSummary] = useState<ActivitySummary | null>(null);
	const [summaryError, setSummaryError] = useState<boolean>(false);
	const [openDay, setOpenDay] = useState<string | null>(null);

	const load = useCallback(
		(p: number, day: string | null) => {
			setLoading(true);
			setError(null);
			// A month is a different record, so its first page replaces what the previous
			// month left on screen rather than sitting under it while the fetch resolves.
			if (p === 0) setEntries(null);
			apiFetch(
				`/api/subscriptions/attention/history?page=${p}&cycle=${encodeURIComponent(cycle)}${
					day ? `&day=${day}` : ""
				}`,
			)
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load your activity."))))
				.then((d) => {
					const body = d as { entries: ActivityEntry[]; hasMore: boolean };
					setEntries((prev) => (p === 0 ? body.entries : [...(prev ?? []), ...body.entries]));
					setHasMore(body.hasMore);
					setPage(p);
				})
				.catch((e) => setError(e instanceof Error ? e.message : "Could not load your activity."))
				.finally(() => setLoading(false));
		},
		[cycle],
	);

	// A month change re-points both the picture and the record, and releases a day opened
	// in the previous month.
	useEffect(() => {
		setOpenDay(null);
		load(0, null);
	}, [load]);

	// The summary rides its own endpoint, is computed fresh per cycle, and failing it
	// costs only the picture: the record below is the section, not the graph.
	useEffect(() => {
		setSummary(null);
		setSummaryError(false);
		let alive = true;
		apiFetch(`/api/subscriptions/attention/history/summary?cycle=${encodeURIComponent(cycle)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad summary"))))
			.then((d) => {
				if (alive) setSummary(d as ActivitySummary);
			})
			.catch(() => {
				if (alive) setSummaryError(true);
			});
		return () => {
			alive = false;
		};
	}, [cycle]);

	const verbFor = (eventType: string) =>
		eventType === "watch"
			? "Watched"
			: eventType === "listen"
				? "Listened to"
				: eventType === "read"
					? "Read"
					: eventType === "play"
						? "Played"
						: "Visited";

	const describeEvidence = (e: ActivityEntry): string => {
		const bits: string[] = [];
		if (e.device) bits.push(e.device === "desktop-shell" ? "desktop app" : e.device);
		if (e.playing === false) bits.push("paused");
		if (e.tabVisible === false) bits.push("in the background");
		return bits.length > 0 ? ` (${bits.join(", ")})` : "";
	};

	// The bars: every day of the cycle in order, gaps included, each day's ranges
	// stacked by creator. The top creators by period total get their own hue and the
	// remainder folds into one slice — a legend never needs a screen of its own.
	const chart = useMemo(() => {
		if (!summary) return null;
		const perCreator = new Map<number, { name: string; seconds: number }>();
		for (const d of summary.days) {
			for (const cr of d.creators) {
				const cur = perCreator.get(cr.creatorId);
				if (cur) cur.seconds += cr.seconds;
				else perCreator.set(cr.creatorId, { name: cr.name, seconds: cr.seconds });
			}
		}
		const ranked = [...perCreator.entries()]
			.sort((a, b) => b[1].seconds - a[1].seconds)
			.slice(0, MAX_CREATOR_BARS);
		const otherSeconds = summary.totals.seconds - ranked.reduce((s, [, cr]) => s + cr.seconds, 0);
		const bars = ranked.map(([id, cr], i) => ({
			key: `c${id}`,
			name: cr.name,
			color: CREATOR_COLORS[i % CREATOR_COLORS.length],
		}));
		if (otherSeconds > 0)
			bars.push({
				key: "kother",
				name: "Other creators",
				color: "color-mix(in oklch, var(--color-base-content) 40%, transparent)",
			});

		const start = cycleStart(cycle);
		const data = [];
		for (let i = 0; i < daysInCycle(cycle); i++) {
			const key = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
			const day = summary.days.find((d) => d.day === key);
			// Flat: a bar's dataKey reads `datum[bar.key]` (recharts reads top-level
			// keys only); each bar's range count rides beside it in `q`.
			const q: Record<string, number> = {};
			const datum: {
				dayNum: number;
				day: string;
				seconds: number;
				ranges: number;
				q: Record<string, number>;
				[key: string]: unknown;
			} = {
				dayNum: i + 1,
				day: key,
				seconds: day?.seconds ?? 0,
				ranges: day?.ranges ?? 0,
				q,
			};
			for (const cr of day?.creators ?? []) {
				const bar = bars.find((b) => b.key === `c${cr.creatorId}`);
				const target = bar ? bar.key : "kother";
				datum[target] = ((datum[target] as number | undefined) ?? 0) + cr.seconds;
				q[target] = (q[target] ?? 0) + cr.ranges;
			}
			data.push(datum);
		}
		const byDayNum = new Map(data.map((d) => [d.dayNum, d]));
		return { data, bars, byDayNum };
	}, [cycle, summary]);

	const openChartDay = (label: unknown) => {
		// The axis label arrives as the tick's value — number or its string form.
		const dayNum =
			typeof label === "number" ? label : typeof label === "string" ? Number(label) : NaN;
		if (!Number.isInteger(dayNum)) return;
		const datum = chart?.byDayNum.get(dayNum);
		if (!datum || datum.ranges === 0) return;
		const day = datum.day;
		const next = openDay === day ? null : day;
		setOpenDay(next);
		load(0, next);
	};

	const chartTooltip = useMemo(
		() =>
			function ChartTip({ active, label }: TooltipContentProps) {
				if (!active || !chart || typeof label !== "number") return null;
				const datum = chart.byDayNum.get(label);
				if (!datum) return null;
				return (
					<div className="rounded-lg border border-base-content/30 bg-base-300 px-3 py-2 text-xs shadow-lg">
						<p className="font-semibold">
							{datum.ranges === 0
								? "Nothing recorded"
								: `${fmtMinutes(datum.seconds)} across ${datum.ranges} range${datum.ranges === 1 ? "" : "s"}`}
						</p>
						<ul className="mt-1 space-y-0.5">
							{chart.bars
								.filter((b) => ((datum[b.key] as number | undefined) ?? 0) > 0)
								.map((b) => (
									<li key={b.key}>
										<span
											aria-hidden="true"
											style={{
												display: "inline-block",
												width: 8,
												height: 8,
												borderRadius: 2,
												background: b.color,
												marginRight: 4,
											}}
										/>
										{b.name} · {fmtMinutes(datum[b.key] as number)} · {datum.q[b.key]} range
										{datum.q[b.key] === 1 ? "" : "s"}
									</li>
								))}
						</ul>
						{datum.ranges > 0 && (
							<p className="mt-1 text-base-content/50">click to open this day’s record</p>
						)}
					</div>
				);
			},
		[chart],
	);

	const cycleLabel = (() => {
		const m = Number(cycle.slice(5, 7));
		const months = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];
		return `${months[m - 1]} ${cycle.slice(0, 4)}`;
	})();
	const openDayLabel = openDay
		? (() => {
				const months = [
					"January",
					"February",
					"March",
					"April",
					"May",
					"June",
					"July",
					"August",
					"September",
					"October",
					"November",
					"December",
				];
				return `${months[Number(openDay.slice(5, 7)) - 1]} ${Number(openDay.slice(8, 10))}`;
			})()
		: null;

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Activity Details</h3>
				<p className="text-sm text-base-content/60">
					Every stretch of time Anthers holds about what you watched, read, heard or played in the
					month selected above, exactly as it is stored, and the same record your export contains.
					The picture is computed for display from the credited time, split evenly where stretches
					overlapped, added per day and per creator. The record below is the storage itself: open
					any bar to read the ranges its bar stands on.
				</p>

				{summaryError && (
					<p className="text-sm text-base-content/50">
						The month's picture could not load; the record below is unaffected.
					</p>
				)}
				{!summaryError && chart && summary && summary.days.length > 0 && (
					<div
						className="mt-2"
						role="img"
						aria-label={`${cycleLabel}: time per day per creator, computed from your stored activity record`}
					>
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<p className="text-sm font-semibold">
								{cycleLabel} · {fmtMinutes(summary.totals.seconds)}
							</p>
							<p className="text-xs text-base-content/50">
								computed for display: minutes per UTC day of the billing cycle, from the record
								below
							</p>
						</div>
						<div className="mt-3">
							<ResponsiveContainer width="100%" height={190}>
								<BarChart
									data={chart.data}
									margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
									onClick={(state) => openChartDay(state.activeLabel)}
								>
									<CartesianGrid
										stroke="color-mix(in oklch, var(--color-base-content) 12%, transparent)"
										vertical={false}
									/>
									<XAxis
										dataKey="dayNum"
										tickLine={false}
										axisLine={{
											stroke: "color-mix(in oklch, var(--color-base-content) 20%, transparent)",
										}}
										tick={{
											fontSize: 10,
											fill: "color-mix(in oklch, var(--color-base-content) 55%, transparent)",
										}}
										tickFormatter={(n: number) => (n === 1 || n % 5 === 0 ? String(n) : "")}
										allowDecimals={false}
									/>
									<YAxis
										width={30}
										tickLine={false}
										axisLine={false}
										tick={{
											fontSize: 10,
											fill: "color-mix(in oklch, var(--color-base-content) 55%, transparent)",
										}}
										tickFormatter={(s: number) => String(Math.round(s / 60))}
									/>
									<Tooltip
										content={chartTooltip}
										cursor={{
											fill: "color-mix(in oklch, var(--color-base-content) 7%, transparent)",
										}}
									/>
									{chart.bars.map((b) => (
										<Bar
											key={b.key}
											dataKey={b.key}
											name={b.name}
											stackId="a"
											fill={b.color}
											maxBarSize={22}
											radius={0}
											isAnimationActive={false}
										/>
									))}
								</BarChart>
							</ResponsiveContainer>
							<p className="mt-1 text-xs text-base-content/60">
								{chart.bars.map((b) => (
									<span key={b.key} style={{ marginRight: 14 }}>
										<span
											aria-hidden="true"
											style={{
												display: "inline-block",
												width: 9,
												height: 9,
												borderRadius: 3,
												background: b.color,
												marginRight: 5,
											}}
										/>
										{b.name}
									</span>
								))}
							</p>
						</div>
					</div>
				)}
				{!summaryError && summary && summary.days.length === 0 && (
					<p className="text-sm text-base-content/50">Nothing recorded yet in {cycleLabel}.</p>
				)}

				{error && (
					<div className="alert alert-error mt-2">
						<span>{error}</span>
					</div>
				)}
				{openDay && openDayLabel && (
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<span className="badge badge-primary badge-sm">{openDayLabel} · that day’s record</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => {
								setOpenDay(null);
								load(0, null);
							}}
						>
							Show the full record
						</button>
					</div>
				)}
				{entries == null ? (
					<p className="text-sm text-base-content/50">Loading…</p>
				) : entries.length === 0 ? (
					// The month's empty picture already said the same thing; a second line
					// under it only makes an empty card look broken.
					summary && summary.days.length === 0 && !openDay ? null : (
						<p className="text-sm text-base-content/50">
							{openDay ? "Nothing recorded that day." : "Nothing recorded yet."}
						</p>
					)
				) : (
					<ul className="mt-2 space-y-1.5">
						{entries.map((e) => (
							<li key={e.id} className="text-sm">
								<span className="text-base-content/70">{formatWhen(e.startedAt)}</span>
								{" · "}
								{verbFor(e.eventType)}{" "}
								{e.url ? (
									<Link to={e.url} className="link">
										{e.workTitle ?? "a Work"}
									</Link>
								) : (
									<span>{e.workTitle ?? "a Work"}</span>
								)}{" "}
								for {Math.max(1, Math.round(e.durationSeconds / 60))} min
								<span className="text-base-content/50">{describeEvidence(e)}</span>
							</li>
						))}
					</ul>
				)}
				{hasMore && (
					<button
						type="button"
						className="btn btn-ghost btn-sm w-fit mt-2"
						disabled={loading}
						onClick={() => load(page + 1, openDay)}
					>
						{loading ? "Loading…" : "Show older"}
					</button>
				)}
			</div>
		</div>
	);
}
