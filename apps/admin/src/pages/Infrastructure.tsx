// SPDX-License-Identifier: Apache-2.0
/**
 * Infrastructure: background job and queue health, media processing, and links out to the dashboards
 * where live logs and spend actually live.
 *
 * The links are deliberate rather than a stopgap. DigitalOcean and Cloudflare already show logs,
 * metrics and billing, and an in-app copy of them would be a second picture of the same thing that
 * could only drift. Monitoring built here later is for what those dashboards cannot show.
 */
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
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
															<td className="max-w-md truncate text-xs" title={f.error}>
																{f.error || "—"}
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
													<td className="max-w-xs truncate text-xs" title={p.error}>
														{p.error || "—"}
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
