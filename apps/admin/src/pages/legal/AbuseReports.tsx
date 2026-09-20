// SPDX-License-Identifier: Apache-2.0
/**
 * Abuse reports: the queue behind the public intake, where anybody can report illegal content
 * without an account.
 *
 * 🚨 **The reported location is shown as text and never as a link.** A report on a child-safety
 * reason may point straight at the material, and the step the incident runbook gives an operator is
 * not to open it. Following a link from here would be exactly that, one click earlier.
 *
 * A report on a legal reason is emailed to the abuse inbox when it is filed, and whether that email
 * arrived is asked of what the provider pushed back rather than assumed from the send. `delivered`
 * means the receiving server accepted it, not that anybody read it, and the screen says so beside
 * the answer because a message filed into spam is `delivered` too.
 *
 * Closing has two outcomes and never a bare "done": resolved means something was done about what
 * the report named, dismissed means it was read and needed nothing.
 */
import { isLegalReason, moderationReasonLabel } from "@anthers/shared/moderation";
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";

interface AbuseReport {
	id: number;
	url: string;
	workId: number | null;
	reason: string;
	details: string;
	reporterEmail: string;
	status: string;
	escalatedAt: string | null;
	createdAt: string;
}

interface Delivery {
	messageId: string | null;
	status: {
		event: string;
		delivered: boolean;
		terminal: boolean;
		occurredAt: string | null;
	} | null;
	reason: "not_escalated" | "awaiting_provider_event" | null;
}

const STATUS_NAMES: Record<string, string> = {
	open: "Open",
	resolved: "Resolved",
	dismissed: "Dismissed",
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

/** Mounted by "Check Delivery", so the question is only asked of the report somebody chose. */
function DeliveryCheck({ reportId }: { reportId: number }) {
	const { data, loading, error, reload } = useAdminData<Delivery>(
		`/api/admin/escalation-delivery?kind=abuse&id=${reportId}`,
	);

	let answer: { tone: string; text: string } | null = null;
	if (data) {
		if (data.reason === "not_escalated") {
			answer = { tone: "text-warning", text: "No alert has been sent for this report." };
		} else if (data.reason === "awaiting_provider_event" || !data.status) {
			answer = {
				tone: "text-base-content/70",
				text: "The email provider accepted the alert and has not reported what became of it yet.",
			};
		} else if (data.status.delivered) {
			answer = {
				tone: "text-success",
				text: `Delivered (${data.status.event}${data.status.occurredAt ? `, ${dateTime(data.status.occurredAt)}` : ""}). The receiving mail server accepted it, which does not mean a person has read it.`,
			};
		} else if (data.status.terminal) {
			answer = {
				tone: "text-error",
				text: `The alert was not delivered: the provider reported "${data.status.event}".`,
			};
		} else {
			answer = {
				tone: "text-warning",
				text: `Not delivered yet. The latest event from the provider is "${data.status.event}".`,
			};
		}
	}

	return (
		<div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
			{loading ? (
				<span className="text-base-content/60">Checking…</span>
			) : error ? (
				<span className="text-error">{error}</span>
			) : (
				answer && <span className={answer.tone}>{answer.text}</span>
			)}
			{!loading && (
				<button type="button" className="btn btn-xs btn-ghost" onClick={reload}>
					Check Again
				</button>
			)}
		</div>
	);
}

function ReportCard({ report, onClosed }: { report: AbuseReport; onClosed: () => void }) {
	const [checking, setChecking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const legal = isLegalReason(report.reason);
	const open = report.status === "open";

	async function close(outcome: "resolved" | "dismissed") {
		setBusy(true);
		setError(null);
		const result = await adminPost("/api/admin/abuse-reports/close", {
			reportId: report.id,
			outcome,
		});
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onClosed();
	}

	return (
		<li
			className={`rounded-box border border-base-300 bg-base-100 p-4 ${open ? "" : "opacity-70"}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className={`badge badge-sm ${open ? "badge-warning" : "badge-ghost"}`}>
					{STATUS_NAMES[report.status] ?? report.status}
				</span>
				<span className={`badge badge-sm ${legal ? "badge-error" : "badge-ghost"}`}>
					{moderationReasonLabel(report.reason)}
				</span>
				<span className="text-xs text-base-content/50">Report #{report.id}</span>
				<span className="ml-auto text-xs text-base-content/60">
					Filed {dateTime(report.createdAt)}
				</span>
			</div>

			<div className="mt-3 break-all rounded bg-base-200 px-2 py-1 font-mono text-xs">
				{report.url}
			</div>
			<div className="mt-1 text-xs text-base-content/60">
				{report.workId != null
					? `This location resolves to Work #${report.workId}.`
					: "This location did not resolve to a Work on Anthers."}
			</div>

			{report.details ? (
				<p className="mt-3 whitespace-pre-wrap text-sm text-base-content/80">{report.details}</p>
			) : (
				<p className="mt-3 text-sm text-base-content/50">
					The reporter's words were removed on the retention schedule.
				</p>
			)}

			<div className="mt-3 text-sm text-base-content/70">
				{report.reporterEmail ? (
					<>
						The reporter can be reached at{" "}
						<a className="link" href={`mailto:${report.reporterEmail}`}>
							{report.reporterEmail}
						</a>
						.
					</>
				) : (
					"The reporter left no address, so there is nobody to reply to."
				)}
			</div>

			<div className="mt-3 border-t border-base-300 pt-3">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="text-base-content/70">
						{report.escalatedAt
							? `An alert went to the abuse inbox on ${dateTime(report.escalatedAt)}.`
							: legal
								? "The alert to the abuse inbox has not been sent yet. On a public deployment the escalation sweep retries it."
								: "This reason is not emailed to the abuse inbox."}
					</span>
					{(report.escalatedAt || legal) && !checking && (
						<button
							type="button"
							className="btn btn-xs btn-outline"
							onClick={() => setChecking(true)}
						>
							Check Delivery
						</button>
					)}
				</div>
				{checking && <DeliveryCheck reportId={report.id} />}
			</div>

			{open && (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<button
						type="button"
						className="btn btn-sm btn-primary"
						onClick={() => close("resolved")}
						disabled={busy}
						title="Something was done about what this report named"
					>
						Resolve
					</button>
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => close("dismissed")}
						disabled={busy}
						title="The report was read and needed nothing"
					>
						Dismiss
					</button>
					{error && <span className="text-sm text-error">{error}</span>}
				</div>
			)}
		</li>
	);
}

export default function AbuseReports() {
	const [showClosed, setShowClosed] = useState(false);
	const { data, loading, error, reload } = useAdminData<{ reports: AbuseReport[] }>(
		showClosed ? "/api/admin/abuse-reports?closed=1" : "/api/admin/abuse-reports",
	);

	// Open ones first, then newest first, which the API's own order does not guarantee once closed
	// reports are included.
	const reports = [...(data?.reports ?? [])].sort((a, b) => {
		if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});

	return (
		<div>
			<PageHeader
				title="Abuse Reports"
				description="Reports of illegal content from the public intake, which anybody can file without an account."
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}

			<div className="mb-4 rounded-box border border-base-300 bg-base-100 p-4 text-sm text-base-content/80">
				Reported locations are shown as text rather than links. If a report concerns child sexual
				abuse material, the enticement of a child or child sex trafficking, do not open the
				location; follow the Child Safety Incident Runbook instead. Resolving means something was
				done about what the report named, and dismissing means it was read and needed nothing.
				Closing a report does not cancel an alert that has not gone out yet.
			</div>

			<div className="mb-3 flex justify-end">
				<label className="flex cursor-pointer items-center gap-2 text-sm">
					<input
						type="checkbox"
						className="toggle toggle-sm"
						checked={showClosed}
						onChange={(e) => setShowClosed(e.target.checked)}
					/>
					Show Closed Reports
				</label>
			</div>

			{loading && !data ? (
				<Loading />
			) : reports.length === 0 ? (
				<p className="text-sm text-base-content/60">
					{showClosed ? "Nobody has filed a report yet." : "No report is open."}
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{reports.map((report) => (
						<ReportCard key={report.id} report={report} onClosed={reload} />
					))}
				</ul>
			)}
		</div>
	);
}
