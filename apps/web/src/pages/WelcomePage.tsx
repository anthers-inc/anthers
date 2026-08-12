// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Onboarding (route: `/welcome`) — the second half of the signup ceremony.
 *
 * By the time anyone lands here the account exists, the address is confirmed, and any
 * charge has been taken. What is still owed is the handle, and that ordering is the
 * design rather than an accident: **a username is the one thing `/subscribe` refuses to
 * ask for**, because it costs nothing at the moment of decision and a great deal at the
 * moment of doubt. Somebody weighing $3 a month should not also be inventing a name.
 *
 * 🚨 **The password is optional, and the page has to make that believable.** An account
 * with no password is a supported end state, not an unfinished one — it signs in with an
 * emailed code, the same six characters that got it here. Presenting the field as
 * required-but-skippable (a greyed "skip" link under a filled-in form) would produce the
 * thing this is trying to avoid: an unwanted password, invented under mild pressure,
 * reused from somewhere else. So the choice is stated as two equal options and neither
 * is preselected as the "real" one.
 *
 * The handle cannot be changed here afterwards — see `POST /auth/onboarding/claim`,
 * which refuses a second claim. Renaming is a different feature with different
 * consequences (other people hold the old URL; the vacated name becomes impersonatable)
 * and this page should not quietly become it.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { FONTS } from "@anthers/web-shared/fonts";
import { useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

const serif = { fontFamily: FONTS.fraunces };

/** Mirrors the API's rule, so the message arrives before the round trip rather than after. */
const HANDLE_RE = /^[a-zA-Z0-9_-]+$/;

export default function WelcomePage() {
	const { user, isLoading, refreshUser } = useAuth();
	const navigate = useNavigate();

	const [username, setUsername] = useState("");
	const [wantsPassword, setWantsPassword] = useState<boolean | null>(null);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Nobody else has business here. An account that already has a handle has finished
	// onboarding, and a signed-out visitor has nothing to onboard.
	useEffect(() => {
		if (isLoading) return;
		if (!user) navigate("/login");
		else if (user.username) navigate(`/${user.username}`);
	}, [isLoading, user, navigate]);

	const trimmed = username.trim();
	const handleProblem =
		trimmed.length === 0
			? null
			: trimmed.length < 3
				? "At least three characters."
				: !HANDLE_RE.test(trimmed)
					? "Letters, numbers, hyphens and underscores only."
					: null;

	const passwordProblem =
		wantsPassword === true && password.length > 0 && password.length < 8
			? "At least eight characters."
			: null;

	const ready =
		trimmed.length >= 3 &&
		!handleProblem &&
		wantsPassword !== null &&
		(wantsPassword === false || (password.length >= 8 && !passwordProblem));

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.onboarding.claim.$post({
				json: {
					username: trimmed,
					...(wantsPassword && password ? { password } : {}),
					acceptTerms: true as const,
				},
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? "Couldn't save that. Please try again.");
				setBusy(false);
				return;
			}
			await refreshUser();
			navigate(`/${trimmed}`);
		} catch {
			setError("Something went wrong. Please try again.");
			setBusy(false);
		}
	};

	if (isLoading || !user || user.username) return null;

	return (
		<div className="mx-auto min-w-0 w-full max-w-lg px-6 py-12 sm:py-20">
			<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
				One last thing
			</p>
			<h1 style={serif} className="mt-2 text-3xl font-light leading-tight sm:text-4xl">
				Pick your username
			</h1>
			<p className="mt-3 text-base leading-relaxed text-base-content/65">
				It's how people find you, and it's the address of your profile. Choose carefully — this one
				can't be changed later.
			</p>

			<form onSubmit={submit} className="mt-8">
				<label className="label px-0 pb-1" htmlFor="welcome-username">
					<span className="text-sm font-semibold">Username</span>
				</label>
				<label className="input input-bordered flex items-center gap-1">
					<span className="text-base-content/40">anthers.org/</span>
					<input
						id="welcome-username"
						className="min-w-0 grow"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						autoComplete="username"
						autoFocus
						maxLength={150}
						placeholder="yourname"
					/>
				</label>
				{handleProblem && <p className="mt-1 text-xs text-error">{handleProblem}</p>}

				<fieldset className="mt-8">
					<legend className="text-sm font-semibold">How would you like to sign in?</legend>
					<p className="mt-1 text-xs leading-relaxed text-base-content/50">
						Both work the same on every device. You can add or change a password later in Settings.
					</p>

					<div className="mt-3 flex flex-col gap-2">
						{/* Deliberately first. Someone who has just typed a code from an email has
						    already used this method successfully once, and the option they have
						    seen work is the honest default to offer. */}
						<button
							type="button"
							className={`btn justify-start text-left ${wantsPassword === false ? "btn-primary" : "btn-outline"}`}
							aria-pressed={wantsPassword === false}
							onClick={() => setWantsPassword(false)}
						>
							<span>
								Email me a code each time
								<span className="block text-xs font-normal opacity-70">
									No password to remember, or to lose.
								</span>
							</span>
						</button>
						<button
							type="button"
							className={`btn justify-start text-left ${wantsPassword === true ? "btn-primary" : "btn-outline"}`}
							aria-pressed={wantsPassword === true}
							onClick={() => setWantsPassword(true)}
						>
							<span>
								Set a password
								<span className="block text-xs font-normal opacity-70">
									Sign in without waiting for email.
								</span>
							</span>
						</button>
					</div>

					{wantsPassword === true && (
						<div className="mt-3">
							<label className="label px-0 pb-1" htmlFor="welcome-password">
								<span className="text-sm font-semibold">Password</span>
							</label>
							<input
								id="welcome-password"
								type="password"
								className="input input-bordered w-full"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoComplete="new-password"
								minLength={8}
								placeholder="At least 8 characters"
							/>
							{passwordProblem && <p className="mt-1 text-xs text-error">{passwordProblem}</p>}
						</div>
					)}
				</fieldset>

				{error && <p className="mt-4 text-sm text-error">{error}</p>}

				<button
					type="submit"
					className={`btn btn-primary btn-lg mt-8 w-full ${busy ? "btn-disabled" : ""}`}
					disabled={!ready || busy}
				>
					{busy ? "Saving…" : "Finish setting up"}
				</button>
			</form>
		</div>
	);
}
