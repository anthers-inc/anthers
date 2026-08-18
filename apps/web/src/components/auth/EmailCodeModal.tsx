// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Check your email" — the six-box code field, and nothing about why it opened.
 *
 * Two flows put a code in someone's inbox and ask them to type it back: the signup
 * ceremony on `/subscribe` (`SignupCeremonyModal`, which wraps this) and signing in with
 * an empty password field on `/login`. They differ in their copy and in which endpoint
 * spends the code, and in nothing else.
 *
 * 🚨 **The reason this is one component rather than two is the field, not the box around
 * it.** Six boxes look trivial and are not: the backspace handler and the refocus-after-a
 * -refusal effect below are both fixes for bugs that shipped, produced no error, and were
 * found by driving a browser. A second copy of this widget would agree with the original
 * right up until one of them was fixed again.
 *
 * What the caller owns is the outcome: `onSubmit` spends the code however its flow spends
 * it and **throws an `Error` whose message is shown in the field** when it doesn't work.
 * This component never navigates, never touches the auth context, and never decides what
 * a verified address means.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Length of the emailed code. Must match `CODE_LENGTH` in `services/signup-codes.ts`. */
const CODE_LENGTH = 6;

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
	const [digits, setDigits] = useState<string[]>(() => Array(CODE_LENGTH).fill(""));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [resent, setResent] = useState(false);
	const inputs = useRef<(HTMLInputElement | null)[]>([]);

	useEffect(() => {
		inputs.current[0]?.focus();
	}, []);

	/*
	 * Put the cursor back after a refusal.
	 *
	 * 🚨 This has to run in an effect rather than inline where the error is set, because
	 * the boxes carry `disabled={busy}` and **focusing a disabled input does nothing.**
	 * Calling `focus()` beside `setBusy(false)` looks right and silently fails: React has
	 * not re-rendered yet, so the element is still disabled at that instant. The symptom
	 * is quiet — a cleared field that ignores typing until you click it — which is exactly
	 * the sort of thing that ships. Caught by the e2e spec, not by reading it.
	 */
	useEffect(() => {
		if (error && !busy) inputs.current[0]?.focus();
	}, [error, busy]);

	const code = digits.join("");

	const submit = useCallback(
		async (value: string) => {
			if (value.length !== CODE_LENGTH || busy) return;
			setBusy(true);
			setError(null);
			try {
				await onSubmit(value);
				// Deliberately no `setBusy(false)` on success: the caller is navigating or
				// swapping this out, and re-enabling the field first only invites a second
				// submission of a code that has already been spent.
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: "That code didn't work. Check it, or ask for a new one.",
				);
				// Clear rather than leaving a wrong code sitting in the boxes: the next
				// thing they do is retype it, and six half-corrected characters is how the
				// second attempt goes wrong too. Refocusing is the effect above's job.
				setDigits(Array(CODE_LENGTH).fill(""));
				setBusy(false);
			}
		},
		[busy, onSubmit],
	);

	/** Write one box and move on; the last one submits without another click. */
	const putChar = (index: number, raw: string) => {
		const char = raw
			.replace(/[^a-zA-Z0-9]/g, "")
			.toUpperCase()
			.slice(-1);
		if (!char) return;
		const next = [...digits];
		next[index] = char;
		setDigits(next);
		if (index < CODE_LENGTH - 1) {
			inputs.current[index + 1]?.focus();
		} else {
			void submit(next.join(""));
		}
	};

	/**
	 * Paste fills the whole row.
	 *
	 * The single most likely way this code arrives is copied out of an email, and six
	 * boxes that each swallow one character of a six-character paste is the classic way
	 * this pattern is annoying.
	 */
	const onPaste = (e: React.ClipboardEvent) => {
		const text = e.clipboardData
			.getData("text")
			.replace(/[^a-zA-Z0-9]/g, "")
			.toUpperCase()
			.slice(0, CODE_LENGTH);
		if (!text) return;
		e.preventDefault();
		const next = Array(CODE_LENGTH)
			.fill("")
			.map((_, i) => text[i] ?? "");
		setDigits(next);
		inputs.current[Math.min(text.length, CODE_LENGTH - 1)]?.focus();
		if (text.length === CODE_LENGTH) void submit(text);
	};

	const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
		/*
		 * Backspace is handled entirely here, and it has to be.
		 *
		 * 🚨 These are **controlled** inputs, and `putChar` returns early when the incoming
		 * value is empty — so a native backspace on a filled box fires `onChange` with `""`,
		 * gets ignored, and React immediately re-renders the old character straight back in.
		 * The box simply could not be cleared: you could type a wrong code and then be
		 * unable to correct it without reloading. Nothing errors, and it looks like a stuck
		 * field. Found by the e2e spec.
		 *
		 * The behaviour it implements is the one people expect from a code field: clear this
		 * box if it holds anything, otherwise clear the one before and go there. Stepping
		 * back *without* clearing would leave a character behind that the cursor has already
		 * passed, which is how these fields end up eating a correction.
		 */
		if (e.key === "Backspace") {
			e.preventDefault();
			const next = [...digits];
			if (next[index]) {
				next[index] = "";
				setDigits(next);
			} else if (index > 0) {
				next[index - 1] = "";
				setDigits(next);
				inputs.current[index - 1]?.focus();
			}
			return;
		}
		if (e.key === "ArrowLeft" && index > 0) inputs.current[index - 1]?.focus();
		if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) inputs.current[index + 1]?.focus();
	};

	const resend = async () => {
		setResent(true);
		setError(null);
		// Fire and forget: the endpoint answers 200 whatever happened — including when it
		// declined to send because one just went out — so there is nothing here worth
		// branching on, and reporting a difference would undo the reason it is quiet.
		await onResend().catch(() => {});
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<p className="text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
					{stepLabel}
				</p>
				<h3 className="mt-1 text-xl font-bold">Check your email</h3>
				<p className="mt-2 text-sm text-base-content/70">{lede}</p>

				<div className="mt-5 flex justify-center gap-2" onPaste={onPaste}>
					{digits.map((digit, i) => (
						<input
							// The boxes are positional and never reorder, so the index IS the identity.
							// eslint-disable-next-line react/no-array-index-key
							key={`code-${i}`}
							ref={(el) => {
								inputs.current[i] = el;
							}}
							type="text"
							inputMode="text"
							autoComplete={i === 0 ? "one-time-code" : "off"}
							maxLength={1}
							value={digit}
							disabled={busy}
							aria-label={`Code character ${i + 1} of ${CODE_LENGTH}`}
							className="input input-bordered h-14 w-11 p-0 text-center font-mono text-2xl uppercase"
							onChange={(e) => putChar(i, e.target.value)}
							onKeyDown={(e) => onKeyDown(i, e)}
						/>
					))}
				</div>

				{error && <p className="mt-4 text-center text-sm text-error">{error}</p>}

				<button
					type="button"
					className={`btn btn-primary mt-5 w-full ${busy ? "btn-disabled" : ""}`}
					disabled={busy || code.length !== CODE_LENGTH}
					onClick={() => void submit(code)}
				>
					{busy ? busyLabel : cta}
				</button>

				<div className="mt-3 flex items-center justify-between text-xs">
					<button
						type="button"
						className="link text-base-content/60"
						onClick={() => void resend()}
						disabled={busy}
					>
						{resent ? "Sent — check your email again" : "Send it again"}
					</button>
					<button
						type="button"
						className="link text-base-content/40"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</button>
				</div>
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
