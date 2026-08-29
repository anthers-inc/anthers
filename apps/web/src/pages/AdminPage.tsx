// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin / operations console — the MVP ops dashboard.
 *
 * Two halves. **Moderation** is the operator's work queue — report → hide →
 * recorded removal — and the console's first mutating surface. **Telemetry** is
 * the original read-only view: platform activity (from our Postgres), background
 * job / queue health (pg-boss + media transcodes), and deep-links out to
 * DigitalOcean for live logs + spend (a thin console over DO's own monitoring
 * rather than a re-implementation). Gated by AdminRoute + the API's requireAdmin.
 *
 * Moderation renders outside the telemetry loading gate and fetches on its own —
 * the thing an operator came here to act on shouldn't wait on a queue-health
 * query. Job retry/cancel and alerting are still follow-ons.
 */

import { client } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import LegalHolds from "../components/admin/LegalHolds";
import ModerationQueue from "../components/admin/ModerationQueue";
import RatingAppealsQueue from "../components/admin/RatingAppealsQueue";

// ── Response shapes (mirror apps/api/src/routes/admin.ts) ────────────────────
interface Activity {
	users: { total: number; creators: number; admins: number; new24h: number; new7d: number };
	posts: { total: number; published: number; new24h: number; new7d: number };
	comments: { new24h: number; new7d: number };
	uploads: { total: number };
	series: { date: string; signups: number; posts: number }[];
}

interface QueueRow {
	name: string;
	created: number;
	retry: number;
	active: number;
	completed: number;
	cancelled: number;
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

// Operator dashboard deep-links — live logs + spend live here, not in-app.
//
// ⚠️ Two vendors since 2026-08-11, which is why this is no longer "the DigitalOcean
// links". DigitalOcean runs the app and the Postgres; media storage is Cloudflare R2.
// The R2 entry used to point at `cloud.digitalocean.com/spaces` and landed an operator
// on an empty DigitalOcean product — a link nobody had reason to doubt, because the
// other three still worked.
const OPERATOR_LINKS = [
	{
		label: "Apps dashboard",
		href: "https://cloud.digitalocean.com/apps",
		hint: "Deployments, runtime logs, insights",
	},
	{
		label: "Billing & usage",
		href: "https://cloud.digitalocean.com/account/billing",
		hint: "Current spend, invoices, history",
	},
	{
		label: "Managed database",
		href: "https://cloud.digitalocean.com/databases",
		hint: "Postgres metrics, connections, backups",
	},
	{
		label: "R2 (media storage)",
		href: "https://dash.cloudflare.com/?to=/:account/r2/overview",
		hint: "anthers-media-public + anthers-media-private, CORS, lifecycle",
	},
];

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="text-xs uppercase tracking-wide text-base-content/50">{title}</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
			{sub && <div className="mt-0.5 text-xs text-base-content/60">{sub}</div>}
		</div>
	);
}

function SectionHeading({ children }: { children: React.ReactNode }) {
	return <h2 className="text-lg font-semibold mb-3">{children}</h2>;
}

export default function AdminPage() {
	const [activity, setActivity] = useState<Activity | null>(null);
	const [jobs, setJobs] = useState<Jobs | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [updatedAt, setUpdatedAt] = useState<string>("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [aRes, jRes] = await Promise.all([
				client.api.admin.activity.$get(),
				client.api.admin.jobs.$get(),
			]);
			if (!aRes.ok || !jRes.ok) {
				setError("Failed to load ops data.");
				return;
			}
			setActivity((await aRes.json()) as Activity);
			setJobs((await jRes.json()) as Jobs);
			setUpdatedAt(new Date().toLocaleTimeString());
		} catch {
			setError("Failed to load ops data.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<div className="max-w-6xl mx-auto px-4 py-8">
			{/* Header */}
			<div className="flex items-center justify-between gap-4 mb-6">
				<div>
					<h1 className="text-2xl font-bold">Operations</h1>
					<p className="text-sm text-base-content/60">
						Moderation queue and platform telemetry
						{updatedAt && ` · telemetry updated ${updatedAt}`}
					</p>
				</div>
				<button
					type="button"
					className="btn btn-sm btn-ghost gap-2"
					onClick={load}
					disabled={loading}
				>
					<ArrowPathIcon className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
					Refresh
				</button>
			</div>

			{error && (
				<div className="alert alert-error mb-6">
					<span>{error}</span>
				</div>
			)}

			{/* Outside the telemetry gate on purpose — it loads itself, so the work
			    queue isn't held behind a pg-boss health query. */}
			<div className="mb-10">
				<ModerationQueue />
			</div>

			{/* Outside the telemetry gate for the same reason as the queue above: it loads
			    itself, and an appeal is somebody's work sitting behind a paywall while it
			    waits. */}
			<div className="mb-10">
				<RatingAppealsQueue />
			</div>

			{/* Outside the telemetry gate for the third time, and here it is not about
			    latency: a preservation letter arrives on its own schedule, and a hold
			    that could not be placed because a pg-boss health query was slow is the
			    failure this surface exists to remove. */}
			<div className="mb-10">
				<LegalHolds />
			</div>

			{loading && !activity && !jobs ? (
				<div className="flex justify-center py-20">
					<LoadingSpinner size="lg" />
				</div>
			) : (
				<div className="space-y-10">
					{/* ── Activity ─────────────────────────────────────────── */}
					{activity && (
						<section>
							<SectionHeading>Activity</SectionHeading>
							<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
								<StatCard
									title="Users"
									value={activity.users.total.toLocaleString()}
									sub={`+${activity.users.new24h} today · +${activity.users.new7d} / 7d`}
								/>
								<StatCard
									title="Creators"
									value={activity.users.creators.toLocaleString()}
									sub={`${activity.users.admins} admin${activity.users.admins === 1 ? "" : "s"}`}
								/>
								<StatCard
									title="Posts"
									value={activity.posts.published.toLocaleString()}
									sub={`published · +${activity.posts.new24h} today`}
								/>
								<StatCard
									title="Uploads"
									value={activity.uploads.total.toLocaleString()}
									sub={`${activity.comments.new24h} comments today`}
								/>
							</div>

							{/* 14-day series */}
							<div className="mt-5 rounded-box border border-base-300 bg-base-100 p-4">
								<div className="text-xs uppercase tracking-wide text-base-content/50 mb-3">
									Last 14 days — sign-ups &amp; posts
								</div>
								<div className="text-base-content/60">
									<ResponsiveContainer width="100%" height={220}>
										<LineChart
											data={activity.series}
											margin={{ top: 8, right: 12, bottom: 8, left: -12 }}
										>
											<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
											<XAxis
												dataKey="date"
												tick={{ fill: "currentColor", fontSize: 10 }}
												tickFormatter={(d: string) => d.slice(5)}
											/>
											<YAxis tick={{ fill: "currentColor", fontSize: 10 }} allowDecimals={false} />
											<Tooltip
												contentStyle={{
													background: "var(--color-base-100, #fff)",
													border: "1px solid var(--color-base-300, #ccc)",
													borderRadius: 8,
													fontSize: 12,
												}}
											/>
											<Line
												type="monotone"
												dataKey="signups"
												name="Sign-ups"
												stroke="#22c55e"
												strokeWidth={2}
												dot={false}
											/>
											<Line
												type="monotone"
												dataKey="posts"
												name="Posts"
												stroke="#f59e0b"
												strokeWidth={2}
												dot={false}
											/>
										</LineChart>
									</ResponsiveContainer>
								</div>
								<div className="flex gap-4 mt-2 text-xs text-base-content/60">
									<span className="inline-flex items-center gap-1.5">
										<span className="w-2.5 h-2.5 rounded-full" style={{ background: "#22c55e" }} />
										Sign-ups
									</span>
									<span className="inline-flex items-center gap-1.5">
										<span className="w-2.5 h-2.5 rounded-full" style={{ background: "#f59e0b" }} />
										Posts
									</span>
								</div>
							</div>
						</section>
					)}

					{/* ── Jobs & queue health ──────────────────────────────── */}
					{jobs && (
						<section>
							<SectionHeading>Jobs &amp; queue health</SectionHeading>

							{!jobs.pgboss.available ? (
								<div className="alert mb-4">
									<span>
										Job queue schema not initialized — the worker hasn&apos;t run against this
										database yet.
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
															<span className="text-error font-semibold">{q.failed}</span>
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

							{/* Recent job failures */}
							{jobs.pgboss.available && (
								<div className="mt-4">
									<div className="text-xs uppercase tracking-wide text-base-content/50 mb-2">
										Recent failures
									</div>
									{jobs.pgboss.failures.length === 0 ? (
										<p className="text-sm text-success">No recent job failures.</p>
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
															<td className="text-xs whitespace-nowrap">
																{new Date(f.createdOn).toLocaleString()}
															</td>
															<td className="text-xs max-w-md truncate" title={f.error}>
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

							{/* Media transcodes */}
							<div className="mt-5">
								<div className="text-xs uppercase tracking-wide text-base-content/50 mb-2">
									Media processing
								</div>
								{Object.keys(jobs.transcodes.counts).length === 0 ? (
									<p className="text-sm text-base-content/60">No media jobs recorded yet.</p>
								) : (
									<div className="flex flex-wrap gap-2">
										{Object.entries(jobs.transcodes.counts).map(([status, n]) => (
											<span
												key={status}
												className={`badge ${
													status === "failed"
														? "badge-error"
														: status === "completed"
															? "badge-success"
															: "badge-ghost"
												}`}
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
														<td className="text-xs max-w-xs truncate" title={p.error}>
															{p.error || "—"}
														</td>
														<td className="text-xs whitespace-nowrap">
															{new Date(p.updatedAt).toLocaleString()}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</div>
						</section>
					)}

					{/* ── Operator deep-links ──────────────────────────────── */}
					<section>
						<SectionHeading>Infrastructure &amp; spend</SectionHeading>
						<p className="text-sm text-base-content/60 mb-3">
							Live logs and billing live in the DigitalOcean dashboard; media storage is in
							Cloudflare R2.
						</p>
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
							{OPERATOR_LINKS.map((l) => (
								<a
									key={l.href}
									href={l.href}
									target="_blank"
									rel="noopener noreferrer"
									className="rounded-box border border-base-300 bg-base-100 p-4 hover:border-primary/50 transition-colors flex items-start justify-between gap-3"
								>
									<div>
										<div className="font-medium">{l.label}</div>
										<div className="text-xs text-base-content/60 mt-0.5">{l.hint}</div>
									</div>
									<ArrowTopRightOnSquareIcon className="w-4 h-4 shrink-0 text-base-content/40" />
								</a>
							))}
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
