// SPDX-License-Identifier: Apache-2.0
/**
 * ATProto records: the drift report, per-row re-sync, and the Work listing correction.
 *
 * The nightly reconcile sweep catches a record that should not exist and a publishable row
 * with none; this page catches the thing SQL cannot see — a record that stands but no longer
 * says what its row says — by fetching each record and diffing it against what the row
 * derives now. The re-sync button runs the row's own sync in place; the correction form
 * edits the listing fields through the same service the creator's edit uses, so the record
 * follows the row.
 */
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../components/ui";
import { adminPost, useAdminData } from "../lib/load";

type DriftStatus =
	| "match"
	| "drift"
	| "missing"
	| "should_not_exist"
	| "blocked"
	| "not_publishable";

interface DriftRow {
	kind: "work" | "post" | "project";
	id: number;
	label: string;
	creatorHandle: string | null;
	status: DriftStatus;
	uri: string | null;
	derived: Record<string, unknown> | null;
	fetched: { record: unknown } | { error: string } | null;
	unpublishableReason: string | null;
}

interface DriftReport {
	generatedAt: string;
	counts: Record<DriftStatus, number> & { works: number; posts: number; projects: number };
	rows: DriftRow[];
}

/** The findings an operator is here for, in the order they are shown. */
const FINDING_ORDER: DriftStatus[] = [
	"should_not_exist",
	"drift",
	"missing",
	"blocked",
	"not_publishable",
	"match",
];

/** How each status reads as a badge, with the color carrying the severity. */
const STATUS_BADGES: Record<DriftStatus, { label: string; className: string }> = {
	should_not_exist: { label: "record on unpublishable row", className: "badge-error" },
	drift: { label: "drift", className: "badge-error" },
	missing: { label: "no record", className: "badge-warning" },
	blocked: { label: "unreadable", className: "badge-warning" },
	not_publishable: { label: "not publishable", className: "badge-ghost" },
	match: { label: "in sync", className: "badge-success" },
};

/** A fetched record as JSON, or the fetch error. */
function Fetched({ row }: { row: DriftRow }) {
	if (!row.fetched) return <span className="text-base-content/40">—</span>;
	if ("error" in row.fetched) {
		return <span className="text-error text-xs">{row.fetched.error}</span>;
	}
	return (
		<pre className="max-h-40 overflow-auto rounded bg-base-200 p-2 font-mono text-xs">
			{JSON.stringify(row.fetched.record, null, 2)}
		</pre>
	);
}

/** One row: its finding, both sides of the comparison, and the actions. */
function DriftRowView({ row, onChanged }: { row: DriftRow; onChanged: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");

	const resync = async () => {
		setBusy(true);
		setError(null);
		setDone(null);
		const result = await adminPost<{ result: { status: string; reason?: string; error?: string } }>(
			"/admin/atproto/resync",
			{ kind: row.kind, id: row.id },
		);
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setDone(
			`re-sync: ${result.data.result.status}${"reason" in result.data.result ? ` (${result.data.result.reason})` : ""}`,
		);
		onChanged();
	};

	const correct = async () => {
		setBusy(true);
		setError(null);
		setDone(null);
		const body: Record<string, unknown> = { workId: row.id };
		if (title !== "") body.title = title;
		if (description !== "") body.description = description;
		const result = await adminPost("/admin/works/listing", body);
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setDone("listing corrected — record will follow");
		setEditing(false);
		setTitle("");
		setDescription("");
		onChanged();
	};

	const badge = STATUS_BADGES[row.status];

	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<span className="font-mono text-sm font-semibold">
						{row.kind} #{row.id}
					</span>
					<span className="ml-2 text-sm">{row.label}</span>
					{row.creatorHandle && (
						<span className="ml-2 text-xs text-base-content/60">{row.creatorHandle}</span>
					)}
				</div>
				<span className={`badge badge-sm ${badge.className}`}>{badge.label}</span>
			</div>

			{row.unpublishableReason && (
				<p className="mt-1 text-xs text-base-content/60">
					why no record should stand: <code className="font-mono">{row.unpublishableReason}</code>
				</p>
			)}
			{row.uri && <p className="mt-1 truncate font-mono text-xs text-base-content/40">{row.uri}</p>}

			<div className="mt-2 grid gap-2 md:grid-cols-2">
				<div>
					<p className="text-xs font-semibold text-base-content/60">what the row derives now</p>
					{row.derived ? (
						<pre className="max-h-40 overflow-auto rounded bg-base-200 p-2 font-mono text-xs">
							{JSON.stringify(row.derived, null, 2)}
						</pre>
					) : (
						<span className="text-base-content/40 text-xs">nothing (unpublishable)</span>
					)}
				</div>
				<div>
					<p className="text-xs font-semibold text-base-content/60">what the record says</p>
					<Fetched row={row} />
				</div>
			</div>

			<div className="mt-2 flex items-center gap-2">
				<button type="button" className="btn btn-sm" onClick={resync} disabled={busy}>
					Re-sync now
				</button>
				{row.kind === "work" && (
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => setEditing(!editing)}
						disabled={busy}
					>
						{editing ? "Cancel correction" : "Correct listing…"}
					</button>
				)}
			</div>

			{editing && (
				<div className="mt-2 flex flex-col gap-2 rounded bg-base-200 p-3">
					<label className="text-xs">
						New title (blank leaves it)
						<input
							className="input input-sm w-full"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={255}
						/>
					</label>
					<label className="text-xs">
						New description (blank leaves it)
						<textarea
							className="textarea textarea-sm w-full"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							maxLength={50000}
							rows={3}
						/>
					</label>
					<button
						type="button"
						className="btn btn-sm btn-primary self-start"
						onClick={correct}
						disabled={busy || (title === "" && description === "")}
					>
						Save correction
					</button>
				</div>
			)}

			{error && <ErrorAlert>{error}</ErrorAlert>}
			{done && <p className="mt-1 text-xs text-success">{done}</p>}
		</div>
	);
}

export default function AtProtoRecords() {
	const { data, loading, error, reload } = useAdminData<{ report: DriftReport }>(
		"/admin/atproto/drift",
	);
	const [showInSync, setShowInSync] = useState(false);

	if (loading) return <Loading />;
	if (error) return <ErrorAlert>{error}</ErrorAlert>;
	const report = data?.report;
	if (!report) return null;

	const byStatus = new Map<DriftStatus, DriftRow[]>();
	for (const row of report.rows) {
		const list = byStatus.get(row.status) ?? [];
		list.push(row);
		byStatus.set(row.status, list);
	}
	const visible = FINDING_ORDER.filter((s) => (s === "match" ? showInSync : true)).filter(
		(s) => (byStatus.get(s)?.length ?? 0) > 0,
	);

	return (
		<div>
			<PageHeader
				title="ATProto Records"
				description="What the rows say versus what the records on the network say."
			/>

			<div className="stats stats-sm bg-base-100 mb-4 shadow">
				{FINDING_ORDER.map((s) => (
					<div className="stat" key={s}>
						<div className="stat-title text-xs">{STATUS_BADGES[s].label}</div>
						<div className="stat-value text-lg">{report.counts[s]}</div>
					</div>
				))}
				<div className="stat">
					<div className="stat-title text-xs">rows walked</div>
					<div className="stat-value text-lg">
						{report.counts.works + report.counts.posts + report.counts.projects}
					</div>
				</div>
			</div>

			<div className="mb-3 flex items-center justify-between">
				<p className="text-xs text-base-content/60">
					report generated {new Date(report.generatedAt).toLocaleString()}
				</p>
				<label className="label cursor-pointer gap-2 text-xs">
					show in-sync rows
					<input
						type="checkbox"
						className="toggle toggle-sm"
						checked={showInSync}
						onChange={(e) => setShowInSync(e.target.checked)}
					/>
				</label>
			</div>

			{visible.length === 0 ? (
				<p className="text-sm text-base-content/60">Everything the report walks is in sync.</p>
			) : (
				visible.map((s) => (
					<div className="mb-4" key={s}>
						<SectionHeading>{STATUS_BADGES[s].label}</SectionHeading>
						<div className="flex flex-col gap-2">
							{(byStatus.get(s) ?? []).map((row) => (
								<DriftRowView key={`${row.kind}-${row.id}`} row={row} onChanged={reload} />
							))}
						</div>
					</div>
				))
			)}
		</div>
	);
}
