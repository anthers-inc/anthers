// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation queue — the operator's half of the surface, and the ops console's
 * first mutating control.
 *
 * Five views over one list. "Reported" is the queue proper; "Comments" and
 * "Reviews" are recent activity so an operator can act on something nobody
 * flagged; "People" is reported accounts; "Hidden" is how a takedown gets found
 * again and reversed.
 *
 * "People" is deliberately NOT a browse the way Comments and Reviews are — it shows
 * reported accounts only. "Every account, newest first" is a user directory, and
 * reading one under a moderation header invites acting on somebody nobody complained
 * about.
 *
 * Two outcomes, kept distinct on purpose. **Hide** takes the content down and
 * records why. **Dismiss** clears the reports and leaves the content alone — the
 * "I looked, it's fine" answer. Without it the only way to empty the queue would
 * be to take things down, which is a queue that teaches the wrong reflex.
 *
 * **A reported person can only be dismissed**, and the row says so rather than
 * offering a disabled button with no explanation. Hiding an account is suspension,
 * which has to answer what becomes of their Works, their buyers' purchases, the
 * support pointed at them and any payout in flight — none of it decided. So the
 * operator acts out of band and the console is honest about that being the case.
 *
 * Nothing here deletes. Hiding is a state transition on the row; the content, its
 * author and its timestamps survive it, which is what keeps appeals and
 * creator-side moderation later features rather than later migrations.
 */

import {
	type DeclarableMaturity,
	MATURITY_CHOICES,
	maturityLabel,
} from "@anthers/shared/content-rating";
import {
	MODERATION_NOTE_MAX,
	MODERATION_REASON_GROUPS,
	type ModerationSubjectType,
	moderationReasonLabel,
	reasonsInGroup,
} from "@anthers/shared/moderation";
import { apiFetch, client } from "@anthers/web-shared/rpc";
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
	/**
	 * Where the item lives. `kind` matters: a comment can sit on a Post or a Work, a
	 * review only on a Work, and a reported person on their own profile — linking every
	 * one of them to /posts/ would send the operator to a 404 for most of the queue.
	 */
	context: { kind: "post" | "work" | "profile"; slug: string; title: string } | null;
	/** False for a person. The server decides this; the row must not guess at it. */
	moderatable: boolean;
	/** The Work's content rating, on a reported Work and nowhere else. */
	maturity?: string | null;
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
		reportedPeople: number;
		hiddenComments: number;
		hiddenRatings: number;
	};
}

const FILTERS = [
	{ value: "reported", label: "Reported" },
	{ value: "comments", label: "Comments" },
	{ value: "ratings", label: "Reviews" },
	{ value: "people", label: "People" },
	{ value: "hidden", label: "Hidden" },
] as const;

/** Where an operator goes to look at this item. A profile is the bare `/:username`. */
function contextHref(context: NonNullable<QueueItem["context"]>): string {
	if (context.kind === "profile") return `/${context.slug}`;
	return `/${context.kind === "work" ? "works" : "posts"}/${context.slug}`;
}

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

	/**
	 * Correct a reported Work's rating.
	 *
	 * The one thing an operator can do to a Work from this queue. Hiding is a takedown or a
	 * quarantine, each with its own service, its own record and its own reasons — which is
	 * why `moderatable` is false here and the row offers this instead of a disabled button.
	 *
	 * ⚠️ **Two standing principles bound this call and neither is the operator's to
	 * overturn**: a queer person existing in a story does not make it Mature, and subject
	 * matter is not the same as treatment. Wiki 40.13. The creator can appeal, and the
	 * appeal queue on this page is where that lands.
	 */
	const correctRating = async (item: QueueItem, maturity: DeclarableMaturity) => {
		setActing(true);
		try {
			const res = await apiFetch("/api/admin/works/rating", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ workId: item.subjectId, maturity }),
			});
			if (!res.ok) {
				// The server's own sentence, when it has one. A correction can be refused
				// for a reason the operator needs to act on — moving a Work to Adult takes
				// the working group rather than one person — and "that couldn't be set"
				// would send them looking for a bug instead.
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error || "That rating couldn't be set.");
				return;
			}
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

			{/* "People reported" gets its own chip rather than folding into "Items
			    reported", because it is the one bucket with no in-app remedy — clearing it
			    means acting somewhere other than this console, so an operator needs to see
			    it separately to know it is there at all. */}
			{data && (
				<div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
					<SummaryChip label="Open reports" value={data.summary.openReports} alert />
					<SummaryChip label="Items reported" value={data.summary.reportedSubjects} alert />
					<SummaryChip label="People reported" value={data.summary.reportedPeople} alert />
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
							: filter === "people"
								? "Nobody has been reported."
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
										{item.context && (
											<a
												href={contextHref(item.context)}
												target="_blank"
												rel="noopener noreferrer"
												className="link link-hover text-xs text-base-content/50"
											>
												{item.context.kind === "profile"
													? "open their profile"
													: `on “${item.context.title}”`}
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
										{!item.moderatable ? (
											<span
												className="badge badge-sm badge-ghost"
												title="Suspending an account isn't built — act out of band."
											>
												account
											</span>
										) : item.moderationStatus === "hidden" ? (
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
										{/* The rating correction. It sits under the state badge rather than
										    beside Hide because it is not a removal — a Work rated too low is
										    rated wrongly, not against the rules, and offering the two beside
										    each other invites the harsher one. `maturity` is present on a
										    reported Work and nowhere else, which is what scopes this. */}
										{item.maturity != null && (
											<div className="mt-2">
												<div className="text-xs text-base-content/50">
													rated {maturityLabel(item.maturity)}
												</div>
												<div className="mt-1 flex flex-wrap gap-1">
													{MATURITY_CHOICES.map((choice) => (
														<button
															key={choice.value}
															type="button"
															className={`btn btn-xs ${
																item.maturity === choice.value ? "btn-primary" : "btn-ghost"
															}`}
															disabled={acting || item.maturity === choice.value}
															// ⚠️ Adult says what it DOES, not just what it means.
															// The correction closes the Work's free public access
															// as part of the same act, and an operator who is not
															// told that is taking an action they did not know they
															// were taking.
															title={
																choice.value === "adult"
																	? "Rate this Adult. Adult work can't be free, so this also closes its free public access — the creator is notified and can appeal."
																	: `Correct this Work's rating to ${choice.label}`
															}
															onClick={() => correctRating(item, choice.value)}
														>
															{choice.label}
														</button>
													))}
												</div>
											</div>
										)}
									</td>
									<td className="whitespace-nowrap text-right">
										{/* A person gets no hide button, and a sentence instead of a disabled
										    control — "grayed out with no explanation" reads as a bug, and this
										    is a decision. Dismiss below is still offered: it is the one
										    outcome that exists for a reported account. */}
										{!item.moderatable ? (
											<span className="text-xs text-base-content/50">
												Act out of band — no account action exists
											</span>
										) : item.moderationStatus === "hidden" ? (
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
							{/* Grouped the same way the reporter's picker is. An operator recording
							    why something came down is choosing from the same vocabulary a
							    reporter chose from, and a flat list here would be the one place on
							    the platform that still presents spam and a crime as peers. */}
							{MODERATION_REASON_GROUPS.map((group) => (
								<optgroup key={group.key} label={group.heading.toUpperCase()}>
									{reasonsInGroup(group.key).map((r) => (
										<option key={r.value} value={r.value}>
											{r.label}
										</option>
									))}
								</optgroup>
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
