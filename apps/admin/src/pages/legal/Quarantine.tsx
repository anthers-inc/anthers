// SPDX-License-Identifier: Apache-2.0
/**
 * Child-safety quarantine: the findings that took material out of reach of everybody, and the two
 * operator actions on them, placing one by hand and clearing one that turned out to be wrong.
 *
 * 🚨 **This screen shows metadata and never the material.** § 5.2 of the Child Safety Reporting
 * Policy commits Anthers to an operator surface that shows the finding — the storage key, the Work,
 * the uploader, our classification and the timestamps — and never the image. So a key is rendered as
 * text and nothing here is an `<img>`, a `<video>`, a preview, or a link to the Work or the object. A
 * change that renders any of it is a policy amendment, not a UI tweak.
 *
 * 🚨 **A detection vendor's answer never appears here.** The API does not select it, and this screen
 * must not ask for it: the vendor's terms forbid its Match Data reaching generative AI, and this is
 * the surface most likely to be screenshotted into an agent. Our own `classification` is what is shown.
 *
 * Findings are grouped by Work because clearing is addressed by Work: one quarantine covers every
 * object the Work owns, and clearing it restores the visibility the creator had chosen. An object
 * with no Work (an avatar, badge art) is its own group and clears by its finding id.
 */
import { MODERATION_NOTE_MAX } from "@anthers/shared/moderation";
import { type FormEvent, useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";

interface Finding {
	id: number;
	workId: number | null;
	workTitle: string;
	uploaderId: number | null;
	uploaderName: string | null;
	originalKey: string;
	objectKind: string;
	source: string;
	classification: string;
	reportId: number | null;
	placedAt: string;
	placedBy: string | null;
	clearedAt: string | null;
	clearedBy: string | null;
	/** Why it was placed. */
	note: string;
	/** Why it was cleared, kept beside the placement note. */
	clearedNote: string;
}

interface QuarantineResponse {
	findings: Finding[];
	summary: { openFindings: number; works: number; objects: number };
}

interface Group {
	key: string;
	workId: number | null;
	findings: Finding[];
}

const SOURCE_NAMES: Record<string, string> = {
	report: "Report",
	scan: "Scan",
	operator: "Operator",
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

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** One group per Work, and one per Work-less finding, in the API's newest-first order. */
function groupFindings(findings: Finding[]): Group[] {
	const groups: Group[] = [];
	const byWork = new Map<number, Group>();
	for (const finding of findings) {
		if (finding.workId == null) {
			groups.push({ key: `object:${finding.id}`, workId: null, findings: [finding] });
			continue;
		}
		const existing = byWork.get(finding.workId);
		if (existing) {
			existing.findings.push(finding);
			continue;
		}
		const group = { key: `work:${finding.workId}`, workId: finding.workId, findings: [finding] };
		byWork.set(finding.workId, group);
		groups.push(group);
	}
	return groups;
}

function PlaceQuarantine({
	onPlaced,
	onFailed,
}: {
	onPlaced: (message: string) => void;
	onFailed: () => void;
}) {
	const [workId, setWorkId] = useState("");
	const [classification, setClassification] = useState("");
	const [reportId, setReportId] = useState("");
	const [note, setNote] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const ready = Number(workId) > 0 && classification.trim() !== "" && !busy;

	async function place() {
		setBusy(true);
		setError(null);
		const result = await adminPost<{
			objectsMoved: number;
			objectsAlreadyParked: number;
			objectsMissing: number;
			holdIds: number[];
		}>("/api/admin/quarantine", {
			workId: Number(workId),
			classification: classification.trim(),
			reportId: Number(reportId) > 0 ? Number(reportId) : undefined,
			note: note.trim() || undefined,
		});
		setBusy(false);
		setConfirming(false);
		if (!result.ok) {
			// The API's own sentence, which for a failure partway names the objects already moved
			// out of reach. The list is reloaded so whatever finding did get written shows.
			setError(result.error);
			onFailed();
			return;
		}
		const { objectsMoved, objectsAlreadyParked, objectsMissing, holdIds } = result.data;
		const parked =
			objectsAlreadyParked > 0
				? `${plural(objectsAlreadyParked, "object was", "objects were")} already out of reach, `
				: "";
		onPlaced(
			`Work ${workId} is quarantined: ${plural(objectsMoved, "object", "objects")} moved out of reach, ${parked}${plural(objectsMissing, "object", "objects")} named by the database but missing from storage, and ${plural(holdIds.length, "preservation hold", "preservation holds")} placed.`,
		);
		setWorkId("");
		setClassification("");
		setReportId("");
		setNote("");
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (ready) setConfirming(true);
	}

	return (
		<form onSubmit={submit} className="rounded-box border border-base-300 bg-base-100 p-4">
			<p className="mb-4 text-sm text-base-content/70">
				Quarantining a Work moves every object it owns out of every delivery path, delists the Work,
				and places a one-year preservation hold on the Work, its uploader and any linked report.{" "}
				<strong>It does not file a CyberTipline report.</strong> Reporting stays a manual step for
				the Designated Child Safety Contact, following the Child Safety Incident Runbook.
			</p>
			<div className="grid gap-3 sm:grid-cols-3">
				<label className="block">
					<span className="mb-1 block text-sm font-medium">Work ID</span>
					<input
						type="number"
						min={1}
						className="input input-bordered input-sm w-full"
						value={workId}
						onChange={(e) => setWorkId(e.target.value)}
						required
					/>
				</label>
				<label className="block">
					<span className="mb-1 block text-sm font-medium">Classification</span>
					<input
						type="text"
						maxLength={120}
						className="input input-bordered input-sm w-full"
						placeholder="Our own determination"
						value={classification}
						onChange={(e) => setClassification(e.target.value)}
						required
					/>
				</label>
				<label className="block">
					<span className="mb-1 block text-sm font-medium">Moderation Report ID (Optional)</span>
					<input
						type="number"
						min={1}
						className="input input-bordered input-sm w-full"
						value={reportId}
						onChange={(e) => setReportId(e.target.value)}
					/>
				</label>
			</div>
			<label className="mt-3 block">
				<span className="mb-1 block text-sm font-medium">Note (Optional)</span>
				<input
					type="text"
					maxLength={MODERATION_NOTE_MAX}
					className="input input-bordered input-sm w-full"
					value={note}
					onChange={(e) => setNote(e.target.value)}
				/>
			</label>
			{error && <p className="mt-3 text-sm text-error">{error}</p>}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				{confirming ? (
					<>
						<span className="text-sm">Quarantine Work {workId} now?</span>
						<button type="button" className="btn btn-sm btn-error" onClick={place} disabled={busy}>
							{busy ? "Quarantining…" : "Confirm Quarantine"}
						</button>
						<button
							type="button"
							className="btn btn-sm btn-ghost"
							onClick={() => setConfirming(false)}
							disabled={busy}
						>
							Cancel
						</button>
					</>
				) : (
					<button type="submit" className="btn btn-sm btn-error btn-outline" disabled={!ready}>
						Quarantine Work
					</button>
				)}
			</div>
		</form>
	);
}

function ClearPanel({
	group,
	onCleared,
	onCancel,
}: {
	group: Group;
	onCleared: (message: string) => void;
	onCancel: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const finding = group.findings[0];

	async function clear() {
		setBusy(true);
		setError(null);
		if (group.workId != null) {
			const result = await adminPost<{ objectsRestored: number; visibility: string }>(
				"/api/admin/quarantine/clear",
				{ workId: group.workId, note: note.trim() || undefined },
			);
			setBusy(false);
			if (!result.ok) {
				setError(result.error);
				return;
			}
			onCleared(
				`Work ${group.workId} is cleared: ${plural(result.data.objectsRestored, "object", "objects")} restored, and its visibility is back to ${result.data.visibility}.`,
			);
			return;
		}
		const result = await adminPost<{
			cleared: boolean;
			objectsRestored: number;
			storageKey: string;
		}>("/api/admin/quarantine/clear-object", {
			findingId: finding.id,
			note: note.trim() || undefined,
		});
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onCleared(
			result.data.objectsRestored > 0
				? `Cleared ${result.data.storageKey}, and the object is back at its original key.`
				: `Cleared ${result.data.storageKey}, but storage no longer held the object, so nothing was restored.`,
		);
	}

	return (
		<div className="mt-3 rounded-box border border-base-300 bg-base-200 p-3">
			<p className="text-sm text-base-content/80">
				{group.workId != null
					? "Clearing moves every object this Work owns back to its original key and restores the visibility the creator had chosen."
					: "Clearing moves this object back to its original key. Nothing that referenced it is repaired, so the uploader has to upload it again."}{" "}
				The preservation holds stay in place and are lifted separately under Legal Holds. The note
				below is kept beside the one recorded when the finding was placed.
			</p>
			<textarea
				className="textarea textarea-bordered mt-2 w-full"
				rows={2}
				maxLength={MODERATION_NOTE_MAX}
				placeholder="Why the finding was wrong"
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>
			{error && <p className="mt-2 text-sm text-error">{error}</p>}
			<div className="mt-2 flex gap-2">
				<button type="button" className="btn btn-sm btn-primary" onClick={clear} disabled={busy}>
					{busy ? "Clearing…" : "Confirm Clear"}
				</button>
				<button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</button>
			</div>
		</div>
	);
}

function FindingGroup({
	group,
	clearing,
	onStartClear,
	onCancelClear,
	onCleared,
}: {
	group: Group;
	clearing: boolean;
	onStartClear: () => void;
	onCancelClear: () => void;
	onCleared: (message: string) => void;
}) {
	const first = group.findings[0];
	const open = group.findings.some((f) => f.clearedAt == null);
	const uploaders = [
		...new Set(
			group.findings.map((f) =>
				f.uploaderName
					? `@${f.uploaderName}`
					: f.uploaderId == null
						? "an unknown account"
						: `account #${f.uploaderId}`,
			),
		),
	];

	return (
		<li
			className={`rounded-box border border-base-300 bg-base-100 p-4 ${open ? "" : "opacity-60"}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className={`badge badge-sm ${open ? "badge-error" : "badge-ghost"}`}>
					{open ? "Open" : "Cleared"}
				</span>
				<span className="font-medium">
					{group.workId != null
						? `${first.workTitle || "Untitled"} (Work #${group.workId})`
						: "Object with No Work"}
				</span>
				<span className="text-sm text-base-content/60">Uploaded by {uploaders.join(", ")}</span>
				{open && !clearing && (
					<button type="button" className="btn btn-xs btn-outline ml-auto" onClick={onStartClear}>
						Clear Finding
					</button>
				)}
			</div>

			<div className="mt-3 overflow-x-auto">
				<table className="table table-sm">
					<thead>
						<tr>
							<th>Object</th>
							<th>Storage Key</th>
							<th>Classification</th>
							<th>Source</th>
							<th>Placed</th>
							<th>Cleared</th>
						</tr>
					</thead>
					<tbody>
						{group.findings.map((f) => (
							<tr key={f.id} className={f.clearedAt ? "text-base-content/50" : ""}>
								<td>
									<span className="badge badge-sm badge-ghost">{f.objectKind}</span>
									<div className="text-xs text-base-content/50">Finding #{f.id}</div>
								</td>
								<td className="max-w-xs break-all font-mono text-xs">{f.originalKey}</td>
								<td className="text-sm">
									{f.classification}
									{f.note && <div className="text-xs italic text-base-content/60">“{f.note}”</div>}
								</td>
								<td className="text-sm">
									{SOURCE_NAMES[f.source] ?? f.source}
									{f.reportId != null && (
										<div className="text-xs text-base-content/60">Report #{f.reportId}</div>
									)}
								</td>
								<td className="whitespace-nowrap text-xs">
									{dateTime(f.placedAt)}
									<div className="text-base-content/60">{f.placedBy ?? "by a scan"}</div>
								</td>
								<td className="whitespace-nowrap text-xs">
									{f.clearedAt ? dateTime(f.clearedAt) : "—"}
									{f.clearedBy && <div className="text-base-content/60">{f.clearedBy}</div>}
									{f.clearedNote && (
										<div className="whitespace-normal italic text-base-content/60">
											“{f.clearedNote}”
										</div>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{clearing && <ClearPanel group={group} onCleared={onCleared} onCancel={onCancelClear} />}
		</li>
	);
}

export default function Quarantine() {
	const [showCleared, setShowCleared] = useState(false);
	const { data, loading, error, reload } = useAdminData<QuarantineResponse>(
		showCleared ? "/api/admin/quarantine?cleared=1" : "/api/admin/quarantine",
	);
	const [clearing, setClearing] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	function done(text: string) {
		setMessage(text);
		setClearing(null);
		void reload();
	}

	const groups = groupFindings(data?.findings ?? []);

	return (
		<div>
			<PageHeader
				title="Quarantine"
				description="Material taken out of reach of everybody, buyers included. Findings are shown as metadata and never as the material itself."
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{message && (
				<div role="status" className="alert alert-success mb-4">
					<span>{message}</span>
				</div>
			)}

			{data && (
				<div className="mb-8 grid grid-cols-3 gap-3">
					<StatCard title="Open Findings" value={String(data.summary.openFindings)} />
					<StatCard title="Works" value={String(data.summary.works)} />
					<StatCard title="Objects with No Work" value={String(data.summary.objects)} />
				</div>
			)}

			<section className="mb-10">
				<SectionHeading>Quarantine a Work by Hand</SectionHeading>
				<PlaceQuarantine onPlaced={done} onFailed={() => void reload()} />
			</section>

			<section>
				<div className="mb-3 flex items-center justify-between gap-4">
					<h2 className="text-lg font-semibold">Findings</h2>
					<label className="flex cursor-pointer items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="toggle toggle-sm"
							checked={showCleared}
							onChange={(e) => setShowCleared(e.target.checked)}
						/>
						Show Cleared Findings
					</label>
				</div>
				{loading && !data ? (
					<Loading />
				) : groups.length === 0 ? (
					<p className="text-sm text-base-content/60">
						{showCleared ? "Nothing has ever been quarantined." : "No finding is open."}
					</p>
				) : (
					<ul className="flex flex-col gap-3">
						{groups.map((group) => (
							<FindingGroup
								key={group.key}
								group={group}
								clearing={clearing === group.key}
								onStartClear={() => {
									setMessage(null);
									setClearing(group.key);
								}}
								onCancelClear={() => setClearing(null)}
								onCleared={done}
							/>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
