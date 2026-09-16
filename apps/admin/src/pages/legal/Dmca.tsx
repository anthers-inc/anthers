// SPDX-License-Identifier: Apache-2.0
/**
 * DMCA notices: the queue of copyright notices filed through the statutory intake, one notice's
 * full detail, and the four things an operator does with one.
 *
 * 🚨 **A user report is not a DMCA notice, and nothing here acts on reports.** A report that is
 * really a copyright complaint is routed out from the moderation queue, which answers the reporter
 * with this path and removes nothing. Only a notice carrying the § 512(c)(3) elements reaches here.
 *
 * Taking a Work down and restoring one each ask for confirmation, because each changes whether the
 * Work is delivered to anybody and each notifies or affects people outside this screen. Recording a
 * suit asks too, because it stops the automatic restore and there is no route that un-records it.
 *
 * Every clock shown is a stored timestamp from the API rather than a date computed here, since the
 * business-day arithmetic lives in `services/dmca.ts` and a second copy would drift from the dates
 * the creator and the complainant were actually told.
 */
import { MODERATION_NOTE_MAX } from "@anthers/shared/moderation";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";
import { useSession } from "../../lib/session";

type NoticeStatus =
	| "received"
	| "screening"
	| "actioned"
	| "rejected"
	| "counter_noticed"
	| "restored"
	| "withdrawn";

interface QueueItem {
	id: number;
	workId: number | null;
	status: NoticeStatus;
	complainantName: string;
	complainantEmail: string;
	receivedAt: string;
	actionedAt: string | null;
	counterNoticeFiledAt: string | null;
	counterNoticeDueBy: string | null;
	restoreNoEarlierThan: string | null;
	suitFiledAt: string | null;
	finalizedAt: string | null;
	finalizedReason: string;
	buyersRefunded: number;
	workTitle: string | null;
	workSlug: string | null;
	workPublicId: number | null;
	note: string;
}

interface QueueResponse {
	items: QueueItem[];
	summary: {
		received: number;
		screening: number;
		actioned: number;
		rejected: number;
		counterNoticed: number;
		restored: number;
		withdrawn: number;
		total: number;
	};
}

interface CounterNotice {
	subscriberName: string;
	subscriberAddress: string;
	subscriberPhone: string;
	jurisdictionConsent: string;
	goodFaithStatement: string;
	attestationTextSnapshot: string;
	filedAt: string;
}

interface NoticeDetail {
	notice: {
		id: number;
		workId: number | null;
		workTitle: string;
		complainantName: string;
		complainantEmail: string;
		complainantAddress: string;
		complainantPhone: string | null;
		copyrightedWorkDescription: string;
		infringingMaterialDescription: string;
		goodFaithStatement: string;
		authorizationStatement: string;
		fairUseConsidered: boolean;
		attestationTextSnapshot: string;
		status: NoticeStatus;
		receivedAt: string;
		actionedAt: string | null;
		rejectedAt: string | null;
		/** When the complainant was emailed the decision. Null on a decided notice means it did not go. */
		complainantNotifiedAt: string | null;
		counterNotice: CounterNotice | null;
		counterNoticeFiledAt: string | null;
		/** When the counter-notice copy reached the provider. Null beside a counter-notice is a step not taken. */
		counterNoticeForwardedAt: string | null;
		restoreNoEarlierThan: string | null;
		suitFiledAt: string | null;
		counterNoticeDueBy: string | null;
		finalizedAt: string | null;
		finalizedReason: string;
		buyersRefunded: number;
		note: string;
		redactedAt: string | null;
	};
	workTitle: string | null;
	workSlug: string | null;
	workPublicId: number | null;
	/** The restore window a counter-notice copy sent now would give, while one is unsent. */
	copyWindowIfSentNow: { from: string; by: string } | null;
}

const STATUS_NAMES: Record<NoticeStatus, string> = {
	received: "Received",
	screening: "Screening",
	actioned: "Taken Down",
	rejected: "Rejected",
	counter_noticed: "Counter-Noticed",
	restored: "Restored",
	withdrawn: "Withdrawn",
};

const STATUS_BADGES: Record<NoticeStatus, string> = {
	received: "badge-warning",
	screening: "badge-warning",
	actioned: "badge-error",
	rejected: "badge-ghost",
	counter_noticed: "badge-info",
	restored: "badge-success",
	withdrawn: "badge-ghost",
};

const TABS: { value: string; label: string; statuses: NoticeStatus[] | null }[] = [
	{ value: "decide", label: "Needs a Decision", statuses: ["received", "screening"] },
	{ value: "down", label: "Taken Down", statuses: ["actioned"] },
	{ value: "counter", label: "Counter-Noticed", statuses: ["counter_noticed"] },
	{ value: "closed", label: "Closed", statuses: ["rejected", "restored", "withdrawn"] },
	{ value: "all", label: "All", statuses: null },
];

type Action = "act" | "reject" | "restore" | "suit";

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function StatusBadge({ status }: { status: NoticeStatus }) {
	return <span className={`badge badge-sm ${STATUS_BADGES[status]}`}>{STATUS_NAMES[status]}</span>;
}

/** The clock that matters for a notice in its current state, as one line. */
function clockLine(n: {
	status: NoticeStatus;
	counterNoticeDueBy: string | null;
	restoreNoEarlierThan: string | null;
	suitFiledAt: string | null;
	finalizedAt: string | null;
	buyersRefunded: number;
}): string | null {
	if (n.suitFiledAt && (n.status === "actioned" || n.status === "counter_noticed")) {
		return `Suit recorded ${shortDate(n.suitFiledAt)}, so the automatic restore will not run.`;
	}
	if (n.status === "counter_noticed" && n.restoreNoEarlierThan) {
		return `Restores automatically on or after ${shortDate(n.restoreNoEarlierThan)}.`;
	}
	if (n.status === "actioned") {
		if (n.finalizedAt) {
			return `Final since ${shortDate(n.finalizedAt)}, with ${n.buyersRefunded} ${n.buyersRefunded === 1 ? "buyer" : "buyers"} refunded.`;
		}
		if (n.counterNoticeDueBy) {
			return `Counter-notice window closes ${shortDate(n.counterNoticeDueBy)}.`;
		}
	}
	return null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<div className="text-xs uppercase tracking-wide text-base-content/50">{label}</div>
			<div className="mt-0.5 whitespace-pre-wrap text-sm">{children}</div>
		</div>
	);
}

function WorkLabel({
	workId,
	title,
	slug,
	publicId,
}: {
	workId: number | null;
	title: string | null;
	slug: string | null;
	publicId: number | null;
}) {
	const { siteLink } = useSession();
	const name = title || "Untitled";
	if (workId == null) {
		return (
			<span>
				{name} <span className="text-xs text-base-content/50">(the Work has been deleted)</span>
			</span>
		);
	}
	if (!slug || publicId == null) return <span>{name}</span>;
	return (
		<a
			className="link"
			href={siteLink(`/works/${slug}-${publicId}`)}
			target="_blank"
			rel="noopener noreferrer"
		>
			{name}
		</a>
	);
}

const CONFIRM_COPY: Record<Action, { title: string; body: string; button: string; tone: string }> =
	{
		act: {
			title: "Take Down This Work?",
			body: "The Work stops being delivered to anybody, buyers included, and the creator is notified with the counter-notice route and what counter-noticing exposes. The complainant is emailed that their notice was acted on. The creator's counter-notice window starts now, and buyers are refunded only if it closes without a counter-notice.",
			button: "Take Down Work",
			tone: "btn-error",
		},
		reject: {
			title: "Reject This Notice?",
			body: "Rejecting leaves the Work untouched and emails the complainant the note below as the reason. Name what the notice lacked in words they can act on, since that email is the reach-back § 512(c)(3)(B)(ii) asks for when a notice substantially complies on elements (ii), (iii) and (iv).",
			button: "Reject Notice",
			tone: "btn-warning",
		},
		restore: {
			title: "Restore This Work Now?",
			body: "The Work is put back exactly as it was before the takedown, ahead of any scheduled restore. Use this when the complainant withdrew or the notice turned out to be defective.",
			button: "Restore Work",
			tone: "btn-primary",
		},
		suit: {
			title: "Record That the Complainant Filed Suit?",
			body: "Recording a court action under § 512(g)(2)(C) stops the automatic restore. No route un-records it, so record it only once the filing is confirmed.",
			button: "Record Suit",
			tone: "btn-warning",
		},
	};

/**
 * A counter-notice whose copy has not reached the complainant. The restore sweep holds the Work
 * down until it has, so this offers the two ways to settle it: another attempt through the email
 * provider, or recording a copy the operator sent from their own mailbox.
 */
function UnsentCopy({
	noticeId,
	complainantEmail,
	copyWindow,
	onSent,
}: {
	noticeId: number;
	complainantEmail: string;
	copyWindow: { from: string; by: string } | null;
	onSent: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function forward(sentByHand: boolean) {
		setBusy(true);
		setError(null);
		const result = await adminPost(`/api/admin/dmca/${noticeId}/forward`, { sentByHand });
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		await onSent();
	}

	return (
		<div className="rounded-box border border-error bg-base-100 p-4 text-sm">
			<p className="text-error">
				The counter-notice has not been forwarded to the complainant, because the email was not
				accepted. § 512(g)(2)(B) requires sending them a copy promptly, and the Work will not be
				restored until they have one.
			</p>
			{copyWindow && (
				<p className="mt-2">
					A copy sent today should say the material will be restored between{" "}
					{shortDate(copyWindow.from)} and {shortDate(copyWindow.by)}, unless they notify the
					designated agent of a court action first. Send it to{" "}
					{complainantEmail || "the complainant"}.
				</p>
			)}
			{error && <p className="mt-2 text-error">{error}</p>}
			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					className="btn btn-sm btn-primary"
					onClick={() => forward(false)}
					disabled={busy}
				>
					Send the Copy Again
				</button>
				<button
					type="button"
					className="btn btn-sm btn-outline"
					onClick={() => forward(true)}
					disabled={busy}
				>
					I Sent the Copy Myself
				</button>
			</div>
		</div>
	);
}

function Detail({
	id,
	onBack,
	onChanged,
}: {
	id: number;
	onBack: () => void;
	onChanged: () => void;
}) {
	const { data, loading, error, reload } = useAdminData<NoticeDetail>(`/api/admin/dmca/${id}`);
	const [pending, setPending] = useState<Action | null>(null);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	async function run(action: Action) {
		setBusy(true);
		setActionError(null);
		const result =
			action === "suit"
				? await adminPost(`/api/admin/dmca/${id}/suit`)
				: await adminPost(`/api/admin/dmca/${id}/${action}`, { note: note.trim() || undefined });
		setBusy(false);
		if (!result.ok) {
			setActionError(result.error);
			return;
		}
		setPending(null);
		setNote("");
		await reload();
		onChanged();
	}

	const n = data?.notice;
	const undecided = n?.status === "received" || n?.status === "screening";
	const down = n?.status === "actioned" || n?.status === "counter_noticed";
	const clock = n ? clockLine(n) : null;

	return (
		<div>
			<button type="button" className="btn btn-ghost btn-sm mb-4 gap-2" onClick={onBack}>
				<ArrowLeftIcon className="h-4 w-4" />
				Back to the Queue
			</button>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data &&
				n && (
					<div className="space-y-6">
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="text-2xl font-bold">Notice #{n.id}</h1>
							<StatusBadge status={n.status} />
						</div>
						{clock && <p className="text-sm text-base-content/70">{clock}</p>}

						<section className="rounded-box border border-base-300 bg-base-100 p-4">
							<SectionHeading>Actions</SectionHeading>
							{!undecided && !down ? (
								<p className="text-sm text-base-content/60">
									This notice is closed, so there is nothing left to act on.
								</p>
							) : pending ? (
								<div>
									<div className="font-semibold">{CONFIRM_COPY[pending].title}</div>
									<p className="mt-1 text-sm text-base-content/80">{CONFIRM_COPY[pending].body}</p>
									{pending === "restore" && n.suitFiledAt && (
										<p className="mt-2 text-sm text-warning">
											A suit is recorded on this notice. Restoring by hand overrides the stop that
											the suit put on the automatic restore.
										</p>
									)}
									{pending !== "suit" && (
										<textarea
											className="textarea textarea-bordered mt-3 w-full"
											rows={2}
											maxLength={MODERATION_NOTE_MAX}
											placeholder={
												pending === "reject"
													? "What the notice lacked. The complainant is emailed this as the reason."
													: "Note for the record (optional)"
											}
											value={note}
											onChange={(e) => setNote(e.target.value)}
										/>
									)}
									{actionError && <p className="mt-2 text-sm text-error">{actionError}</p>}
									<div className="mt-3 flex gap-2">
										<button
											type="button"
											className={`btn btn-sm ${CONFIRM_COPY[pending].tone}`}
											onClick={() => run(pending)}
											disabled={busy || (pending === "reject" && !note.trim())}
										>
											{busy ? "Working…" : CONFIRM_COPY[pending].button}
										</button>
										<button
											type="button"
											className="btn btn-sm btn-ghost"
											onClick={() => {
												setPending(null);
												setActionError(null);
											}}
											disabled={busy}
										>
											Cancel
										</button>
									</div>
								</div>
							) : (
								<div className="flex flex-wrap gap-2">
									{undecided && (
										<>
											<button
												type="button"
												className="btn btn-sm btn-error"
												onClick={() => setPending("act")}
												disabled={n.workId == null}
												title={
													n.workId == null
														? "The Work this notice named has been deleted"
														: undefined
												}
											>
												Take Down Work
											</button>
											<button
												type="button"
												className="btn btn-sm btn-outline"
												onClick={() => setPending("reject")}
											>
												Reject Notice
											</button>
										</>
									)}
									{down && (
										<button
											type="button"
											className="btn btn-sm btn-outline"
											onClick={() => setPending("restore")}
											disabled={n.workId == null}
										>
											Restore Work
										</button>
									)}
									{down && !n.suitFiledAt && (
										<button
											type="button"
											className="btn btn-sm btn-outline"
											onClick={() => setPending("suit")}
										>
											Record Suit
										</button>
									)}
								</div>
							)}
						</section>

						<section className="grid gap-4 rounded-box border border-base-300 bg-base-100 p-4 sm:grid-cols-2">
							<Field label="Work">
								<WorkLabel
									workId={n.workId}
									title={data.workTitle}
									slug={data.workSlug}
									publicId={data.workPublicId}
								/>
							</Field>
							<Field label="Complainant">
								{n.redactedAt ? (
									<span className="text-base-content/60">
										The complainant's name and contact details were removed on the retention
										schedule on {shortDate(n.redactedAt)}.
									</span>
								) : (
									<>
										{n.complainantName}
										{"\n"}
										<a className="link" href={`mailto:${n.complainantEmail}`}>
											{n.complainantEmail}
										</a>
										{n.complainantPhone ? `\n${n.complainantPhone}` : ""}
										{`\n${n.complainantAddress}`}
									</>
								)}
							</Field>
							<Field label="Copyrighted Work — (A)(ii)">{n.copyrightedWorkDescription}</Field>
							<Field label="Infringing Material — (A)(iii)">
								{n.infringingMaterialDescription}
							</Field>
							<Field label="Good-Faith Statement — (A)(v)">{n.goodFaithStatement}</Field>
							<Field label="Authorization Statement — (A)(vi)">{n.authorizationStatement}</Field>
							<Field label="Fair Use Considered">{n.fairUseConsidered ? "Yes" : "No"}</Field>
							{n.note && <Field label="Operator Note">{n.note}</Field>}
						</section>

						<details className="rounded-box border border-base-300 bg-base-100 p-4">
							<summary className="cursor-pointer text-sm font-medium">
								Attestation as Shown to the Complainant
							</summary>
							<p className="mt-2 whitespace-pre-wrap text-sm text-base-content/80">
								{n.attestationTextSnapshot}
							</p>
						</details>

						{n.counterNotice && !n.counterNoticeForwardedAt && (
							<UnsentCopy
								noticeId={n.id}
								complainantEmail={n.complainantEmail}
								copyWindow={data.copyWindowIfSentNow}
								onSent={async () => {
									await reload();
									onChanged();
								}}
							/>
						)}
						{(n.status === "actioned" || n.status === "rejected") && !n.complainantNotifiedAt && (
							<p className="rounded-box border border-warning bg-base-100 p-4 text-sm text-warning">
								The complainant was not emailed this decision, because the email was not accepted.
								Tell {n.complainantEmail || "them"} the outcome another way.
							</p>
						)}

						{n.counterNotice && (
							<section className="grid gap-4 rounded-box border border-base-300 bg-base-100 p-4 sm:grid-cols-2">
								<div className="sm:col-span-2">
									<SectionHeading>Counter-Notice</SectionHeading>
								</div>
								<Field label="Subscriber">
									{`${n.counterNotice.subscriberName}\n${n.counterNotice.subscriberPhone}\n${n.counterNotice.subscriberAddress}`}
								</Field>
								<Field label="Filed">{shortDate(n.counterNotice.filedAt)}</Field>
								<Field label="Good-Faith Statement">{n.counterNotice.goodFaithStatement}</Field>
								<Field label="Jurisdiction Consent">{n.counterNotice.jurisdictionConsent}</Field>
							</section>
						)}

						<section className="rounded-box border border-base-300 bg-base-100 p-4">
							<SectionHeading>Timeline</SectionHeading>
							<ul className="space-y-1 text-sm">
								<li>Received {shortDate(n.receivedAt)}</li>
								{n.rejectedAt && <li>Rejected {shortDate(n.rejectedAt)}</li>}
								{n.actionedAt && <li>Taken down {shortDate(n.actionedAt)}</li>}
								{n.complainantNotifiedAt && (
									<li>Complainant emailed the decision {shortDate(n.complainantNotifiedAt)}</li>
								)}
								{n.counterNoticeDueBy && (
									<li>Counter-notice window closes {shortDate(n.counterNoticeDueBy)}</li>
								)}
								{n.counterNoticeFiledAt && (
									<li>Counter-notice filed {shortDate(n.counterNoticeFiledAt)}</li>
								)}
								{n.counterNoticeForwardedAt && (
									<li>
										Counter-notice forwarded to the complainant{" "}
										{shortDate(n.counterNoticeForwardedAt)}
									</li>
								)}
								{n.restoreNoEarlierThan && (
									<li>Automatic restore no earlier than {shortDate(n.restoreNoEarlierThan)}</li>
								)}
								{n.suitFiledAt && <li>Suit recorded {shortDate(n.suitFiledAt)}</li>}
								{n.finalizedAt && (
									<li>
										Final {shortDate(n.finalizedAt)}
										{n.finalizedReason === "conceded" ? " (the creator conceded)" : ""}, with{" "}
										{n.buyersRefunded} {n.buyersRefunded === 1 ? "buyer" : "buyers"} refunded
									</li>
								)}
							</ul>
						</section>
					</div>
				)
			)}
		</div>
	);
}

export default function Dmca() {
	const { data, loading, error, reload } = useAdminData<QueueResponse>("/api/admin/dmca");
	const [tab, setTab] = useState("decide");
	const [selected, setSelected] = useState<number | null>(null);

	if (selected != null) {
		return <Detail id={selected} onBack={() => setSelected(null)} onChanged={reload} />;
	}

	const statuses = TABS.find((t) => t.value === tab)?.statuses ?? null;
	const items = (data?.items ?? []).filter((item) => !statuses || statuses.includes(item.status));

	return (
		<div>
			<PageHeader
				title="DMCA Notices"
				description="Copyright notices filed through the DMCA intake. A user report is not a DMCA notice, and nothing on this screen acts on reports."
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}

			{data && (
				<div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
					<StatCard
						title="Needs a Decision"
						value={String(data.summary.received + data.summary.screening)}
					/>
					<StatCard title="Taken Down" value={String(data.summary.actioned)} />
					<StatCard title="Counter-Noticed" value={String(data.summary.counterNoticed)} />
					<StatCard title="Restored" value={String(data.summary.restored)} />
					<StatCard title="Rejected" value={String(data.summary.rejected)} />
				</div>
			)}

			<div role="tablist" className="tabs tabs-box mb-3 w-fit">
				{TABS.map((t) => (
					<button
						key={t.value}
						type="button"
						role="tab"
						className={`tab ${tab === t.value ? "tab-active" : ""}`}
						onClick={() => setTab(t.value)}
					>
						{t.label}
					</button>
				))}
			</div>

			{loading && !data ? (
				<Loading />
			) : items.length === 0 ? (
				<p className="text-sm text-base-content/60">No notice is in this state.</p>
			) : (
				<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Notice</th>
								<th>Work</th>
								<th>Complainant</th>
								<th>Received</th>
								<th>Clock</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{items.map((item) => (
								<tr key={item.id}>
									<td>
										<div className="tabular-nums">#{item.id}</div>
										<StatusBadge status={item.status} />
									</td>
									<td className="max-w-xs text-sm">
										<WorkLabel
											workId={item.workId}
											title={item.workTitle}
											slug={item.workSlug}
											publicId={item.workPublicId}
										/>
									</td>
									<td className="text-sm">
										{item.complainantName || (
											<span className="text-base-content/50">
												Removed on the retention schedule
											</span>
										)}
										<div className="text-xs text-base-content/60">{item.complainantEmail}</div>
									</td>
									<td className="whitespace-nowrap text-xs">{shortDate(item.receivedAt)}</td>
									<td className="max-w-xs text-xs text-base-content/70">
										{clockLine(item) ?? "—"}
									</td>
									<td className="text-right">
										<button
											type="button"
											className="btn btn-xs btn-outline"
											onClick={() => setSelected(item.id)}
										>
											Open
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
