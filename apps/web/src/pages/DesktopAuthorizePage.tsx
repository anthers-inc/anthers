// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop sign-in confirmation — the browser half of the desktop Studio's enrollment.
 *
 * The desktop app never asks for a password. It opens this page in the SYSTEM browser,
 * where the creator usually already holds a normal cookie session, and one confirm
 * click mints a separate, independently revocable desktop token. The token itself is
 * never shown here or put in the URL: the page hands back a one-time `code`, which the
 * app redeems with the PKCE verifier only it holds. See 42.06 § Desktop auth.
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

	const [phase, setPhase] = useState<Phase>("loading");
	const [label, setLabel] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

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
