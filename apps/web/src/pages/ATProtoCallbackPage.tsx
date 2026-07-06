// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

const ERROR_MESSAGES: Record<string, string> = {
	missing_params: "Missing authorization parameters.",
	session_expired: "Session expired. Please try again.",
	state_mismatch: "Security check failed. Please try again.",
	auth_failed: "Authentication failed.",
	exchange_failed: "Failed to complete Bluesky authentication.",
	not_authenticated: "You must be logged in to link a Bluesky account.",
	did_already_linked: "This Bluesky account is already linked to another user.",
};

export default function ATProtoCallbackPage() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { refreshUser } = useAuth();
	const [error, setError] = useState<string | null>(null);

	const success = searchParams.get("success");
	const errorParam = searchParams.get("error");

	useEffect(() => {
		if (errorParam) {
			setError(ERROR_MESSAGES[errorParam] || errorParam);
			return;
		}

		if (success === "login") {
			// Successfully logged in via Bluesky—refresh user and redirect
			refreshUser().then(() => {
				navigate("/feed", { replace: true });
			});
			return;
		}

		if (success === "linked") {
			// Successfully linked Bluesky account—refresh user and redirect to settings
			refreshUser().then(() => {
				navigate("/settings?bluesky=linked", { replace: true });
			});
			return;
		}

		// Unknown state
		setError("Unexpected callback state.");
	}, [success, errorParam, refreshUser, navigate]);

	if (error) {
		return (
			<div className="container mx-auto px-4 py-16 text-center max-w-md">
				<div className="card bg-base-200">
					<div className="card-body">
						<h2 className="card-title justify-center text-lg">Bluesky Authentication Failed</h2>
						<p className="text-sm text-base-content/60">{error}</p>
						<div className="card-actions justify-center mt-4">
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={() => navigate("/login", { replace: true })}
							>
								Back to Login
							</button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex justify-center items-center min-h-[60vh]">
			<div className="text-center">
				<LoadingSpinner size="lg" />
				<p className="mt-4 text-sm text-base-content/60">Completing Bluesky authentication...</p>
			</div>
		</div>
	);
}
