// SPDX-License-Identifier: AGPL-3.0-or-later

interface Props {
	/** The plan being canceled (kept until the period ends). */
	planName: string;
	/** When the plan reverts to Free (unix seconds), if known. */
	revertUnix: number | null;
	processing: boolean;
	onConfirm: () => void;
	onClose: () => void;
}

export default function CancelConfirmModal({
	planName,
	revertUnix,
	processing,
	onConfirm,
	onClose,
}: Props) {
	const date = revertUnix
		? new Date(revertUnix * 1000).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<h3 className="font-bold text-lg mb-2">Cancel your {planName} plan?</h3>
				<p className="text-sm text-base-content/70">
					You'll keep {planName} {date ? `until ${date}` : "until the current period ends"}, then
					your plan reverts to <strong>Free</strong>. Nothing is charged now, and you can resume
					anytime before then.
				</p>
				<div className="flex gap-2 justify-end mt-5">
					<button type="button" className="btn btn-ghost" onClick={onClose} disabled={processing}>
						Keep plan
					</button>
					<button type="button" className="btn btn-error" onClick={onConfirm} disabled={processing}>
						{processing ? "Canceling…" : "Cancel plan"}
					</button>
				</div>
			</div>
			<button
				type="button"
				className="modal-backdrop"
				onClick={onClose}
				aria-label="Close"
				disabled={processing}
			/>
		</div>
	);
}
