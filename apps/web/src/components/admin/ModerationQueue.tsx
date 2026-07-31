// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation queue — the operator's half of the surface, and the ops console's
 * first mutating control.
 *
 * Four views over one list. "Reported" is the queue proper; "Comments" and
 * "Reviews" are recent activity so an operator can act on something nobody
 * flagged; "Hidden" is how a takedown gets found again and reversed.
 *
 * Two outcomes, kept distinct on purpose. **Hide** takes the content down and
 * records why. **Dismiss** clears the reports and leaves the content alone — the
 * "I looked, it's fine" answer. Without it the only way to empty the queue would
 * be to take things down, which is a queue that teaches the wrong reflex.
 *
 * Nothing here deletes. Hiding is a state transition on the row; the content, its
 * author and its timestamps survive it, which is what keeps appeals and
 * creator-side moderation later features rather than later migrations.
 */

import {
	MODERATION_NOTE_MAX,
	MODERATION_REASONS,
	type ModerationSubjectType,
	moderationReasonLabel,
} from "@anthers/shared/moderation";
import { client } from "@anthers/web-shared/rpc";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

// ── Response shapes (mirror apps/api/src/services/moderation.ts) ─────────────
interface QueueItem {
	subjectType: ModerationSubjectType;
	subjectId: number;
	excerpt: string;
	score: number | null;
	moderationStatus: string;
	createdAt: string;
	author: { id: number; username: string } | null;
	post: { slug: string; title: string } | null;
	openReports: number;
	totalReports: number;
	reasons: string[];
	details: string[];
	lastAction: {
		action: string;
		reason: string;
		note: string;
		createdAt: string;
		actor: string | null;
	} | null;
}

interface QueueResponse {
	filter: string;
	items: QueueItem[];
	summary: {
		openReports: number;
		reportedSubjects: number;
		hiddenComments: number;
		hiddenRatings: number;
	};
}

const FILTERS = [
	{ value: "reported", label: "Reported" },
	{ value: "comments", label: "Comments" },
	{ value: "ratings", label: "Reviews" },
	{ value: "hidden", label: "Hidden" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

function SummaryChip({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
	return (
		<div className="rounded-box border border-base-300 bg-base-100 px-4 py-2">
			<div className="text-xs uppercase tracking-wide text-base-content/50">{label}</div>
			<div
				className={`text-xl font-semibold tabular-nums ${alert && value > 0 ? "text-warning" : ""}`}
			>
				{value.toLocaleString()}
			</div>
		</div>
	);
}

export default function ModerationQueue() {
	const [filter, setFilter] = useState<Filter>("reported");
	const [data, setData] = useState<QueueResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	/** The item a hide is being composed for — hiding always captures a reason. */
	const [hiding, setHiding] = useState<QueueItem | null>(null);
	const [hideReason, setHideReason] = useState("");
	const [hideNote, setHideNote] = useState("");
	const [acting, setActing] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await client.api.admin.moderation.$get({ query: { filter } });
			if (!res.ok) {
				setError("Failed to load the moderation queue.");
				return;
			}
			setData((await res.json()) as unknown as QueueResponse);
		} catch {
			setError("Failed to load the moderation queue.");
		} finally {
			setLoading(false);
		}
	}, [filter]);

	useEffect(() => {
		load();
	}, [load]);

	const confirmHide = async () => {
		if (!hiding || !hideReason) return;
		setActing(true);
		try {
			const res = await client.api.admin.moderation.hide.$post({
				json: {
					subjectType: hiding.subjectType,
					subjectId: hiding.subjectId,
					reason: hideReason,
					note: hideNote.trim() || undefined,
				},
			});
			if (!res.ok) {
				setError("That item couldn't be hidden.");
				return;
			}
			setHiding(null);
			setHideReason("");
			setHideNote("");
			await load();
		} finally {
			setActing(false);
		}
	};

	const act = async (item: QueueItem, action: "restore" | "dismiss") => {
		setActing(true);
		try {
			const endpoint =
				action === "restore"
					? client.api.admin.moderation.restore.$post
					: client.api.admin.moderation.dismiss.$post;
			const res = await endpoint({
				json: { subjectType: item.subjectType, subjectId: item.subjectId },
			});
			if (!res.ok) {
				setError(`That item couldn't be ${action === "restore" ? "restored" : "dismissed"}.`);
				return;
			}
			await load();
		} finally {
			setActing(false);
		}
	};

	return (
		<section>
			<div className="mb-3 flex items-center justify-between gap-4">
				<h2 className="text-lg font-semibold">Moderation</h2>
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

			{data && (
				<div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<SummaryChip label="Open reports" value={data.summary.openReports} alert />
					<SummaryChip label="Items reported" value={data.summary.reportedSubjects} alert />
					<SummaryChip label="Hidden comments" value={data.summary.hiddenComments} />
					<SummaryChip label="Hidden ratings" value={data.summary.hiddenRatings} />
				</div>
			)}

			<div role="tablist" className="tabs tabs-box mb-3 w-fit">
				{FILTERS.map((f) => (
					<button
						key={f.value}
						type="button"
						role="tab"
						className={`tab ${filter === f.value ? "tab-active" : ""}`}
						onClick={() => setFilter(f.value)}
					>
						{f.label}
					</button>
				))}
			</div>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			{data && data.items.length === 0 ? (
				<p className="text-sm text-base-content/60">
					{filter === "reported"
						? "Nothing reported. The queue is empty."
						: filter === "hidden"
							? "Nothing is hidden."
							: "Nothing here yet."}
				</p>
			) : (
				<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Content</th>
								<th>Author</th>
								<th>Reports</th>
								<th>State</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data?.items.map((item) => (
								<tr key={`${item.subjectType}:${item.subjectId}`}>
									<td className="max-w-md">
										<div className="flex items-center gap-2">
											<span className="badge badge-sm badge-ghost">{item.subjectType}</span>
											<span className="text-xs text-base-content/50">
												{new Date(item.createdAt).toLocaleDateString()}
											</span>
										</div>
										<div className="mt-1 text-sm break-words">{item.excerpt}</div>
										{item.post && (
											<a
												href={`/posts/${item.post.slug}`}
												target="_blank"
												rel="noopener noreferrer"
												className="link link-hover text-xs text-base-content/50"
											>
												on “{item.post.title}”
											</a>
										)}
									</td>
									<td className="text-sm">{item.author?.username ?? "—"}</td>
									<td>
										{item.totalReports === 0 ? (
											<span className="text-base-content/40">—</span>
										) : (
											<>
												<div className="text-sm tabular-nums">
													{item.openReports > 0 ? (
														<span className="font-semibold text-warning">
															{item.openReports} open
														</span>
													) : (
														<span className="text-base-content/50">{item.totalReports} closed</span>
													)}
												</div>
												<div className="text-xs text-base-content/60">
													{item.reasons.map(moderationReasonLabel).join(", ")}
												</div>
												{item.details.map((d) => (
													<div key={d} className="text-xs italic text-base-content/50">
														“{d}”
													</div>
												))}
											</>
										)}
									</td>
									<td>
										{item.moderationStatus === "hidden" ? (
											<>
												<span className="badge badge-sm badge-error">hidden</span>
												{item.lastAction && (
													<div className="mt-1 text-xs text-base-content/50">
														{moderationReasonLabel(item.lastAction.reason)} · by{" "}
														{item.lastAction.actor ?? "unknown"}
														{item.lastAction.note && (
															<span className="block italic">“{item.lastAction.note}”</span>
														)}
													</div>
												)}
											</>
										) : (
											<span className="badge badge-sm badge-ghost">visible</span>
										)}
									</td>
									<td className="whitespace-nowrap text-right">
										{item.moderationStatus === "hidden" ? (
											<button
												type="button"
												className="btn btn-xs btn-ghost"
												disabled={acting}
												onClick={() => act(item, "restore")}
											>
												Restore
											</button>
										) : (
											<button
												type="button"
												className="btn btn-xs btn-error btn-outline"
												disabled={acting}
												onClick={() => {
													setHiding(item);
													setHideReason(item.reasons[0] ?? "");
													setHideNote("");
												}}
											>
												Hide
											</button>
										)}
										{item.openReports > 0 && (
											<button
												type="button"
												className="btn btn-xs btn-ghost ml-1"
												disabled={acting}
												onClick={() => act(item, "dismiss")}
												title="Clear the reports, leave the content up"
											>
												Dismiss
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Hiding always captures a reason — an unexplained takedown is the thing
			    the record exists to prevent. Pre-filled from the reporters' reason
			    when there is one, but the operator's own choice is what's stored. */}
			{hiding && (
				<div className="modal modal-open">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Hide this {hiding.subjectType}?</h3>
						<p className="py-2 text-sm text-base-content/70">
							It stops appearing anywhere it's read. The row isn't deleted — this is recorded and
							reversible.
						</p>
						<blockquote className="my-2 border-l-2 border-base-300 pl-3 text-sm text-base-content/60">
							{hiding.excerpt}
						</blockquote>

						<select
							className="select select-bordered w-full"
							value={hideReason}
							onChange={(e) => setHideReason(e.target.value)}
						>
							<option value="">Reason…</option>
							{MODERATION_REASONS.map((r) => (
								<option key={r.value} value={r.value}>
									{r.label}
								</option>
							))}
						</select>

						<textarea
							className="textarea textarea-bordered mt-2 w-full"
							rows={2}
							maxLength={MODERATION_NOTE_MAX}
							placeholder="Note for the record (optional)"
							value={hideNote}
							onChange={(e) => setHideNote(e.target.value)}
						/>

						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setHiding(null)}
								disabled={acting}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmHide}
								disabled={acting || !hideReason}
							>
								{acting ? "Hiding..." : "Hide"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setHiding(null)}
						aria-label="Close"
					/>
				</div>
			)}
		</section>
	);
}
