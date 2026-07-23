// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate, useLocation } from "react-router-dom";

/**
 * Gate a route behind the platform-admin flag. Logged-out visitors go to login;
 * signed-in non-admins are sent home — the admin surface isn't advertised (the
 * API mirrors this by 404-ing non-admins). Use for the ops console only.
 */
export default function AdminRoute({ children }: { children: React.ReactNode }) {
	const { user, isAuthenticated, isLoading } = useAuth();
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

	if (!user?.isAdmin) {
		return <Navigate to="/feed" replace />;
	}

	return <>{children}</>;
}
