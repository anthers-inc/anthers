// SPDX-License-Identifier: AGPL-3.0-or-later

import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

/**
 * Where an ATProto round trip lands (route: `/auth/atproto/callback`).
 *
 * The API has already done everything that matters by the time this renders — exchanged
 * the code, linked or signed in, set the session cookie — and redirected here with the
 * outcome in the query. So this page is a *translator*: it turns one word into a sentence
 * and sends the person on.
 *
 * 🚨 **Nothing here creates an account, and every signup-shaped outcome goes somewhere that
 * cannot become a second door.** Coming back from the *signup* door is `needs_email`: the
 * identity is proved and written onto the pending signup, and `/finish` completes the
 * ordinary emailed-code ceremony. Coming back from the *sign-in* door with a handle nobody
 * has linked is `resume_signup` when there is an unfinished signup for that identity —
 * proving the DID a second time is the same evidence as proving it the first — and
 * `signup_disabled` when there is not, because the honest answer is then that there is no
 * account, not that something broke.
 */

/**
 * What the API can hand back, and what each one means to the person reading it.
 *
 * ⚠️ Keys are the API's vocabulary, not free text. Four of them (`missing_params`,
 * `session_expired`, `state_mismatch`, `auth_failed`) belonged to the hand-rolled OAuth
 * client that PR #56 deleted and had been unreachable since; `did_already_linked` was
 * unreachable in the other direction, because the service was returning a whole sentence
 * where this map expected a code. A message table is exactly the sort of thing that rots
 * without anything going visibly wrong, since the fallback below reads plausibly.
 */
const ERROR_MESSAGES: Record<string, string> = {
	signup_disabled:
		"That Bluesky account isn't connected to an Anthers account yet — signing in can't create one. Sign up, and the same handle will work from then on.",
	not_authenticated: "You have to be signed in to link a Bluesky account.",
	did_already_linked: "That Bluesky account is already linked to a different Anthers account.",
	signup_failed: "We couldn't finish setting up that account.",
	exchange_failed: "Bluesky didn't complete the sign-in. Please try again.",
};

export default function ATProtoCallbackPage() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { refreshUser } = useAuth();
	const [error, setError] = useState<string | null>(null);

	const success = searchParams.get("success");
	const errorParam = searchParams.get("error");
	// Sanitized here as well as in the API. This is the value `navigate()` is actually
	// given, and the last read is the one that decides where a browser goes.
	const next = sanitizeNextPath(searchParams.get("next"));
	const needsOnboarding = searchParams.get("onboarding") === "1";

	useEffect(() => {
		if (errorParam) {
			setError(ERROR_MESSAGES[errorParam] ?? "Bluesky sign-in didn't work. Please try again.");
			return;
		}

		// ⚠️ Refreshing the auth context unmounts this page, because the shell swaps layout
		// components on auth state — so it is the last thing before navigating, and nothing
		// may be queued after. The same ordering bug cost `/subscribe` a real defect.
		if (success === "login") {
			refreshUser().then(() => {
				// An account that never claimed a handle still owes one, and it cannot be
				// linked to or found until it does.
				navigate(needsOnboarding ? withNextPath("/welcome", next) : (next ?? "/feed"), {
					replace: true,
				});
			});
			return;
		}

		if (success === "linked") {
			refreshUser().then(() => {
				navigate("/settings?bluesky=linked", { replace: true });
			});
			return;
		}

		// 🚨 **A signup coming back from Bluesky, and it lands on the page that finishes
		// one.** There is no account and no session yet — the proved identity sits on the
		// pending signup this browser started, bound by an httpOnly cookie — so this
		// deliberately does NOT refresh the auth context, because there is nothing new to
		// learn about who is signed in.
		//
		// ⚠️ **It went to `/subscribe?atproto=1` until 2026-08-26**, and that is the defect
		// this whole flow was rebuilt to fix: dropping somebody back on a marketing page with
		// a prefilled email box is indistinguishable from having accomplished nothing.
		// `resume_signup` is the same landing reached from the *sign-in* door by somebody
		// whose signup was still unfinished — different cause, same destination, because a
		// page whose only job is finishing can only be about finishing.
		if (success === "needs_email" || success === "resume_signup") {
			// The destination rides on the pending signup rather than on this URL, so nothing
			// is appended here — `/finish` reads it back with everything else the signup was
			// carrying.
			navigate("/finish", { replace: true });
			return;
		}

		setError("We didn't get an answer back from Bluesky. Please try again.");
	}, [success, errorParam, next, needsOnboarding, refreshUser, navigate]);

	if (error) {
		// The one error worth routing differently: there is nothing wrong to retry, there is
		// simply no account yet.
		const noAccount = errorParam === "signup_disabled";
		return (
			<div className="container mx-auto max-w-md px-4 py-16 text-center">
				<div className="card bg-base-200">
					<div className="card-body">
						<h2 className="card-title justify-center text-lg">
							{noAccount ? "No Anthers account for that handle" : "Bluesky sign-in didn't work"}
						</h2>
						<p className="text-sm text-base-content/60">{error}</p>
						<div className="card-actions mt-4 justify-center gap-2">
							{/* Same name as the navbar and `/login`'s prompt. This is the third place
							    somebody without an account gets pointed at the door, and one act
							    should have one name wherever it is offered. */}
							{noAccount && (
								<Link to="/subscribe" className="btn btn-primary btn-sm">
									Sign up free
								</Link>
							)}
							<Link to="/login" className={`btn btn-sm ${noAccount ? "btn-ghost" : "btn-primary"}`}>
								Back to log in
							</Link>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<div className="text-center">
				<LoadingSpinner size="lg" />
				<p className="mt-4 text-sm text-base-content/60">Finishing up with Bluesky…</p>
			</div>
		</div>
	);
}
