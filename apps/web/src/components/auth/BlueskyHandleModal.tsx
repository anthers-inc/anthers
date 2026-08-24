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
 * ⚠️ **This is `/login`'s prompt and only `/login`'s, since 2026-08-24.** It carried a
 * `mode` prop and a second set of copy for signing up, because `/subscribe` opened it too.
 * That card has room this one does not, so the handle is asked for inline there and the
 * signup branch here had no caller left. The promises it used to make — that Bluesky will
 * be asked for an email address, that Anthers confirms it regardless, and that a name and
 * the terms still follow — moved with the field and are pinned by `subscribe-bluesky.e2e`.
 *
 * Same contract as `EmailCodeModal`: the caller owns the outcome. `onSubmit` starts
 * whatever flow it starts and **throws an `Error` whose message is shown in the field**
 * when it doesn't. This component never navigates and never touches the auth context.
 */

import { useEffect, useRef, useState } from "react";
import BlueskyMark from "./BlueskyMark";

interface Props {
	/**
	 * Hand off to Bluesky. On success this never returns in any useful sense — the browser
	 * is already leaving — so nothing may be queued after it.
	 */
	onSubmit: (handle: string) => Promise<void>;
	onClose: () => void;
}

/**
 * 🚨 The last sentence is the one that matters: this door **cannot** create an account, and
 * saying so is what keeps it distinct from the signup door on `/subscribe`. A reader who
 * assumed otherwise would find out at the end of a round trip through another website.
 */
const COPY = {
	step: "Log in with Bluesky",
	lede: "We'll send you to Bluesky to confirm it's you. This logs you in to the Anthers account that handle is linked to — it doesn't create one.",
} as const;

export default function BlueskyHandleModal({ onSubmit, onClose }: Props) {
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
					{COPY.step}
				</p>
				<h3 className="mt-1 flex items-center gap-2 text-xl font-bold">
					<BlueskyMark />
					What's your handle?
				</h3>
				<p className="mt-2 text-sm text-base-content/70">{COPY.lede}</p>

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
