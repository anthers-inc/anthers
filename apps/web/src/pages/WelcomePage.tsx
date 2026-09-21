// SPDX-License-Identifier: Apache-2.0
/**
 * Onboarding (route: `/welcome`) — the closing beat of the signup ceremony.
 *
 * By the time anyone lands here the account exists, the address is confirmed, and any
 * charge has been taken. There is no longer anything to *claim*: a person is addressed by
 * their ATProto handle, which the account carries from the moment it is created, so the
 * username-claim form this page was built around (and `POST /auth/onboarding/claim` behind
 * it) is gone. What onboarding still asks for is the one thing that cannot arrive with the
 * identity: acceptance of the terms, including the 13+ assertion.
 *
 * 🚨 **Terms acceptance is the point of the page, not a courtesy on it.** The 13+ floor is
 * the one thing Anthers asserts about a person's age, and an unaccepted assertion is not
 * one — so acceptance is enforced at the API (`POST /auth/onboarding/accept-terms`) and
 * this form is its only face. An account that has not accepted is signed in but unfinished:
 * it is routed here from anywhere until `termsAcceptedAt` is set.
 *
 * 🚨 **Sign-in is the emailed code and nothing else (Parker, 2026-09-13).** No password is
 * set, offered or accepted — here or anywhere else. This page says so plainly, because the
 * code that brought a person here is also how they come back tomorrow, and that is the
 * moment to learn it: before the first session ends, not after.
 *
 * 🚨 **The default is still not to navigate.** Sending a brand-new account to its own
 * empty profile is the thing this page exists to stop (see `FirstRun.tsx`). A sanitized
 * `?next=` is the one exception — an explicit destination means a person trying to *do*
 * something, and a welcome screen interrupts it.
 */

import { sanitizeNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { Link, useLocation, useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useRef, useState } from "react";
import FirstRun, { type Arrival, readArrival } from "../components/onboarding/FirstRun";
import SignupSteps, { signupSteps } from "../components/onboarding/SignupSteps";

export default function WelcomePage() {
	const { user, isLoading, refreshUser } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();

	/**
	 * Where the visitor was headed before signing up interrupted them, carried here from
	 * `/subscribe` (which got it from the gated-post unlock modal). Sanitized rather than
	 * read raw — it is attacker-controlled and it decides where somebody lands moments
	 * after typing a code from their inbox. See `shared/next-path.ts`.
	 */
	const next = sanitizeNextPath(new URLSearchParams(location.search).get("next"));

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
	 * This is the *only* place the ceremony asks. `/subscribe` collects an identity and
	 * nothing else, and the account is created the moment the code checks out — so the
	 * first run is where the terms are presented and agreed to.
	 */
	const [acceptTerms, setAcceptTerms] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/*
	 * A signed-out visitor has nothing to onboard.
	 */
	useEffect(() => {
		if (isLoading) return;
		if (!user) navigate("/login");
	}, [isLoading, user, navigate]);

	/**
	 * What this account chose on the way in, captured **once, on mount**.
	 *
	 * A ref rather than state read at render time: the answer must be stable across
	 * re-renders — the person who arrives having paid is still the person who paid.
	 */
	const arrival = useRef<Arrival | null>(null);
	arrival.current ??= readArrival();

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!acceptTerms || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.onboarding["accept-terms"].$post({
				json: {
					// `acceptTerms as true` narrows the literal the schema demands; the value
					// is the checkbox's, and the button refuses to submit without it.
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
			 * Deliberately no navigation *by default*: refreshing the user sets
			 * `termsAcceptedAt`, and this component then renders the first-run state in
			 * place. Sending them to their own brand-new, empty profile is the thing this
			 * page exists to stop.
			 *
			 * 🚨 **`?next=` is the one exception, and it is not a weakening of that rule.**
			 * First-run answers *"what now?"* for somebody who has no answer of their own. A
			 * visitor who arrived from a gated post has one — it is the reason they made an
			 * account ninety seconds ago — and showing them an orientation screen instead
			 * loses it.
			 *
			 * ⚠️ What is NOT skippable is this page's *form*. The terms are still owed and
			 * the navigation only happens after acceptance succeeds. A `next` must never
			 * become a way around it.
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

	// The terms are accepted — onboarding is done. Render the first-run state in place.
	if (user.termsAcceptedAt) {
		return (
			<div className="mx-auto min-w-0 w-full max-w-lg px-6 py-12 sm:py-20">
				<FirstRun arrival={arrival.current ?? { kind: "cold" }} handle={user.handle} />
			</div>
		);
	}

	return (
		// ⚠️ **The rail is the same one `/finish` wears** (Parker, 2026-08-26). Sharing the
		// chrome is what makes the flow read as one flow even though its steps span routes.
		//
		// 🚨 The earlier steps are drawn as **done** rather than omitted. Somebody arriving
		// here has confirmed an address and possibly paid; a rail that started at this step
		// would say the flow began where they are standing, which is the opposite of the
		// reassurance it exists to give.
		<SignupSteps
			steps={signupSteps({
				bluesky: null,
				address: "done",
				payment: null,
			})}
			eyebrow="One Last Thing"
			title="Welcome to Anthers"
		>
			<p className="mt-3 text-base leading-relaxed text-base-content/65">
				Just the terms to agree to, and you're in.
			</p>

			<form onSubmit={submit} className="mt-8">
				{/* Sign-in is the emailed code and nothing else, so there is no choice to
				    offer here — what this block does is say so, at the moment the account is
				    finished, before the first session ends. The code that brought them here
				    is the way back in, the same six characters each time. */}
				<p className="rounded-lg border border-base-300 p-3 text-sm leading-relaxed text-base-content/65">
					Signing in is a code emailed to your address — same six characters, every device, nothing
					to remember or lose.
				</p>

				{/* The honest surface, not the enforcement — the API requires this too. It sits
				    here rather than on /subscribe because that page collects an identity and
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
					disabled={!acceptTerms || busy}
				>
					{busy ? "Saving…" : "Finish setting up"}
				</button>
			</form>
		</SignupSteps>
	);
}
