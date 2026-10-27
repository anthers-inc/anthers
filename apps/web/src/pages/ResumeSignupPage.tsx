// SPDX-License-Identifier: Apache-2.0
/**
 * Moving an unfinished signup to this browser (route: `/finish/resume`).
 *
 * 🚨 **This is the only thing an emailed code still does, and it is not a sign-in.** Somebody who
 * presses *Create My Account* in one browser and opens the mail in another has no cookie on the
 * second one, so the pending signup cannot be found by the page that finishes it. Proving the
 * address on the row is the one piece of evidence the ceremony already accepts, and it hands the
 * row to this browser without creating or signing in to anything. The account is still made on
 * `/finish`, by `/signup/complete`, where it always was.
 *
 * ⚠️ **It must stay impossible to reach an existing account from here.** The route behind it
 * resumes a pending signup and answers `no_signup` for anything else, so a code for an address
 * that already has an account leads the person back to `/login` rather than into it.
 */
import { usePageTitle } from "@anthers/web-shared/page-title";
import { client } from "@anthers/web-shared/rpc";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

export default function ResumeSignupPage() {
	usePageTitle("Finish Your Signup");
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [sent, setSent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const sendCode = async () => {
		const address = email.trim();
		if (!address) {
			setError("Enter the address you gave at signup.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			// The signup pair, not a sign-in pair: this is the ceremony's own send, and it answers
			// the same whatever is behind the address.
			await client.api.auth.signup.start.$post({ json: { email: address } });
			setSent(true);
		} catch {
			setError("Couldn't send the code. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	const finish = async () => {
		const address = email.trim();
		if (!code.trim()) {
			setError("Enter the code from the email.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.signup.resume.verify.$post({
				json: { email: address, code: code.trim() },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? "That code didn't work. Ask for a new one.");
				return;
			}
			// The cookie is set; `/finish` now finds the row and asks for whatever it still owes.
			navigate("/finish", { replace: true });
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-1 items-center justify-center px-4 py-10">
			<div className="card w-full max-w-md bg-base-200 shadow-lg">
				<div className="card-body gap-3">
					<h1 className="card-title text-2xl">Finish a signup started elsewhere</h1>
					<p className="text-sm leading-relaxed text-base-content/65">
						Enter the address you gave at signup. We'll email a code, and entering it moves the
						signup to this browser so you can finish it.
					</p>

					<label className="label px-0 pb-1" htmlFor="resume-email">
						<span className="text-sm font-semibold">Email address</span>
					</label>
					<input
						id="resume-email"
						type="email"
						autoComplete="email"
						className="input input-bordered w-full"
						value={email}
						onChange={(e) => {
							setEmail(e.target.value);
							setError(null);
						}}
						disabled={sent}
					/>

					{sent && (
						<>
							<p className="text-sm text-base-content/65">
								If there's an unfinished signup for <strong className="break-all">{email}</strong>,
								a code is on its way.
							</p>
							<label className="label px-0 pb-1" htmlFor="resume-code">
								<span className="text-sm font-semibold">The code from the email</span>
							</label>
							<input
								id="resume-code"
								type="text"
								inputMode="numeric"
								autoComplete="one-time-code"
								className="input input-bordered w-full"
								value={code}
								onChange={(e) => {
									setCode(e.target.value);
									setError(null);
								}}
							/>
						</>
					)}

					{error && <p className="text-sm text-error">{error}</p>}

					<button
						type="button"
						className={`btn btn-primary mt-2 w-full ${busy ? "btn-disabled" : ""}`}
						onClick={() => void (sent ? finish() : sendCode())}
						disabled={busy}
					>
						{busy ? "Working…" : sent ? "Finish my signup" : "Send me a code"}
					</button>

					<div className="flex items-center justify-between text-xs text-base-content/55">
						<Link to="/login" className="link">
							Back to log in
						</Link>
						{sent && (
							<button type="button" className="link" onClick={() => void sendCode()}>
								Send a new code
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
