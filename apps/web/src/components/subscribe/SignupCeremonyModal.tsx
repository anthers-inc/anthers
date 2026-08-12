// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The first half of the signup ceremony: confirm the address, in place.
 *
 * `/subscribe` collects an email and nothing else. Submitting opens this — **a code
 * box, not a payment box** — and only once the address is confirmed does anything ask
 * for money. Parker's reasoning for that order: every account should arrive with a
 * confirmed address, and the public page should ask for as little as it possibly can.
 *
 * 🚨 **A free account walks the same path.** Verification is not the price of paying;
 * it is how an account comes into existence, so someone who picks nothing at all still
 * confirms their address and still ends up somewhere real. Skipping it for free accounts
 * would leave exactly the accounts least likely to ever confirm as the unconfirmed ones.
 *
 * What this component does NOT do is take the payment. Verifying issues a session
 * cookie, so by the time this closes the browser is signed in and the rest is an
 * ordinary authenticated call through the existing preview + `SubscriptionPaymentModal`
 * machinery — the same ceremony the inline post unlock uses, unchanged. Splitting it
 * here is what stopped this from having to grow its own card field and its own idea of
 * what a charge looks like.
 *
 * It also does not send anyone away. The picks live in this page's state, so a redirect
 * to a signup route is what the old flow did and what cost the choices someone had just
 * made.
 */

import { client } from "@anthers/web-shared/rpc";
import { useCallback, useEffect, useRef, useState } from "react";

/** Length of the emailed code. Must match `CODE_LENGTH` in `services/signup-codes.ts`. */
const CODE_LENGTH = 6;

interface Props {
	/** The address the code went to — echoed back so a typo is visible before retrying. */
	email: string;
	/** Whether anything is being paid for, which decides what the step label promises. */
	paying: boolean;
	/**
	 * Verified. The browser now holds a session; the caller takes it from here — either
	 * into payment or straight to onboarding.
	 */
	onVerified: (result: { created: boolean; needsOnboarding: boolean }) => void;
	onClose: () => void;
}

export default function SignupCeremonyModal({ email, paying, onVerified, onClose }: Props) {
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
				const res = await client.api.auth.signup.verify.$post({ json: { email, code: value } });
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? "That code didn't work. Check it, or ask for a new one.");
					// Clear rather than leaving a wrong code sitting in the boxes: the next
					// thing they do is retype it, and six half-corrected characters is how the
					// second attempt goes wrong too. Refocusing is the effect above's job.
					setDigits(Array(CODE_LENGTH).fill(""));
					setBusy(false);
					return;
				}
				const body = (await res.json()) as { created: boolean; needsOnboarding: boolean };
				onVerified(body);
			} catch {
				setError("Something went wrong. Please try again.");
				setBusy(false);
			}
		},
		[busy, email, onVerified],
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
		await client.api.auth.signup.start.$post({ json: { email } }).catch(() => {});
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<p className="text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
					{paying ? "Step 1 of 2" : "Verify your email"}
				</p>
				<h3 className="mt-1 text-xl font-bold">Check your email</h3>
				<p className="mt-2 text-sm text-base-content/70">
					We sent a six-character code to <strong className="break-all">{email}</strong>. Enter it
					and you're verified.
				</p>

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
					{busy ? "Checking…" : "Verify my email"}
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
