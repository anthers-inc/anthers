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
 * 🚨 **Nothing here may create an account, and the error most people will see says so.**
 * Signing in with a Bluesky handle that no Anthers account has linked comes back as
 * `signup_disabled`, and the honest answer is that there is no account rather than that
 * something broke. Pointing that person at `/subscribe` is the only route onward, because
 * `/subscribe` is the single signup door.
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
		"That Bluesky account isn't connected to an Anthers account yet. Signing up with Bluesky isn't open — create an account first, then link Bluesky from your settings.",
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
							{noAccount && (
								<Link to="/subscribe" className="btn btn-primary btn-sm">
									Sign up
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
