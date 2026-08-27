// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Check your email" — the six-box code field in a modal.
 *
 * ⚠️ **The field itself is `EmailCodeForm`**, split out on 2026-08-26 when a third caller
 * appeared that is not a modal: the page that finishes a signup asks for the code in place.
 * What remains here is the layer and its copy, which is all this ever really was.
 *
 * `/login` is the caller that still wants a modal — its card has botanical flourishes
 * reaching about seven rems in from each corner, so there is no room for an inline field.
 *
 * What the caller owns is the outcome: `onSubmit` spends the code however its flow spends
 * it and **throws an `Error` whose message is shown in the field** when it doesn't work.
 * This component never navigates, never touches the auth context, and never decides what
 * a verified address means.
 */

import { useState } from "react";
import EmailCodeForm, { CODE_LENGTH } from "./EmailCodeForm";

interface Props {
	/** Small caps label above the heading ("Step 1 of 2", "Verify your email", …). */
	stepLabel: string;
	/** The sentence under the heading. Says what happens when the code is accepted. */
	lede: React.ReactNode;
	/** Submit button label. */
	cta: string;
	/** Label while the code is in flight. */
	busyLabel: string;
	/**
	 * Spend the code. Resolve on success — the caller takes it from here — or throw an
	 * `Error` whose message is what the person reading the field should be told.
	 */
	onSubmit: (code: string) => Promise<void>;
	/** Ask for another code. Whatever this does, it must not report whether it worked. */
	onResend: () => Promise<void>;
	onClose: () => void;
}

export default function EmailCodeModal({
	stepLabel,
	lede,
	cta,
	busyLabel,
	onSubmit,
	onResend,
	onClose,
}: Props) {
	/*
	 * ⚠️ **The backdrop has to know the code is in flight, and only the field does.** A
	 * modal dismissed mid-verification leaves the caller's success handler running against
	 * something nobody is looking at — the account gets made and the person is back on the
	 * page they started from, with no explanation. Wrapping `onSubmit` mirrors the field's
	 * own busy state without a second copy of the field, which is the thing that must not be
	 * duplicated. A throw is re-thrown, because the message belongs to the field.
	 */
	const [busy, setBusy] = useState(false);
	const submit = async (code: string) => {
		setBusy(true);
		try {
			await onSubmit(code);
		} catch (err) {
			setBusy(false);
			throw err;
		}
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<p className="text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
					{stepLabel}
				</p>
				<h3 className="mt-1 text-xl font-bold">Check your email</h3>
				<p className="mt-2 mb-5 text-sm text-base-content/70">{lede}</p>

				<EmailCodeForm
					cta={cta}
					busyLabel={busyLabel}
					onSubmit={submit}
					onResend={onResend}
					secondary={{ label: "Cancel", onClick: onClose }}
				/>
			</div>
			<button
				type="button"
				className="modal-backdrop"
				onClick={onClose}
				aria-label="Close"
				disabled={busy}
			/>
		</div>
	);
}

export { CODE_LENGTH };
