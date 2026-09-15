// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's home: what is waiting on somebody, then how the platform is growing.
 *
 * What is waiting comes first because it is what an operator opens the app for. Each count links to
 * the screen where it is dealt with, and each loads on its own, so one slow queue does not hold up
 * the rest.
 */
import { Link } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../components/ui";
import { useAdminData } from "../lib/load";

interface Activity {
	admins: number;
	users: { total: number; creators: number; new24h: number; new7d: number };
	posts: { total: number; published: number; new24h: number; new7d: number };
	comments: { new24h: number; new7d: number };
	uploads: { total: number };
	series: { date: string; signups: number; posts: number }[];
}

function AttentionCard({
	to,
	title,
	count,
	detail,
	urgent,
}: {
	to: string;
	title: string;
	count: number | null;
	detail?: string;
	urgent?: boolean;
}) {
	return (
		<Link
			to={to}
			className={`rounded-box border bg-base-100 p-4 transition-colors hover:border-primary/50 ${urgent ? "border-error" : "border-base-300"}`}
		>
			<div className="text-xs uppercase tracking-wide text-base-content/50">{title}</div>
			<div className={`mt-1 text-2xl font-semibold tabular-nums ${urgent ? "text-error" : ""}`}>
				{count === null ? "…" : count}
			</div>
			{detail && <div className="mt-0.5 text-xs text-base-content/60">{detail}</div>}
		</Link>
	);
}

export default function Home() {
	const activity = useAdminData<Activity>("/api/admin/activity");
	const rights = useAdminData<{ open: number; overdue: number }>("/api/admin/rights-requests");
	const moderation = useAdminData<{ summary: { openReports: number; reportedSubjects: number } }>(
		"/api/admin/moderation?filter=reported",
	);
	const appeals = useAdminData<{ appeals: unknown[] }>("/api/admin/rating-appeals");
	const quarantine = useAdminData<{ summary: { openFindings: number } }>("/api/admin/quarantine");
	const abuse = useAdminData<{ reports: unknown[] }>("/api/admin/abuse-reports");
	const dmca = useAdminData<{ summary: { received: number; screening: number; counterNoticed: number } }>(
		"/api/admin/dmca",
	);

	const a = activity.data;
	const dmcaOpen = dmca.data
		? dmca.data.summary.received + dmca.data.summary.screening + dmca.data.summary.counterNoticed
		: null;

	return (
		<div>
			<PageHeader title="Home" description="What is waiting on somebody, and how the platform is growing." />

			<section className="mb-10">
				<SectionHeading>Needs Attention</SectionHeading>
				<div className="grid grid-cols-2 gap-3 md:grid-cols-3">
					<AttentionCard
						to="/legal/rights-requests"
						title="Rights Requests"
						count={rights.data?.open ?? null}
						detail={rights.data ? `${rights.data.overdue} past the 30-day deadline` : undefined}
						urgent={(rights.data?.overdue ?? 0) > 0}
					/>
					<AttentionCard
						to="/legal/quarantine"
						title="Open Quarantine Findings"
						count={quarantine.data?.summary.openFindings ?? null}
						urgent={(quarantine.data?.summary.openFindings ?? 0) > 0}
					/>
					<AttentionCard to="/legal/abuse-reports" title="Open Abuse Reports" count={abuse.data?.reports.length ?? null} />
					<AttentionCard to="/legal/dmca" title="DMCA Notices in Progress" count={dmcaOpen} />
					<AttentionCard
						to="/moderation"
						title="Open Reports"
						count={moderation.data?.summary.openReports ?? null}
						detail={moderation.data ? `about ${moderation.data.summary.reportedSubjects} things` : undefined}
					/>
					<AttentionCard to="/moderation/appeals" title="Rating Appeals" count={appeals.data?.appeals.length ?? null} />
				</div>
			</section>

			<section>
				<SectionHeading>Activity</SectionHeading>
				{activity.error && <ErrorAlert>{activity.error}</ErrorAlert>}
				{!a ? (
					<Loading />
				) : (
					<>
						<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
							<StatCard
								title="Accounts"
								value={a.users.total.toLocaleString()}
								sub={`+${a.users.new24h} today · +${a.users.new7d} this week`}
							/>
							<StatCard
								title="Creators"
								value={a.users.creators.toLocaleString()}
								sub={`${a.admins} admin account${a.admins === 1 ? "" : "s"}`}
							/>
							<StatCard
								title="Published Posts"
								value={a.posts.published.toLocaleString()}
								sub={`+${a.posts.new24h} today`}
							/>
							<StatCard
								title="Works"
								value={a.uploads.total.toLocaleString()}
								sub={`${a.comments.new24h} comments today`}
							/>
						</div>
						<div className="mt-5 rounded-box border border-base-300 bg-base-100 p-4">
							<div className="mb-3 text-xs uppercase tracking-wide text-base-content/50">
								Last 14 Days — Sign-Ups and Posts
							</div>
							<div className="text-base-content/60">
								<ResponsiveContainer width="100%" height={220}>
									<LineChart data={a.series} margin={{ top: 8, right: 12, bottom: 8, left: -12 }}>
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
										<Line type="monotone" dataKey="signups" name="Sign-ups" stroke="#22c55e" strokeWidth={2} dot={false} />
										<Line type="monotone" dataKey="posts" name="Posts" stroke="#f59e0b" strokeWidth={2} dot={false} />
									</LineChart>
								</ResponsiveContainer>
							</div>
						</div>
					</>
				)}
			</section>
		</div>
	);
}
