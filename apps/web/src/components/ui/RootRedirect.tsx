// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "@anthers/web-shared/auth";
import { desktopHome } from "@anthers/web-shared/desktop";
import { isDesktop } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate } from "react-router-dom";
import { userTabPath } from "../../lib/user-tabs";
import ForUsersPage from "../../pages/ForUsersPage";
import DesktopSignIn from "../../studio/DesktopSignIn";

/**
 * Handles the / route:
 * - The desktop app opens at the user's chosen surface — the Studio if they set it,
 *   otherwise the account's starting tab (see `desktopHome`)
 * - Authenticated users are redirected to their account's starting tab — Network unless
 *   they chose another in Settings
 * - Unauthenticated users see the For Users page, which serves as the homepage
 */
export default function RootRedirect() {
	const { user, isAuthenticated, isLoading } = useAuth();
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
	 * Anthers Desktop is the whole platform now, so the default is the user's side and
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
		return (
			<Navigate
				to={desktopHome() === "studio" ? "/studio" : userTabPath(user?.homeDefaultTab)}
				replace
			/>
		);
	}

	if (isAuthenticated) {
		// The account's starting tab is the landing surface of the signed-in site. An
		// account that never chose lands on Network, the client's default; the settings
		// page is the only control, so a session is never sent somewhere it cannot name.
		return <Navigate to={userTabPath(user?.homeDefaultTab)} replace />;
	}

	return <ForUsersPage />;
}
