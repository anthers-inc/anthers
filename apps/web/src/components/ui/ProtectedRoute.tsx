// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate, useLocation } from "react-router-dom";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
	const { isAuthenticated, isLoading, user } = useAuth();
	const location = useLocation();

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!isAuthenticated) {
		return <Navigate to="/login" state={{ from: location }} replace />;
	}

	/*
	 * An account can be signed in and still have no handle: the signup ceremony creates
	 * it the moment the emailed code checks out, and onboarding claims the name after.
	 *
	 * 🚨 This guard is the real mechanism, not a nicety. Half the logged-in app builds a
	 * profile URL out of `user.username` — the account menu, the analytics rows, the
	 * dashboard's project links — and with a null handle those become links to `/null`.
	 * Rather than teach every one of them a fallback that would never fire in practice,
	 * the tree is closed until the handle exists. `/welcome` is deliberately not wrapped
	 * in this, or it would redirect to itself; it does its own check instead.
	 */
	if (user && user.username === null) {
		return <Navigate to="/welcome" replace />;
	}

	return <>{children}</>;
}
