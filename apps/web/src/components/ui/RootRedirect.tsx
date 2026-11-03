// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "@anthers/web-shared/auth";
import { desktopHome } from "@anthers/web-shared/desktop";
import { isDesktop, isNative } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate } from "react-router-dom";
import { userTabPath } from "../../lib/user-tabs";
import ForUsersPage from "../../pages/ForUsersPage";
import AppSignIn from "../auth/AppSignIn";

/**
 * Handles the / route:
 * - A packaged shell opens at the app's front door: signed out, the sign-in handoff;
 *   signed in, the account's starting tab (a desktop that chose the Studio gets that)
 * - Authenticated browsers are redirected to their account's starting tab — Discovery
 *   unless they chose another in Settings
 * - Unauthenticated browsers see the For Users page, which serves as the homepage
 *
 * 🚨 **A shell is not a browser with a shorter address bar, and `/` is where that shows.**
 * A packaged window has no address bar, no back button and no way to reach the marketing
 * pages by typing; launching into the pitch is the wrong door for somebody who already
 * installed the app. So a shell opens at what the person came for: the app, or the sign-in
 * that gets them into it. The marketing pages stay reachable by link.
 */
export default function RootRedirect() {
	const { user, isAuthenticated, isLoading } = useAuth();
	const native = isNative();

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	/**
	 * The shells bundle this same build and open it at `/`, so this decides what the app
	 * actually IS on launch — on a phone as much as on the desktop.
	 *
	 * It used to send every desktop launch to `/studio` unconditionally — the app was the
	 * Studio and nothing else, even though the bundle has always carried the whole SPA.
	 * Anthers Desktop is the whole platform now, so the default is the user's side and
	 * the Studio is a preference. ⚠️ **That preference is the desktop's alone**: a phone
	 * has no Studio setting and does not read the desktop's stored answer.
	 *
	 * 🚨 An unauthenticated launch renders the sign-in handoff INLINE rather than routing
	 * to `/login`. A shell cannot navigate away: `/login` is a normal route, but the
	 * shell's sign-in is an in-app-browser handoff (`AppSignIn`), and a packaged window
	 * that follows an ordinary login flow abandons the bundled SPA for a page it cannot
	 * come back from. `StudioAuthGate` already makes exactly this distinction for
	 * `/studio`; `/` needs it too now that `/` is a real destination in a shell.
	 *
	 * Kept as a CLIENT-SIDE redirect rather than pointing the Tauri window at a deep path,
	 * because a packaged window serves from `tauri://localhost` through the asset protocol,
	 * which resolves paths to files — a deep path has no matching file and does not
	 * necessarily fall back to `index.html`. Routing after the document loads sidesteps
	 * that: the document is always `/`, and the router does the rest.
	 */
	if (native) {
		if (!isAuthenticated) return <AppSignIn />;
		const home =
			isDesktop() && desktopHome() === "studio" ? "/studio" : userTabPath(user?.homeDefaultTab);
		return <Navigate to={home} replace />;
	}

	if (isAuthenticated) {
		// The account's starting tab is the landing surface of the signed-in site. An
		// account that never chose lands on Discovery, the client's default; the settings
		// page is the only control, so a session is never sent somewhere it cannot name.
		return <Navigate to={userTabPath(user?.homeDefaultTab)} replace />;
	}

	return <ForUsersPage />;
}
