// SPDX-License-Identifier: Apache-2.0
/**
 * Infrastructure: background job and queue health, media processing, the resource view, and
 * links out to the dashboards where live logs and spend actually live.
 *
 * The links are deliberate rather than a stopgap. DigitalOcean and Cloudflare already show logs,
 * metrics and billing, and an in-app copy of them would be a second picture of the same thing that
 * could only drift. Monitoring built here later is for what those dashboards cannot show.
 *
 * The Resources section below is exactly that kind of monitoring, which is why it renders beside
 * the links rather than replacing them: what DO's own graphs cannot show is (a) whether a reading
 * crosses THIS deployment's thresholds — the "soon vs now" answer — and (b) the trend across
 * snapshots, which is the operator's actual upgrade signal. Raw current metrics stay in DO's
 * dashboards; this section is the judgment layer over them.
 */

import {
	bandFor,
	type ResourceComponent,
	type ResourceSignal,
} from "@anthers/shared/resource-thresholds";
import {
	ArrowTopRightOnSquareIcon,
	ChevronDownIcon,
	ChevronUpIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../components/ui";
import { useAdminData } from "../lib/load";

interface QueueRow {
	name: string;
	created: number;
	retry: number;
	active: number;
	completed: number;
	cancelled: number; // lint-spelling: ignore — keys come from pg-boss's own state values
	failed: number;
}

interface Jobs {
	pgboss: {
		available: boolean;
		queues: QueueRow[];
		failures: { queue: string; state: string; createdOn: string; error: string }[];
	};
	transcodes: {
		counts: Record<string, number>;
		problems: {
			id: number;
			mediaType: string;
			status: string;
			stuck: boolean;
			error: string;
			updatedAt: string;
		}[];
	};
}

interface Band {
	signal: ResourceSignal;
	unit: string;
	soonAt: number;
	nowAt: number;
	remedy: "bigger" | "more" | "off";
	precondition: string | null;
}

interface ComponentView {
	component: ResourceComponent;
	kind: string;
	note: string;
	bands: Band[];
	instanceSize: string | null;
	instanceCount: number | null;
	snapshottedAt: string | null;
	latest: {
		cpuPct: number | null;
		memoryPct: number | null;
		restartCount: number | null;
		notes: string;
	} | null;
	trend: Array<{
		takenAt: string;
		cpuPct: number | null;
		memoryPct: number | null;
		restartCount: number | null;
	}>;
}

interface Resources {
	hasSnapshots: boolean;
	howToSnapshot: string;
	components: ComponentView[];
	spendNote: string;
}

/** The label each signal reads as on a card, title-case per the interface conventions. */
const SIGNAL_LABELS: Record<ResourceSignal, string> = {
	cpu: "CPU",
	memory: "Memory",
	restarts: "Restarts",
	duration: "Run Duration",
};

/** Which metric column a signal's latest reading comes from. */
const SIGNAL_VALUE: Record<ResourceSignal, (l: ComponentView["latest"]) => number | null> = {
	cpu: (l) => l?.cpuPct ?? null,
	memory: (l) => l?.memoryPct ?? null,
	restarts: (l) => l?.restartCount ?? null,
	duration: () => null, // a batch job's duration is not in the snapshot's metric columns
};

/** The remedy as a sentence, so a rendered cue names the lever rather than a code. */
const REMEDY_SENTENCE: Record<Band["remedy"], string> = {
	bigger: "The remedy is a bigger instance.",
	more: "The remedy is more instances.",
	off: "The remedy is moving this work off the instance.",
};

/** A small sparkline of the last few trend points, as inline SVG — no chart library for this. */
function Sparkline({ points }: { points: number[] }) {
	if (points.length < 2) return null;
	const min = Math.min(...points);
	const max = Math.max(...points);
	const span = max - min || 1;
	const width = 120;
	const height = 28;
	const step = width / (points.length - 1);
	const path = points
		.map(
			(p, i) =>
				`${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - ((p - min) / span) * (height - 4) - 2).toFixed(1)}`,
		)
		.join(" ");
	return (
		<svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-28 text-primary" aria-hidden="true">
			<path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	);
}

/** One component's card: shape, each signal against its bands, the trend, and the remedies. */
function ComponentCard({ entry }: { entry: ComponentView }) {
	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="flex items-baseline justify-between">
				<span className="font-mono text-sm font-semibold">{entry.component}</span>
				<span className="text-xs text-base-content/60">
					{entry.kind === "static"
						? "Static Site"
						: `${entry.instanceSize ?? "unknown size"} · ${entry.instanceCount ?? "—"} instance(s)`}
				</span>
			</div>

			{!entry.snapshottedAt ? (
				<p className="mt-2 text-sm text-base-content/60">
					No snapshot yet — run <code className="font-mono text-xs">make resource-snapshot</code>.
				</p>
			) : (
				<table className="table table-sm mt-2">
					<thead>
						<tr>
							<th>Signal</th>
							<th className="text-right">Latest</th>
							<th className="text-right">Soon At</th>
							<th className="text-right">Now At</th>
							<th>Reading</th>
						</tr>
					</thead>
					<tbody>
						{entry.bands.map((band) => {
							const value = SIGNAL_VALUE[band.signal](entry.latest);
							const bandState =
								value === null ? null : bandFor(entry.component, band.signal, value);
							return (
								<tr key={band.signal}>
									<td>{SIGNAL_LABELS[band.signal]}</td>
									<td className="text-right tabular-nums">
										{value === null ? "—" : `${value.toFixed ? value.toFixed(1) : value}`}
									</td>
									<td className="text-right tabular-nums text-base-content/60">{band.soonAt}</td>
									<td className="text-right tabular-nums text-base-content/60">{band.nowAt}</td>
									<td>
										{value === null ? (
											<span className="badge badge-ghost badge-sm">No Reading</span>
										) : bandState === "now" ? (
											<span className="badge badge-error badge-sm">Upgrade Now</span>
										) : bandState === "soon" ? (
											<span className="badge badge-warning badge-sm">Upgrade Soon</span>
										) : (
											<span className="badge badge-success badge-sm">Within Bands</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}

			{/* The trend: one sparkline per metric the component carries, newest on the right. */}
			{entry.trend.length >= 2 && (
				<div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-base-content/60">
					{(["cpuPct", "memoryPct", "restartCount"] as const)
						.filter((key) =>
							entry.bands.some(
								(b) =>
									SIGNAL_VALUE[b.signal](entry.latest) !== undefined &&
									key ===
										(b.signal === "cpu"
											? "cpuPct"
											: b.signal === "memory"
												? "memoryPct"
												: "restartCount"),
							),
						)
						.map((key) => {
							const points = entry.trend.map((t) => t[key]).filter((v): v is number => v !== null);
							if (points.length < 2) return null;
							const label = key === "cpuPct" ? "CPU" : key === "memoryPct" ? "Memory" : "Restarts";
							return (
								<div key={key} className="flex items-center gap-1">
									<span>{label}</span>
									<Sparkline points={points} />
								</div>
							);
						})}
				</div>
			)}

			{/* Every live cue renders its remedy beside it, and the remedy's precondition with it. */}
			{entry.bands.map((band) => {
				const value = SIGNAL_VALUE[band.signal](entry.latest);
				const bandState = value === null ? null : bandFor(entry.component, band.signal, value);
				if (bandState === null) return null;
				return (
					<div key={`${band.signal}-cue`} className="mt-2 rounded bg-base-200/50 p-2 text-xs">
						<strong>{bandState === "now" ? "Upgrade now" : "Upgrade soon"}:</strong>{" "}
						{SIGNAL_LABELS[band.signal]} {bandState === "now" ? "crossed" : "is near"} its{" "}
						{bandState} band. {REMEDY_SENTENCE[band.remedy]}
						{band.precondition && (
							<>
								{" "}
								<span className="text-warning">{band.precondition}</span>
							</>
						)}
					</div>
				);
			})}

			<p className="mt-2 text-xs text-base-content/50">{entry.note}</p>
		</div>
	);
}

function ResourcesSection() {
	const { data, loading, error } = useAdminData<Resources>("/api/admin/infrastructure/resources");

	return (
		<section>
			<SectionHeading>Resources</SectionHeading>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : data ? (
				data.hasSnapshots ? (
					<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
						{data.components.map((entry) => (
							<ComponentCard key={entry.component} entry={entry} />
						))}
					</div>
				) : (
					<div className="alert">
						<span>
							No snapshot yet — run <code className="font-mono text-xs">{data.howToSnapshot}</code>{" "}
							on the operator machine to record one.
						</span>
					</div>
				)
			) : null}
			<p className="mt-3 text-sm text-base-content/60">
				Snapshots come from the operator's own{" "}
				<code className="font-mono text-xs">make resource-snapshot</code> run — the app cannot read
				DigitalOcean's metrics for itself. {data?.spendNote}
			</p>
		</section>
	);
}

// ⚠️ Two vendors, which is why these are not all DigitalOcean links: DigitalOcean runs the app and
// the Postgres, and media storage is Cloudflare R2.
const OPERATOR_LINKS = [
	{
		label: "Apps Dashboard",
		href: "https://cloud.digitalocean.com/apps",
		hint: "Deployments, runtime logs, insights",
	},
	{
		label: "Billing and Usage",
		href: "https://cloud.digitalocean.com/account/billing",
		hint: "Current spend, invoices, history",
	},
	{
		label: "Managed Database",
		href: "https://cloud.digitalocean.com/databases",
		hint: "Postgres metrics, connections, backups",
	},
	{
		label: "R2 Media Storage",
		href: "https://dash.cloudflare.com/?to=/:account/r2/overview",
		hint: "anthers-media-public and anthers-media-private, CORS, lifecycle",
	},
];

/**
 * An error cell that starts as one clipped line and expands to the full, selectable text on click.
 * Long failure messages are the whole story of a failure row; the tooltip could show them but not
 * let an operator copy them, so the toggle is the cell itself rather than a separate control.
 */
function ExpansibleError({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
	if (!text) return <>—</>;

	return expanded ? (
		<button
			type="button"
			className="block max-w-md whitespace-pre-wrap break-words text-left font-mono text-xs text-error"
			onClick={() => setExpanded(false)}
			aria-expanded
		>
			{text}
			<ChevronUpIcon className="ml-1 inline h-3 w-3 align-[-1px] text-base-content/40" />
		</button>
	) : (
		<button
			type="button"
			className="block max-w-md truncate font-mono text-xs hover:text-primary"
			onClick={() => setExpanded(true)}
			title={text}
			aria-expanded={false}
		>
			{text}
			<ChevronDownIcon className="ml-1 inline h-3 w-3 align-[-1px] text-base-content/40" />
		</button>
	);
}

export default function Infrastructure() {
	const { data: jobs, loading, error, reload } = useAdminData<Jobs>("/api/admin/jobs");

	return (
		<div>
			<PageHeader
				title="Jobs and Services"
				description="Background jobs, media processing, and the dashboards for logs and spend."
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !jobs ? (
				<Loading />
			) : (
				jobs && (
					<div className="space-y-10">
						<section>
							<SectionHeading>Job Queues</SectionHeading>
							{!jobs.pgboss.available ? (
								<div className="alert">
									<span>
										The job queue has no schema yet, because the worker has not run against this
										database.
									</span>
								</div>
							) : (
								<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
									<table className="table table-sm">
										<thead>
											<tr>
												<th>Queue</th>
												<th className="text-right">Active</th>
												<th className="text-right">Waiting</th>
												<th className="text-right">Retry</th>
												<th className="text-right">Failed</th>
											</tr>
										</thead>
										<tbody>
											{jobs.pgboss.queues.map((q) => (
												<tr key={q.name}>
													<td className="font-mono text-xs">{q.name}</td>
													<td className="text-right tabular-nums">{q.active || "—"}</td>
													<td className="text-right tabular-nums">{q.created || "—"}</td>
													<td className="text-right tabular-nums">
														{q.retry ? <span className="text-warning">{q.retry}</span> : "—"}
													</td>
													<td className="text-right tabular-nums">
														{q.failed ? (
															<span className="font-semibold text-error">{q.failed}</span>
														) : (
															"—"
														)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}

							{jobs.pgboss.available && (
								<div className="mt-4">
									<div className="mb-2 text-xs uppercase tracking-wide text-base-content/50">
										Recent Failures
									</div>
									{jobs.pgboss.failures.length === 0 ? (
										<p className="text-sm text-success">No job has failed recently.</p>
									) : (
										<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
											<table className="table table-sm">
												<thead>
													<tr>
														<th>Queue</th>
														<th>State</th>
														<th>When</th>
														<th>Error</th>
													</tr>
												</thead>
												<tbody>
													{jobs.pgboss.failures.map((f) => (
														<tr key={`${f.queue}-${f.createdOn}`}>
															<td className="font-mono text-xs">{f.queue}</td>
															<td>
																<span className="badge badge-sm badge-error badge-outline">
																	{f.state}
																</span>
															</td>
															<td className="whitespace-nowrap text-xs">
																{new Date(f.createdOn).toLocaleString()}
															</td>
															<td className="text-xs">
																<ExpansibleError text={f.error} />
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									)}
								</div>
							)}
						</section>

						<section>
							<SectionHeading>Media Processing</SectionHeading>
							{Object.keys(jobs.transcodes.counts).length === 0 ? (
								<p className="text-sm text-base-content/60">No media job has been recorded yet.</p>
							) : (
								<div className="flex flex-wrap gap-2">
									{Object.entries(jobs.transcodes.counts).map(([status, n]) => (
										<span
											key={status}
											className={`badge ${status === "failed" ? "badge-error" : status === "completed" ? "badge-success" : "badge-ghost"}`}
										>
											{status}: {n}
										</span>
									))}
								</div>
							)}
							{jobs.transcodes.problems.length > 0 && (
								<div className="mt-3 overflow-x-auto rounded-box border border-base-300 bg-base-100">
									<table className="table table-sm">
										<thead>
											<tr>
												<th>Job</th>
												<th>Type</th>
												<th>Status</th>
												<th>Error</th>
												<th>Updated</th>
											</tr>
										</thead>
										<tbody>
											{jobs.transcodes.problems.map((p) => (
												<tr key={p.id}>
													<td className="tabular-nums">#{p.id}</td>
													<td>{p.mediaType}</td>
													<td>
														<span
															className={`badge badge-sm ${p.stuck ? "badge-warning" : "badge-error"}`}
														>
															{p.stuck ? "stuck" : p.status}
														</span>
													</td>
													<td className="text-xs">
														<ExpansibleError text={p.error} />
													</td>
													<td className="whitespace-nowrap text-xs">
														{new Date(p.updatedAt).toLocaleString()}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</section>
					</div>
				)
			)}

			<section className="mt-10">
				<SectionHeading>Resources</SectionHeading>
				<ResourcesSection />
			</section>

			<section className="mt-10">
				<SectionHeading>Dashboards</SectionHeading>
				<p className="mb-3 text-sm text-base-content/60">
					Live logs and billing are in DigitalOcean, and media storage is in Cloudflare R2.
				</p>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{OPERATOR_LINKS.map((l) => (
						<a
							key={l.href}
							href={l.href}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-start justify-between gap-3 rounded-box border border-base-300 bg-base-100 p-4 transition-colors hover:border-primary/50"
						>
							<div>
								<div className="font-medium">{l.label}</div>
								<div className="mt-0.5 text-xs text-base-content/60">{l.hint}</div>
							</div>
							<ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0 text-base-content/40" />
						</a>
					))}
				</div>
			</section>
		</div>
	);
}
