// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What somebody who followed a share link sees under the thing they came to watch: who sent
 * them, and a free account they can have without leaving the page.
 *
 * 🚨 **The whole point of the inline signup is that it is NOT the funnel** (Parker,
 * 2026-08-14). An email and a six-character code, and nothing else: no plan question, no
 * payment step, no username prompt, and no trip through `/subscribe`. Somebody watching
 * something they like should be able to get an account *while still watching it*. Bringing
 * them back to the upgrade and creator-support story is a later job and a tractable one; it
 * must not be made the price of entry.
 *
 * ⚠️ **It leans on primitives that already exist rather than inventing a second signup.**
 * `POST /auth/signup/start` and `/auth/signup/verify` create-or-sign-in and already treat the
 * password as optional (PR #229), and **verification is what creates the account and issues
 * the session** — so there is no half-built identity to reconcile if somebody closes the tab.
 * What is new here is a surface that uses them in place. 21.01 §9.2 is the full ceremony.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useState } from "react";

type Stage = "invite" | "code" | "done";

export default function SharedWorkBanner({
	sharedBy,
	onSignedIn,
}: {
	/** Display name of whoever sent the link, when we know it. */
	sharedBy?: string | null;
	/** Re-read the Work, so the page stops being a guest's and starts being theirs. */
	onSignedIn: () => void;
}) {
	const { refreshUser } = useAuth();
	const [stage, setStage] = useState<Stage>("invite");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const start = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.signup.start.$post({ json: { email } });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "We couldn't send a code to that address.");
				return;
			}
			setStage("code");
		} catch {
			setError("We couldn't send a code to that address.");
		} finally {
			setBusy(false);
		}
	};

	const verify = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.signup.verify.$post({ json: { email, code } });
			if (!res.ok) {
				setError("That code didn't work. Check it and try again.");
				return;
			}
			setStage("done");
			// The session exists now, so the page has to stop being a guest's: refreshing auth
			// and re-reading the Work is what moves the viewing off the sharer's budget and onto
			// their own. Without it they would keep watching on somebody else's allowance while
			// signed in, which is exactly what a share link must not become.
			await refreshUser();
			onSignedIn();
		} catch {
			setError("That code didn't work. Check it and try again.");
		} finally {
			setBusy(false);
		}
	};

	if (stage === "done") {
		return (
			<div className="mt-4 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm">
				You're in — this is your account now, with 10 free hours of Public Access every month.{" "}
				<Link to="/welcome" className="link link-primary">
					Pick a username
				</Link>{" "}
				whenever you like.
			</div>
		);
	}

	return (
		<div className="mt-4 rounded-lg border border-base-300 bg-base-200/60 px-4 py-4 text-sm">
			<p className="text-base-content/80">
				{sharedBy ? <strong>{sharedBy}</strong> : "Someone"} shared this with you, so you can watch
				it without an account — and the creator is paid for your time either way.
			</p>
			<p className="mt-1 text-base-content/60">
				Want your own? An email and a code is all it takes. No payment, no plan to pick.
			</p>

			{stage === "invite" ? (
				<form onSubmit={start} className="mt-3 flex flex-wrap items-center gap-2">
					<input
						type="email"
						required
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="you@example.com"
						aria-label="Email address"
						className="input input-sm input-bordered min-w-0 flex-1"
					/>
					<button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
						{busy ? "Sending…" : "Create a free account"}
					</button>
				</form>
			) : (
				<form onSubmit={verify} className="mt-3 flex flex-wrap items-center gap-2">
					<input
						type="text"
						required
						value={code}
						onChange={(e) => setCode(e.target.value.toUpperCase())}
						placeholder="6-character code"
						aria-label="Verification code"
						maxLength={6}
						className="input input-sm input-bordered w-40 font-mono tracking-widest"
					/>
					<button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
						{busy ? "Checking…" : "Verify"}
					</button>
					<span className="text-xs text-base-content/50">Sent to {email}</span>
				</form>
			)}

			{error && <p className="mt-2 text-xs text-error">{error}</p>}
		</div>
	);
}
