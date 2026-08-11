// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import { isDesktop } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import DesktopSignIn from "./DesktopSignIn";

/**
 * The Studio is the creator management surface, so its pages require a signed-in
 * *creator*. It shares the consumer session (the `.anthers.org`-scoped cookie; see
 * epic E50) but has no login of its own, and creator mode is enabled on the consumer
 * site. So:
 *   - not signed in            → consumer /login
 *   - signed in, not a creator → consumer /settings (where creator mode is enabled)
 *   - signed-in creator        → render
 * While auth resolves, show a spinner rather than flashing the page.
 *
 * The desktop shell cannot navigate away: sending the window to anthers.org would
 * abandon the bundled SPA for a page the app can't come back from. There, an
 * unauthenticated creator gets the in-app browser handoff instead, and a non-creator
 * gets a link that opens the consumer settings in their real browser.
 */
export default function StudioAuthGate({ children }: { children: ReactNode }) {
	const { user, isAuthenticated, isLoading } = useAuth();
	const isCreator = Boolean(user?.isCreator);
	const desktop = isDesktop();

	// In a browser these are ordinary in-app routes now — the Studio is a section of this
	// app, not a separate origin, so what used to be a cross-origin `window.location.href`
	// is a client-side redirect that keeps the session, the history entry and the bundle.
	if (!desktop && !isLoading && !isAuthenticated) return <Navigate to="/login" replace />;
	if (!desktop && !isLoading && !isCreator) return <Navigate to="/settings" replace />;

	if (desktop && !isLoading && !isAuthenticated) {
		return <DesktopSignIn />;
	}

	if (desktop && !isLoading && !isCreator) {
		return (
			<div className="min-h-dvh flex items-center justify-center px-4">
				<div className="card bg-base-200 w-full max-w-md">
					<div className="card-body">
						<h1 className="card-title text-xl">Creator mode isn't on yet</h1>
						<p className="text-sm text-base-content/60">
							The Studio is for creators. Turn on creator mode in your account settings, then reopen
							this app.
						</p>
						<div className="card-actions mt-4">
							<a
								href="https://anthers.org/settings"
								target="_blank"
								rel="noreferrer"
								className="btn btn-primary btn-sm"
							>
								Open account settings
							</a>
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (isLoading || !isAuthenticated || !isCreator) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return <>{children}</>;
}
