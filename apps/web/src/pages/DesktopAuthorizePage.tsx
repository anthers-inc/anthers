// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop sign-in confirmation — the browser half of the desktop Studio's enrolment.
 *
 * The desktop app never asks for a password. It opens this page in the SYSTEM browser,
 * where the creator usually already holds a normal cookie session, and one confirm
 * click mints a separate, independently revocable desktop token. The token itself is
 * never shown here or put in the URL: the page hands back a one-time `code`, which the
 * app redeems with the PKCE verifier only it holds. See 42.06 § Desktop auth.
 *
 * ── `?client=cli` ───────────────────────────────────────────────────────────────────
 *
 * `anthersp2p` uses the same flow with one difference: it has no `anthers://` scheme to
 * be called back on, so it POLLS for the result instead. Two things follow, and both are
 * about not lying to the person looking at this page. The deep-link redirect is skipped —
 * navigating to a scheme nothing handles produces an OS error dialog, on a screen that
 * has just told the user everything worked. And the copy stops saying "Studio", because
 * for this visitor it is a terminal on a machine that may not even have a desktop.
 *
 * The parameter changes presentation only. Authorization is the same call under the same
 * cookie session, and the poll is authorized by the PKCE verifier regardless of what any
 * query string claims.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { apiFetch } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

type Phase = "loading" | "expired" | "ready" | "authorizing" | "done" | "error";

export default function DesktopAuthorizePage() {
	const { isAuthenticated, isLoading } = useAuth();
	const location = useLocation();
	const [params] = useSearchParams();
	const challenge = params.get("challenge") ?? "";
	// Presentation only — see the header. Nothing here is trusted for authorization.
	const isCli = params.get("client") === "cli";

	const [phase, setPhase] = useState<Phase>("loading");
	const [label, setLabel] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!challenge) {
			setPhase("expired");
			return;
		}
		let cancelled = false;
		apiFetch(`/api/auth/desktop/pending/${encodeURIComponent(challenge)}`)
			.then(async (res) => {
				if (cancelled) return;
				if (!res.ok) {
					setPhase("expired");
					return;
				}
				const data = (await res.json()) as { label: string | null };
				setLabel(data.label);
				setPhase("ready");
			})
			.catch(() => {
				if (!cancelled) setPhase("expired");
			});
		return () => {
			cancelled = true;
		};
	}, [challenge]);

	const confirm = async () => {
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
			// A polling client is already waiting on its verifier and has no scheme
			// registered; opening one would raise an OS error dialog for nothing.
			if (isCli) return;
			// Hand the code back over the app's registered scheme. Only the code travels
			// here — it is useless without the verifier the app kept to itself.
			window.location.href = `anthers://auth/callback?code=${encodeURIComponent(code)}`;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not complete sign-in.");
			setPhase("error");
		}
	};

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	// Signing in returns here, so the confirm click is the only step left.
	if (!isAuthenticated) {
		return <Navigate to="/login" state={{ from: location }} replace />;
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
								Sign-in requests are only valid for a few minutes. Start again from{" "}
								{isCli ? "your terminal" : "Anthers Studio on your computer"}.
							</p>
						</>
					)}

					{(phase === "ready" || phase === "authorizing" || phase === "error") && (
						<>
							<h1 className="card-title text-lg">
								{isCli ? "Sign in on this device?" : "Sign in to Anthers Studio?"}
							</h1>
							<p className="text-sm text-base-content/60">
								This will let{" "}
								{label ? (
									<span className="font-medium text-base-content">{label}</span>
								) : isCli ? (
									"the command-line client"
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
									{phase === "authorizing"
										? "Signing in…"
										: isCli
											? "Sign in"
											: "Sign in to Studio"}
								</button>
							</div>
						</>
					)}

					{phase === "done" && (
						<>
							<h1 className="card-title text-lg">You're signed in</h1>
							<p className="text-sm text-base-content/60">
								{isCli
									? "Return to your terminal — it should be signed in within a few seconds. You can close this tab."
									: "Return to Anthers Studio on your computer — it should be signed in already. You can close this tab."}
							</p>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
