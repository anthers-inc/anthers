// SPDX-License-Identifier: Apache-2.0
/**
 * Issue reports: the queue behind the public Issue Reports page — defect reports about
 * Anthers itself, from anybody, with no account required.
 *
 * 🚨 **This is not the abuse queue and renders none of its machinery.** No legal-reason
 * badge, no "check delivery" half-state, no child-safety warning — those exist because the
 * other pipeline sends mail and carries statutes. This pipeline sends no mail: the row is
 * read here, and the one action is marking it ingested.
 *
 * **Ingested is the only action, and it is not the same as "done".** The row is a report
 * item rather than a work item: marking it ingested says actual work — a task in the
 * project's own tracker — now owns the problem it describes. Nothing here ever claims the
 * bug was fixed; the tracker where that task lives says so, and a second place claiming it
 * would be a second, drifting truth.
 *
 * The reported locations of abuse reports are text rather than links for child-safety
 * reasons; the same choice is kept here out of consistency rather than necessity — a
 * reporter's typed location is untrusted text, and what a row points at is a parsing
 * decision for the person reading it, not for a cursor.
 */
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";

interface IssueReport {
	id: number;
	summary: string;
	details: string;
	pageUrl: string;
	reporterEmail: string;
	reporterId: number | null;
	status: string;
	createdAt: string;
	ingestedAt: string | null;
}

const STATUS_NAMES: Record<string, string> = {
	open: "Open",
	ingested: "Ingested",
};

function dateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function IssueCard({ issue, onIngested }: { issue: IssueReport; onIngested: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const open = issue.status === "open";

	async function ingest() {
		setBusy(true);
		setError(null);
		const result = await adminPost("/api/admin/issue-reports/ingest", {
			issueId: issue.id,
		});
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onIngested();
	}

	return (
		<li
			className={`rounded-box border border-base-300 bg-base-100 p-4 ${open ? "" : "opacity-70"}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className={`badge badge-sm ${open ? "badge-warning" : "badge-ghost"}`}>
					{STATUS_NAMES[issue.status] ?? issue.status}
				</span>
				<span className="text-xs text-base-content/50">Issue #{issue.id}</span>
				<span className="ml-auto text-xs text-base-content/60">
					Filed {dateTime(issue.createdAt)}
				</span>
			</div>

			<p className="mt-3 font-semibold">{issue.summary}</p>
			<p className="mt-1 whitespace-pre-wrap text-sm text-base-content/80">{issue.details}</p>

			{issue.pageUrl ? (
				<div className="mt-3 break-all rounded bg-base-200 px-2 py-1 font-mono text-xs">
					{issue.pageUrl}
				</div>
			) : (
				<p className="mt-3 text-xs text-base-content/50">The reporter named no location.</p>
			)}

			<div className="mt-3 text-sm text-base-content/70">
				{issue.reporterEmail ? (
					<>
						The reporter can be reached at{" "}
						<a className="link" href={`mailto:${issue.reporterEmail}`}>
							{issue.reporterEmail}
						</a>
						.
					</>
				) : issue.reporterId != null ? (
					`Filed by signed-in account #${issue.reporterId}, who left no email address.`
				) : (
					"The reporter left no address, so there is nobody to reply to."
				)}
			</div>

			{!open && issue.ingestedAt && (
				<p className="mt-2 text-xs text-base-content/60">
					Marked ingested {dateTime(issue.ingestedAt)} — a task in the project tracker owns this
					now.
				</p>
			)}

			{open && (
				<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-base-300 pt-3">
					<button
						type="button"
						className="btn btn-sm btn-primary"
						onClick={ingest}
						disabled={busy}
						title="Actual work in the task tracker now owns this"
					>
						Mark Ingested
					</button>
					{error && <span className="text-sm text-error">{error}</span>}
				</div>
			)}
		</li>
	);
}

export default function IssueReports() {
	const [showIngested, setShowIngested] = useState(false);
	const { data, loading, error, reload } = useAdminData<{ reports: IssueReport[] }>(
		showIngested ? "/api/admin/issue-reports?ingested=1" : "/api/admin/issue-reports",
	);

	// Open ones first, then newest first, which the API's own order does not guarantee once
	// ingested reports are included.
	const reports = [...(data?.reports ?? [])].sort((a, b) => {
		if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});

	return (
		<div>
			<PageHeader
				title="Issue Reports"
				description="Defect reports about Anthers itself, from the public intake — no account required to file one."
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}

			<div className="mb-4 rounded-box border border-base-300 bg-base-100 p-4 text-sm text-base-content/80">
				An issue here is a report item, not a work item. Marking one ingested says actual work in
				the project task tracker now owns it — file that task first, then mark it. This queue sends
				no mail, and nothing here means the problem was fixed; the tracker is the only place that
				says so.
			</div>

			<div className="mb-3 flex justify-end">
				<label className="flex cursor-pointer items-center gap-2 text-sm">
					<input
						type="checkbox"
						className="toggle toggle-sm"
						checked={showIngested}
						onChange={(e) => setShowIngested(e.target.checked)}
					/>
					Show Ingested Reports
				</label>
			</div>

			{loading && !data ? (
				<Loading />
			) : reports.length === 0 ? (
				<p className="text-sm text-base-content/60">
					{showIngested ? "Nobody has filed an issue yet." : "No issue report is open."}
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{reports.map((report) => (
						<IssueCard key={report.id} issue={report} onIngested={reload} />
					))}
				</ul>
			)}
		</div>
	);
}
