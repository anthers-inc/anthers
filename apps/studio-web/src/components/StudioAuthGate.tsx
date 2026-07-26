// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { consumerOrigin } from "../lib/consumer";
import { isDesktop } from "../lib/desktop";
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

	useEffect(() => {
		if (isLoading || desktop) return;
		if (!isAuthenticated) {
			window.location.href = `${consumerOrigin()}/login`;
		} else if (!isCreator) {
			window.location.href = `${consumerOrigin()}/settings`;
		}
	}, [isLoading, isAuthenticated, isCreator, desktop]);

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
								href={`${consumerOrigin()}/settings`}
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
