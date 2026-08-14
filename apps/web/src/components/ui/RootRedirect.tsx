// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { desktopHome } from "@anthers/web-shared/desktop";
import { isDesktop } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate } from "react-router-dom";
import ForUsersPage from "../../pages/ForUsersPage";
import DesktopSignIn from "../../studio/DesktopSignIn";

/**
 * Handles the / route:
 * - The desktop app opens at the reader's chosen home — the feed by default, the
 *   Studio if they set it (see `desktopHome`)
 * - Authenticated users are redirected to /feed
 * - Unauthenticated users see the For Users page, which serves as the homepage
 */
export default function RootRedirect() {
	const { isAuthenticated, isLoading } = useAuth();
	const desktop = isDesktop();

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	/**
	 * The desktop shell bundles this same build and opens it at `/`, so this decides what
	 * the app actually IS on launch.
	 *
	 * It used to send every desktop launch to `/studio` unconditionally — the app was the
	 * Studio and nothing else, even though the bundle has always carried the whole SPA.
	 * Anthers Desktop is the whole platform now, so the default is the reader's feed and
	 * the Studio is a preference.
	 *
	 * 🚨 An unauthenticated desktop launch renders the sign-in handoff INLINE rather than
	 * routing to `/login`. The shell cannot navigate away: `/login` is a normal route, but
	 * the desktop sign-in is an in-app-browser handoff (`DesktopSignIn`), and a packaged
	 * window that follows an ordinary login flow abandons the bundled SPA for a page it
	 * cannot come back from. `StudioAuthGate` already makes exactly this distinction for
	 * `/studio`; `/` needs it too now that `/` is a real destination on desktop.
	 *
	 * Kept as a CLIENT-SIDE redirect rather than pointing the Tauri window at a deep path,
	 * because a packaged window serves from `tauri://localhost` through the asset protocol,
	 * which resolves paths to files — a deep path has no matching file and does not
	 * necessarily fall back to `index.html`. Routing after the document loads sidesteps
	 * that: the document is always `/`, and the router does the rest.
	 */
	if (desktop) {
		if (!isAuthenticated) return <DesktopSignIn />;
		return <Navigate to={desktopHome() === "studio" ? "/studio" : "/feed"} replace />;
	}

	if (isAuthenticated) {
		return <Navigate to="/feed" replace />;
	}

	return <ForUsersPage />;
}
