// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Which Bluesky account?" — the handle prompt that starts an ATProto sign-in.
 *
 * ATProto has no "sign in with" button that can work on its own: the handle is what tells
 * us which server holds the account, so it has to be asked for before anything can be
 * redirected anywhere. That is the whole reason this is a step rather than a button.
 *
 * 🚨 **It is a modal because `/login`'s card has no room, and that is a real constraint
 * rather than a preference.** The botanical flourishes are positioned against the card box
 * and reach about seven rems in from each corner, so the card's own height is tuned to keep
 * content clear of them — an inline field pushed the submit button straight under a spray
 * of leaves. A step that opens over the page costs the card nothing.
 *
 * Same contract as `EmailCodeModal`: the caller owns the outcome. `onSubmit` starts
 * whatever flow it starts and **throws an `Error` whose message is shown in the field**
 * when it doesn't. This component never navigates and never touches the auth context.
 */

import { useEffect, useRef, useState } from "react";
import BlueskyMark from "./BlueskyMark";

interface Props {
	/**
	 * Which door this is.
	 *
	 * 🚨 **It changes only the words, and the words are the part that matters.** Both modes
	 * ask for a handle and hand off to the same round trip; what differs is the promise
	 * being made. Signing in cannot create an account and says so; signing up can, and owes
	 * the reader the fact that Bluesky will be asked for their email address — which is a
	 * thing to learn *before* a consent screen asks for it, not from the consent screen.
	 */
	mode?: "login" | "signup";
	/**
	 * Hand off to Bluesky. On success this never returns in any useful sense — the browser
	 * is already leaving — so nothing may be queued after it.
	 */
	onSubmit: (handle: string) => Promise<void>;
	onClose: () => void;
}

const COPY = {
	login: {
		step: "Log in with Bluesky",
		lede: "We'll send you to Bluesky to confirm it's you. This logs you in to the Anthers account that handle is linked to — it doesn't create one.",
	},
	signup: {
		step: "Sign up with Bluesky",
		lede: "We'll send you to Bluesky to confirm it's you, and ask it for your email address — Anthers needs one it can reach for receipts and account notices. You'll pick a name and agree to the terms after.",
	},
} as const;

export default function BlueskyHandleModal({ mode = "login", onSubmit, onClose }: Props) {
	const [handle, setHandle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
	}, []);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		// A handle is a domain name; the leading `@` is how people write it, not part of it.
		const value = handle.trim().replace(/^@/, "");
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onSubmit(value);
			// Deliberately no `setBusy(false)`: the caller is navigating away, and putting the
			// button back only invites a second handoff to a page that is already leaving.
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't reach Bluesky. Please try again.");
			setBusy(false);
		}
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box max-w-md">
				<p className="text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
					{COPY[mode].step}
				</p>
				<h3 className="mt-1 flex items-center gap-2 text-xl font-bold">
					<BlueskyMark />
					What's your handle?
				</h3>
				{/* 🚨 The last sentence is the one that matters, in both modes. Whether this
				    door can create an account, and what it is about to ask Bluesky for, are
				    both cheaper to say here than to let someone discover at the end of a round
				    trip through another website. */}
				<p className="mt-2 text-sm text-base-content/70">{COPY[mode].lede}</p>

				<form onSubmit={submit}>
					<input
						ref={input}
						type="text"
						inputMode="url"
						autoComplete="username"
						spellCheck={false}
						autoCapitalize="none"
						placeholder="alice.bsky.social"
						aria-label="Bluesky handle"
						className="input input-bordered mt-5 w-full"
						value={handle}
						disabled={busy}
						onChange={(e) => setHandle(e.target.value)}
					/>

					{error && <p className="mt-4 text-sm text-error">{error}</p>}

					<button
						type="submit"
						className="btn btn-primary mt-5 w-full"
						disabled={busy || !handle.trim()}
					>
						{busy ? "Taking you to Bluesky…" : "Continue"}
					</button>
				</form>

				<div className="mt-3 flex items-center justify-end text-xs">
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
