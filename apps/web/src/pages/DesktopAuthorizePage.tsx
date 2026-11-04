// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop sign-in confirmation — the browser half of the desktop Studio's enrollment.
 *
 * The desktop app never asks for a password. It opens this page in the SYSTEM browser,
 * where the creator usually already holds a normal cookie session, and one confirm
 * click mints a separate, independently revocable desktop token. The token itself is
 * never shown here or put in the URL: the page hands back a one-time `code`, which the
 * app redeems with the PKCE verifier only it holds. See `apps/api/src/middleware/bearer.ts`.
 *
 * ⚠️ **`?redirect=mobile` is which app is listening, not where to go.** The desktop answers
 * on its own `anthers://` scheme, and a phone cannot: any app on Android may claim a custom
 * scheme, so the mobile shell registers verified `https://anthers.org` links instead and the
 * code comes back through one. The value is an enum rather than a URL on purpose — a
 * caller-supplied address here would be an open redirect on a page that just minted a
 * credential.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { apiFetch } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

type Phase = "loading" | "expired" | "ready" | "authorizing" | "done" | "error";

export default function DesktopAuthorizePage() {
	const { isAuthenticated, isLoading, signInWithIdentity } = useAuth();
	const location = useLocation();
	const [params] = useSearchParams();
	const challenge = params.get("challenge") ?? "";
	const mobile = params.get("redirect") === "mobile";
	/**
	 * The handle, when the app asked for this sign-in from a field of its own.
	 *
	 * 🚨 **A phone browser usually has no Anthers session**, so this page used to be a dead
	 * end for the app: it bounced to `/login`, the person signed in there, and came back to
	 * a page whose challenge the login round trip had lost. The app now asks for the handle
	 * first and passes it here, so the first thing this page does is hand the person to the
	 * server that holds their identity, exactly as `/login` does, and come back with the
	 * challenge intact.
	 */
	const handle = params.get("handle") ?? "";

	const [phase, setPhase] = useState<Phase>("loading");
	const [label, setLabel] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// One start and one auto-confirm per visit: React StrictMode runs effects twice in
	// development, and a second OAuth start would spend a second pending challenge.
	const started = useRef(false);
	const confirmed = useRef(false);

	useEffect(() => {
		if (!challenge) {
			setPhase("expired");
			return;
		}
		let canceled = false;
		apiFetch(`/api/auth/desktop/pending/${encodeURIComponent(challenge)}`)
			.then(async (res) => {
				if (canceled) return;
				if (!res.ok) {
					setPhase("expired");
					return;
				}
				const data = (await res.json()) as { label: string | null };
				setLabel(data.label);
				setPhase("ready");
			})
			.catch(() => {
				if (!canceled) setPhase("expired");
			});
		return () => {
			canceled = true;
		};
	}, [challenge]);

	const confirm = useCallback(async () => {
		setPhase("authorizing");
		setError(null);
		try {
			const res = await apiFetch("/api/auth/desktop/authorize", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ challenge }),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? "Could not complete sign-in.");
			}
			const { code } = (await res.json()) as { code: string };
			setPhase("done");
			// Hand the code back to whichever app asked. Only the code travels here — it is
			// useless without the verifier the app kept to itself.
			const callback = mobile
				? `https://anthers.org/auth/callback?code=${encodeURIComponent(code)}`
				: `anthers://auth/callback?code=${encodeURIComponent(code)}`;
			window.location.href = callback;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not complete sign-in.");
			setPhase("error");
		}
	}, [challenge, mobile]);

	/**
	 * Back from the identity server, with a session and a handle to account for: mint the
	 * code and hand it to the app without a second question.
	 *
	 * The confirm screen remains for the desktop's flow, which opens this page with no
	 * handle, so nothing there proves the person asked for *this* sign-in. Here the request
	 * began at the app's own handle field and the identity server has already shown what is
	 * being granted, which is the same evidence the confirm screen was asking for.
	 */
	useEffect(() => {
		if (!handle || !isAuthenticated || phase !== "ready" || confirmed.current) return;
		confirmed.current = true;
		void confirm();
	}, [handle, isAuthenticated, phase, confirm]);

	// The app's own sign-in screen asked for the handle, so the browser leg starts from it:
	// the same OAuth start `/login` performs, carrying this page (challenge and all) as the
	// place to come back to.
	useEffect(() => {
		if (isLoading || isAuthenticated || !handle || started.current) return;
		started.current = true;
		signInWithIdentity(handle, `${location.pathname}${location.search}`).catch((err) => {
			setError(err instanceof Error ? err.message : "Couldn't reach your identity server.");
			setPhase("error");
		});
	}, [isLoading, isAuthenticated, handle, signInWithIdentity, location.pathname, location.search]);

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	// No session in this browser yet.
	if (!isAuthenticated) {
		// Without a handle there is nothing to start: the person needs the login page, and
		// its `from` carries this whole URL so the challenge survives the detour.
		if (!handle) {
			return <Navigate to="/login" state={{ from: location }} replace />;
		}
		return (
			<div className="max-w-md mx-auto px-4 py-12">
				<div className="card bg-base-200">
					<div className="card-body items-center text-center gap-3">
						{error ? (
							<>
								<h1 className="card-title text-lg">Could not start sign-in</h1>
								<div className="alert alert-error text-sm w-full">
									<span>{error}</span>
								</div>
								<p className="text-sm text-base-content/60">
									Go back to the app and try again, or check the handle.
								</p>
							</>
						) : (
							<>
								<LoadingSpinner size="lg" />
								<p className="text-sm text-base-content/60">
									Taking you to the server that holds {handle}…
								</p>
							</>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="max-w-md mx-auto px-4 py-12">
			<div className="card bg-base-200">
				<div className="card-body">
					{phase === "loading" && (
						<div className="flex justify-center py-6">
							<LoadingSpinner size="lg" />
						</div>
					)}

					{phase === "expired" && (
						<>
							<h1 className="card-title text-lg">This sign-in request has expired</h1>
							<p className="text-sm text-base-content/60">
								Sign-in requests are only valid for a few minutes. Start again from Anthers Desktop
								on your computer.
							</p>
						</>
					)}

					{(phase === "ready" || phase === "authorizing" || phase === "error") && (
						<>
							<h1 className="card-title text-lg">Sign in to Anthers?</h1>
							<p className="text-sm text-base-content/60">
								This will let{" "}
								{label ? (
									<span className="font-medium text-base-content">{label}</span>
								) : (
									"the Studio app on your computer"
								)}{" "}
								use your account. You can revoke it any time from{" "}
								<span className="font-medium text-base-content">Settings → Devices</span>.
							</p>

							{error && (
								<div className="alert alert-error text-sm mt-2">
									<span>{error}</span>
								</div>
							)}

							<div className="card-actions mt-4">
								<button
									type="button"
									className="btn btn-primary btn-sm"
									onClick={confirm}
									disabled={phase === "authorizing"}
								>
									{phase === "authorizing" ? "Signing in…" : "Sign in to Studio"}
								</button>
							</div>
						</>
					)}

					{phase === "done" && (
						<>
							<h1 className="card-title text-lg">You're signed in</h1>
							<p className="text-sm text-base-content/60">
								Return to Anthers on your computer — it should be signed in already. You can close
								this tab.
							</p>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
