// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's home: what is owed on a date, what is waiting on somebody, then how the
 * platform is growing.
 *
 * Deadlines come first because a missed one is the costliest thing on this page: every obligation
 * with a due date, from the rights requests and DMCA windows in the database to the Compliance
 * Calendar's filings, in one list — past due at the top, terminal misses marked. Below it, the
 * queues of work waiting on somebody, then growth. Each section loads on its own, so one slow
 * queue does not hold up the rest.
 */
import { Link } from "react-router-dom";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
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

interface DeadlineRow {
	source: string;
	key: string;
	title: string;
	dueAt: string;
	windowStart: string | null;
	pastDue: boolean;
	terminal: boolean;
	consequence: string;
	actUrl: string | null;
	note: string | null;
	unconfirmed: boolean | null;
	selfImposed: boolean | null;
	condition: string | null;
}

interface DeadlinesResponse {
	deadlines: DeadlineRow[];
	deferred: { id: string; note: string }[];
}

/** Where a deadline came from, as a label. Title case — a label is copy and takes the rule. */
const SOURCE_LABELS: Record<string, string> = {
	"rights-request": "Rights Request",
	"dmca-counter-notice": "DMCA Counter-Notice Window",
	"dmca-restore": "DMCA Restore Window",
	"legal-hold": "Legal Hold",
	"dispute-evidence": "Dispute Evidence",
	"compliance-calendar": "Compliance Calendar",
};

function deadlineDueLabel(row: DeadlineRow): string {
	const due = new Date(row.dueAt).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
	if (!row.windowStart) return due;
	const start = new Date(row.windowStart).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
	return `${start} → ${due}`;
}

function DeadlineRowCard({ row }: { row: DeadlineRow }) {
	// Past due first and visually distinct — a missed deadline is owed more urgently than any
	// future one, and the eye should find it without reading anything.
	const body = (
		<div
			className={`rounded-box border bg-base-100 p-4 ${row.pastDue ? "border-error" : "border-base-300"}`}
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-xs uppercase tracking-wide text-base-content/50">
						{SOURCE_LABELS[row.source] ?? row.source}
					</div>
					<div className="mt-1 font-semibold">{row.title}</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{row.terminal && (
						<span
							className="badge badge-error badge-outline"
							title="A miss here is terminal — it ends in dissolution, lost safe harbor or revocation."
						>
							Terminal Miss
						</span>
					)}
					{row.unconfirmed && (
						<span className="badge badge-warning badge-outline">Unconfirmed Text</span>
					)}
					{row.selfImposed && <span className="badge badge-ghost">Self-Imposed</span>}
					{row.pastDue && <span className="badge badge-error">Past Due</span>}
				</div>
			</div>
			<div className="mt-2 text-sm">
				{row.pastDue ? (
					<span className="font-semibold text-error">Was due {deadlineDueLabel(row)}</span>
				) : (
					<span>Due {deadlineDueLabel(row)}</span>
				)}
				{row.condition && <span className="text-base-content/60"> — {row.condition}</span>}
			</div>
			<div className="mt-1.5 text-sm text-base-content/70">{row.consequence}</div>
			{row.actUrl ? (
				<div className="mt-2 text-sm">
					<span className="text-base-content/60">Act on it: </span>
					<span className="text-primary">{row.actUrl}</span>
				</div>
			) : (
				// An honest absent rather than an invented route: there is no admin screen for a
				// filing yet, and a link to nothing is a reference nobody can follow.
				<div className="mt-2 text-sm text-base-content/60">
					There is no admin screen for this yet — it is handled wherever the filing is made.
				</div>
			)}
		</div>
	);
	return row.actUrl ? (
		<Link to={row.actUrl} className="block transition-opacity hover:opacity-80">
			{body}
		</Link>
	) : (
		body
	);
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
	const issues = useAdminData<{ reports: unknown[] }>("/api/admin/issue-reports");
	const dmca = useAdminData<{
		summary: { received: number; counterNoticed: number };
	}>("/api/admin/dmca");
	const deadlines = useAdminData<DeadlinesResponse>("/api/admin/deadlines");
	const disputes = useAdminData<{
		items: unknown[];
		standing: {
			count: number;
			ratio: number | null;
			openCount: number;
			state: "quiet" | "approaching" | "early-warning";
		};
	}>("/api/admin/disputes");

	const a = activity.data;
	const dmcaOpen = dmca.data ? dmca.data.summary.received + dmca.data.summary.counterNoticed : null;
	const pastDueCount = deadlines.data
		? deadlines.data.deadlines.filter((d) => d.pastDue).length
		: 0;

	return (
		<div>
			<PageHeader
				title="Home"
				description="What is waiting on somebody, and how the platform is growing."
			/>

			{/* Everything with a due date, from every source — the list half of the decision that
			    anything with a deadline reaches the operator by email and is acted on in the app.
			    Past-due items sit at the top and carry the error border; the endpoint has already
			    sorted them. */}
			<section className="mb-10">
				<SectionHeading>
					Deadlines
					{pastDueCount > 0 && (
						<span className="ml-2 badge badge-error">{pastDueCount} past due</span>
					)}
				</SectionHeading>
				{deadlines.error && <ErrorAlert>{deadlines.error}</ErrorAlert>}
				{!deadlines.data ? (
					deadlines.error ? null : (
						<Loading />
					)
				) : deadlines.data.deadlines.length === 0 ? (
					<p className="text-sm text-base-content/60">Nothing with a due date is open right now.</p>
				) : (
					<div className="grid gap-3">
						{deadlines.data.deadlines.map((row) => (
							<DeadlineRowCard key={row.key} row={row} />
						))}
					</div>
				)}
			</section>

			{/* The dispute-standing panel — the ratio-threshold alert's app half (Parker,
			    2026-10-02). The lines are Visa's VAMP rule: non-compliant at a 0.5%
			    dispute+EFW ratio or a count of 5 in a month, so the alert fires at those
			    numbers as an early warning and at half of them as "approaching". Count and
			    ratio are both stated because a small account trips the count first — a ratio
			    alone would stay quiet through exactly the account most likely to cross it. */}
			<section className="mb-10">
				<SectionHeading>Dispute Standing</SectionHeading>
				{disputes.error && <ErrorAlert>{disputes.error}</ErrorAlert>}
				{!disputes.data ? (
					disputes.error ? null : (
						<Loading />
					)
				) : disputes.data.standing.count === 0 && disputes.data.standing.openCount === 0 ? (
					// Quiet is stated plainly rather than hidden: "no disputes" is the answer,
					// and an absent panel would be indistinguishable from a broken one.
					<p className="text-sm text-base-content/60">
						No disputes — nothing has been charged back, and there is nothing to act on.
					</p>
				) : (
					<div
						className={`rounded-box border p-4 ${
							disputes.data.standing.state === "early-warning"
								? "border-error"
								: disputes.data.standing.state === "approaching"
									? "border-warning"
									: "border-base-300"
						}`}
					>
						<div className="flex flex-wrap items-baseline gap-3">
							<span className="text-2xl font-semibold tabular-nums">
								{disputes.data.standing.count}
							</span>
							<span className="text-sm text-base-content/60">
								disputes in the last 30 days
								{" · "}
								{disputes.data.standing.ratio === null
									? "no successful payments to measure a ratio against"
									: `${(disputes.data.standing.ratio * 100).toFixed(2)}% of successful payments`}
								{" · "}
								{disputes.data.standing.openCount} open
							</span>
						</div>
						<p className="mt-1 text-sm text-base-content/70">
							{disputes.data.standing.state === "early-warning"
								? "Past the early-warning line — look at the list before anything else."
								: "Approaching the early-warning line — worth a look."}
						</p>
						<p className="mt-2 text-xs text-base-content/50">
							The lines: early-warning at 0.5% or 5 disputes in the window, approaching at half
							that. The count is what a small account trips first, which is why both are stated.
							Measured over a rolling 30 days on Anthers' own records — an early warning, not an
							audit; the networks measure calendar months on theirs.
						</p>
					</div>
				)}
			</section>

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
					<AttentionCard
						to="/legal/abuse-reports"
						title="Open Abuse Reports"
						count={abuse.data?.reports.length ?? null}
					/>
					<AttentionCard to="/legal/dmca" title="DMCA Notices in Progress" count={dmcaOpen} />
					<AttentionCard
						to="/issues"
						title="Open Issue Reports"
						count={issues.data?.reports.length ?? null}
					/>
					<AttentionCard
						to="/moderation"
						title="Open Reports"
						count={moderation.data?.summary.openReports ?? null}
						detail={
							moderation.data
								? `about ${moderation.data.summary.reportedSubjects} things`
								: undefined
						}
					/>
					<AttentionCard
						to="/moderation/appeals"
						title="Rating Appeals"
						count={appeals.data?.appeals.length ?? null}
					/>
					<AttentionCard
						to="/books/disputes"
						title="Open Disputes"
						count={disputes.data?.standing.openCount ?? null}
						urgent={disputes.data?.standing.state === "early-warning"}
						detail={
							disputes.data?.standing.state === "early-warning"
								? "past the early-warning line"
								: disputes.data?.standing.state === "approaching"
									? "approaching the early-warning line"
									: undefined
						}
					/>
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
						</div>
					</>
				)}
			</section>
		</div>
	);
}
