// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { isDesktop } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate } from "react-router-dom";
import ForUsersPage from "../../pages/ForUsersPage";

/**
 * Handles the / route:
 * - The packaged desktop app goes straight to /studio — it IS the Studio
 * - Authenticated users are redirected to /feed
 * - Unauthenticated users see the For Users page, which serves as the homepage
 */
export default function RootRedirect() {
	const { isAuthenticated, isLoading } = useAuth();

	/**
	 * The desktop shell bundles this same build and opens it at `/`, so without this it
	 * would land on the marketing homepage instead of the Studio.
	 *
	 * Done as a CLIENT-SIDE redirect rather than by pointing the Tauri window at `/studio`,
	 * because a packaged window serves from `tauri://localhost` through the asset protocol,
	 * which resolves paths to files — a deep path has no `studio` file to find and does not
	 * necessarily fall back to `index.html`. Routing after the document loads sidesteps that
	 * entirely: the document is always `/`, and the router does the rest.
	 */
	if (isDesktop()) return <Navigate to="/studio" replace />;

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

	return <ForUsersPage />;
}
