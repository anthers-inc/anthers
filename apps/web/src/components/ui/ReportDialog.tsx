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
 */

import {
	MODERATION_REASONS,
	type ModerationSubjectType,
	REPORT_DETAILS_MAX,
} from "@anthers/shared/moderation";
import { client } from "@anthers/web-shared/rpc";
import { useState } from "react";

interface ReportDialogProps {
	subjectType: ModerationSubjectType;
	subjectId: number;
	/** What the reader is reporting, named in their words ("this comment"). */
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
	const [details, setDetails] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		if (!reason) return;
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
			<div className="modal-box">
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
				) : (
					<>
						<h3 className="text-lg font-bold">Report {label}</h3>
						<p className="pt-2 pb-3 text-sm text-base-content/70">What's wrong with it?</p>

						<div className="flex flex-col gap-1">
							{MODERATION_REASONS.map((r) => (
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
										onChange={() => setReason(r.value)}
									/>
									<span>
										<span className="block text-sm font-medium">{r.label}</span>
										<span className="block text-xs text-base-content/50">{r.hint}</span>
									</span>
								</label>
							))}
						</div>

						<textarea
							className="textarea textarea-bordered mt-3 w-full"
							rows={3}
							maxLength={REPORT_DETAILS_MAX}
							placeholder="Anything else we should know? (optional)"
							value={details}
							onChange={(e) => setDetails(e.target.value)}
						/>

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
								disabled={submitting || !reason}
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
