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
import { sanitizeNextPath } from "@anthers/web-shared/nextPath";
import { Link, useLocation, useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useRef, useState } from "react";
import FirstRun, { type Arrival, readArrival } from "../components/onboarding/FirstRun";

const serif = { fontFamily: FONTS.fraunces };

/** Mirrors the API's rule, so the message arrives before the round trip rather than after. */
const HANDLE_RE = /^[a-zA-Z0-9_-]+$/;

export default function WelcomePage() {
	const { user, isLoading, refreshUser } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();

	/**
	 * Where the visitor was headed before signing up interrupted them, carried here from
	 * `/subscribe` (which got it from the gated-post unlock modal). Sanitized rather than
	 * read raw — it is attacker-controlled and it decides where somebody lands moments
	 * after typing a code from their inbox. See `lib/next-path.ts`.
	 */
	const next = sanitizeNextPath(new URLSearchParams(location.search).get("next"));

	const [username, setUsername] = useState("");
	const [wantsPassword, setWantsPassword] = useState<boolean | null>(null);
	const [password, setPassword] = useState("");
	/**
	 * 🚨 Real state, never a hardcoded `true`.
	 *
	 * The 13+ floor is the one thing Anthers asserts about age, and **an unaccepted
	 * assertion is not one** — the phrase lived in a document no user had ever seen,
	 * which made it closer to a wish than a term. The API requiring `acceptTerms` does
	 * not fix that on its own: a page that satisfies the requirement on the user's behalf
	 * reproduces exactly the problem the requirement exists to solve, while looking
	 * compliant from the server's side.
	 *
	 * This is the *only* place the ceremony can ask. `/subscribe` collects an address and
	 * nothing else, and the account is created the moment the code checks out — so
	 * onboarding is where the terms are presented and agreed to.
	 */
	const [acceptTerms, setAcceptTerms] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/*
	 * A signed-out visitor has nothing to onboard.
	 *
	 * ⚠️ Note what is NOT here any more: this used to bounce an account that already had
	 * a handle to its own profile. It no longer does, because claiming a handle is only
	 * the first half of this route — the second is the first-run state below, which an
	 * onboarded account is exactly the audience for. Every signup door now ends here.
	 */
	useEffect(() => {
		if (isLoading) return;
		if (!user) navigate("/login");
	}, [isLoading, user, navigate]);

	/**
	 * What this account chose on the way in, captured **once, on mount**.
	 *
	 * A ref rather than state read at render time: claiming a handle re-renders this
	 * component, and re-reading then would be reading the same storage twice for no
	 * reason. Capturing on mount also means the answer is stable across the claim step,
	 * which is the whole point — the person who arrives having paid is still the person
	 * who paid after they pick a name.
	 */
	const arrival = useRef<Arrival | null>(null);
	arrival.current ??= readArrival();

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
		acceptTerms &&
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
					// `acceptTerms as true` narrows the literal the schema demands; the value
					// is the checkbox's, and `ready` already refuses to submit without it.
					acceptTerms: acceptTerms as true,
				},
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? "Couldn't save that. Please try again.");
				setBusy(false);
				return;
			}
			/*
			 * Deliberately no navigation *by default*: refreshing the user makes
			 * `user.username` non-null, and this component then renders the first-run state
			 * in place. Sending them to their own brand-new, empty profile is the thing this
			 * page exists to stop.
			 *
			 * 🚨 **`?next=` is the one exception, and it is not a weakening of that rule.**
			 * First-run answers *"what now?"* for somebody who has no answer of their own. A
			 * visitor who arrived from a gated post has one — it is the reason they made an
			 * account ninety seconds ago — and showing them an orientation screen instead
			 * loses it. That was the old signup form's rule too: an explicit destination
			 * means a person trying to *do* something, and a welcome screen interrupts it.
			 *
			 * ⚠️ What is NOT skippable is this page's *form*. The account was created before
			 * onboarding, so the handle and the terms are still owed and the navigation only
			 * happens after `claim` succeeds. A `next` must never become a way around it.
			 */
			await refreshUser();
			if (next) {
				navigate(next, { replace: true });
				return;
			}
		} catch {
			setError("Something went wrong. Please try again.");
			setBusy(false);
		}
	};

	if (isLoading || !user) return null;

	if (user.username) {
		return (
			<div className="mx-auto min-w-0 w-full max-w-lg px-6 py-12 sm:py-20">
				<FirstRun arrival={arrival.current ?? { kind: "cold" }} username={user.username} />
			</div>
		);
	}

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

				{/* The honest surface, not the enforcement — the API requires this too. It sits
				    here rather than on /subscribe because that page collects an address and
				    nothing else, and this is the first moment the ceremony can ask. */}
				<label className="mt-8 flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3">
					<input
						type="checkbox"
						className="checkbox checkbox-sm mt-0.5"
						checked={acceptTerms}
						onChange={(e) => setAcceptTerms(e.target.checked)}
					/>
					<span className="text-sm">
						I'm 13 or older, and I agree to the{" "}
						<Link to="/terms" className="link link-primary" target="_blank">
							Terms of Service
						</Link>{" "}
						and{" "}
						<Link to="/privacy" className="link link-primary" target="_blank">
							Privacy Policy
						</Link>
						.
					</span>
				</label>

				{error && <p className="mt-4 text-sm text-error">{error}</p>}

				<button
					type="submit"
					className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
					disabled={!ready || busy}
				>
					{busy ? "Saving…" : "Finish setting up"}
				</button>
			</form>
		</div>
	);
}
