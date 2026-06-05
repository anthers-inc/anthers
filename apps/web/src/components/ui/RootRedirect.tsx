// SPDX-License-Identifier: AGPL-3.0-or-later
import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import HomePage from "../../pages/HomePage";
import LoadingSpinner from "./LoadingSpinner";

/**
 * Handles the / route:
 * - Authenticated users are redirected to /feed
 * - Unauthenticated users see the marketing landing page
 */
export default function RootRedirect() {
	const { isAuthenticated, isLoading } = useAuth();

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (isAuthenticated) {
		return <Navigate to="/feed" replace />;
	}

	return <HomePage />;
}
