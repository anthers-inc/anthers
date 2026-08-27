// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Report dialog — the reader's half of the moderation surface.
 *
 * Deliberately says nothing about what happens next. Whether the item is already
 * reported, already hidden, or was already looked at and dismissed is operator
 * information, and reflecting it back here would turn a report button into a way
 * to probe moderation state. Every successful report gets the same acknowledgement.
 *
 * The reason list comes from `@anthers/shared/moderation`, the same module the
 * API validates against, so the radio buttons can't drift from what the server
 * will accept.
 *
 * 🚨 **The two groups are legal versus rule-breaking, and not urgent versus not.**
 * Everything under the first heading is against the law and is not up for discussion,
 * debate or discretion on Anthers, which is a fact about the *kind of thing* rather than
 * about how fast it is handled — urgency is carried by the ordering inside each group and
 * by the subtitles saying so. A picker sorted by urgency would be asking the reporter to
 * rank a threat against a piece of pornography, which is not their judgment to make.
 *
 * ⚠️ **The confirmation on "Pornographic material" is not decoration.** Splitting the old
 * single sexual reason in two made it possible for a reporter to file something involving a
 * minor as a rule-break; three things stop that, and this is the one with teeth. Its control
 * **switches the selection** rather than only warning, because a warning a reporter reads
 * and dismisses leaves the misfiled report filed.
 */

import {
	MODERATION_REASON_GROUPS,
	MODERATION_REASONS,
	type ModerationSubjectType,
	REPORT_DETAILS_MAX,
	reasonsInGroup,
	reportRequiresDetails,
} from "@anthers/shared/moderation";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useState } from "react";

interface ReportDialogProps {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** What the reader is reporting, named in their words ("this comment", "@ada"). */
	label: string;
	onClose: () => void;
}

export default function ReportDialog({
	subjectType,
	subjectId,
	label,
	onClose,
}: ReportDialogProps) {
	const [reason, setReason] = useState<string>("");
	/** The reason whose confirmation is on screen — nothing else is reachable until it is answered. */
	const [confirming, setConfirming] = useState<string | null>(null);
	const [details, setDetails] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reporting a PERSON has to say where to look. A comment is its own evidence — an
	// operator opens it and sees what the reporter saw — while "harassment" against an
	// account names no artifact at all. Read from the shared module rather than
	// branching on `subjectType` here, so the client and the API can't disagree about
	// which subjects need it.
	const detailsRequired = reportRequiresDetails(subjectType);
	const detailsOk = !detailsRequired || details.trim().length > 0;

	/**
	 * Pick a reason, or hold it behind its confirmation.
	 *
	 * The selection is NOT set while the confirmation is open. Setting it and asking
	 * afterwards would mean a reporter who closes the dialog at that moment has still chosen
	 * the reason the question exists to move them off.
	 */
	const choose = (value: string) => {
		const chosen = MODERATION_REASONS.find((r) => r.value === value);
		if (chosen?.confirm) {
			setConfirming(value);
			return;
		}
		setReason(value);
	};

	const confirmingReason = MODERATION_REASONS.find((r) => r.value === confirming);

	const submit = async () => {
		if (!reason || !detailsOk) return;
		setSubmitting(true);
		setError(null);
		try {
			const res = await client.api.moderation.reports.$post({
				json: { subjectType, subjectId, reason, details: details.trim() || undefined },
			});
			if (!res.ok) {
				setError("That report couldn't be sent. Please try again.");
				return;
			}
			setSent(true);
		} catch {
			setError("That report couldn't be sent. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-h-[85vh] overflow-y-auto">
				{sent ? (
					<>
						<h3 className="text-lg font-bold">Thanks — that's with us</h3>
						<p className="py-3 text-sm text-base-content/70">
							An operator will read it. We don't share what happens to individual reports, so you
							won't get an update on this one.
						</p>
						<div className="modal-action">
							<button type="button" className="btn btn-primary" onClick={onClose}>
								Done
							</button>
						</div>
					</>
				) : confirmingReason?.confirm ? (
					<>
						{/* The interstitial. It replaces the picker rather than sitting beside it,
						    so the question has to be answered rather than scrolled past. */}
						<h3 className="text-lg font-bold">One question first</h3>
						<p className="py-3 text-sm text-base-content/80">{confirmingReason.confirm.question}</p>
						{/* Stacked rather than laid out in a row. Both labels are sentences — they
						    have to be, because a two-word button here would be answering a question
						    about a child with a shrug — and `modal-action`'s default row pushes the
						    first one off the left edge of the box at every width the modal has. */}
						<div className="modal-action flex-col items-stretch gap-2">
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => {
									setReason(confirmingReason.confirm!.switchTo);
									setConfirming(null);
								}}
							>
								{confirmingReason.confirm.switchLabel}
							</button>
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => {
									setReason(confirmingReason.value);
									setConfirming(null);
								}}
							>
								{confirmingReason.confirm.keepLabel}
							</button>
						</div>
					</>
				) : (
					<>
						<h3 className="text-lg font-bold">Report {label}</h3>
						<p className="pt-2 pb-3 text-sm text-base-content/70">
							{detailsRequired ? "What's going on?" : "What's wrong with it?"}
						</p>

						{detailsRequired && (
							<p className="pb-3 text-sm text-base-content/60">
								Reporting someone is separate from blocking them. If you just want them gone from
								your view, block them — that takes effect straight away and nobody reviews it.
							</p>
						)}

						{MODERATION_REASON_GROUPS.map((group) => (
							<div key={group.key} className="mb-4">
								{/* Title-cased in the data and shouted in the styling: the heading is
								    copy and takes the copy rule, while the emphasis is presentation. */}
								<h4 className="text-xs font-bold uppercase tracking-wide text-base-content/70">
									{group.heading}
								</h4>
								<p className="mb-2 text-xs text-base-content/50">{group.subtitle}</p>
								<div className="flex flex-col gap-1">
									{reasonsInGroup(group.key).map((r) => (
										<label
											key={r.value}
											className="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3 hover:border-primary/50"
										>
											<input
												type="radio"
												name="report-reason"
												className="radio radio-sm mt-0.5"
												value={r.value}
												checked={reason === r.value}
												onChange={() => choose(r.value)}
											/>
											<span>
												<span className="block text-sm font-medium">{r.label}</span>
												<span className="block text-xs text-base-content/50">{r.hint}</span>
											</span>
										</label>
									))}
								</div>
							</div>
						))}

						<textarea
							className="textarea textarea-bordered mt-1 w-full"
							rows={3}
							maxLength={REPORT_DETAILS_MAX}
							placeholder={
								detailsRequired
									? "What did they do, and where? An operator needs somewhere to look."
									: "Anything else we should know? (optional)"
							}
							value={details}
							onChange={(e) => setDetails(e.target.value)}
						/>
						{detailsRequired && (
							<p className="mt-1 text-xs text-base-content/50">
								Required — a report about a person doesn't come with anything to read.
							</p>
						)}

						{/* 🚨 Shown always, not conditionally on a reason. This is the surface somebody
						    uses when they are looking at a Work they recognise as their own, and the
						    moment to tell them there is a different process is before they pick a
						    reason that cannot deliver one. */}
						<p className="mt-3 text-xs text-base-content/60">
							<strong>Copyright is a different process.</strong> If work of yours is here without
							permission, nothing on this form can remove it — file a notice at{" "}
							<Link to="/copyright" className="link">
								Copyright
							</Link>{" "}
							instead.
						</p>

						{error && <p className="mt-2 text-sm text-error">{error}</p>}

						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={onClose}
								disabled={submitting}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary"
								onClick={submit}
								disabled={submitting || !reason || !detailsOk}
							>
								{submitting ? "Sending..." : "Send report"}
							</button>
						</div>
					</>
				)}
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close" />
		</div>
	);
}
