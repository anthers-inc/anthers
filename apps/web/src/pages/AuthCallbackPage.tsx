// SPDX-License-Identifier: Apache-2.0

import { usePageTitle } from "@anthers/web-shared/page-title";
import Logo from "@anthers/web-shared/ui/Logo";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * The phone's sign-in callback landing (route: `/auth/callback`).
 *
 * A packaged shell asked for this URL from the system browser, and the browser only goes back
 * to the app on its own when the app is the **verified** handler for `anthers.org` — which it
 * is for a release-signed build and is not for a debug one, and is never taken for granted on
 * a device that failed its link verification at install time. When the handoff does not
 * happen, the person is left looking at this URL in Chrome.
 *
 * So this page does the handoff the other way: `anthers://auth/callback?code=…` is the app's
 * own scheme, which no verification stands in front of. The code in the URL is useless on its
 * own — redeeming it needs the PKCE verifier the app kept, and the app is also polling the
 * server for the approval — so the worst a stray app that claims the scheme can do is take
 * the handoff and leave the sign-in to be finished in the real app.
 *
 * ⚠️ **Nothing here signs anybody in.** It is a door, and the app behind it is what mints the
 * session.
 */
export default function AuthCallbackPage() {
	usePageTitle("Finishing Sign-In");
	const [params] = useSearchParams();
	const code = params.get("code");
	const [attempted, setAttempted] = useState(false);

	const openApp = useCallback(() => {
		if (!code) return;
		window.location.href = `anthers://auth/callback?code=${encodeURIComponent(code)}`;
	}, [code]);

	useEffect(() => {
		if (!code) return;
		setAttempted(true);
		// One automatic try, then the button is the person's own retry. A loop of redirects on
		// a phone with no app installed is a page that cannot be read or left.
		const timer = setTimeout(openApp, 500);
		return () => clearTimeout(timer);
	}, [code, openApp]);

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 safe-top safe-sides">
			<Logo variant="stacked" className="h-24" />
			<div className="card w-full max-w-sm bg-base-200 shadow-lg">
				<div className="card-body items-center gap-3 text-center">
					<h1 className="card-title text-xl">{code ? "Finish signing in" : "Nothing to finish"}</h1>
					{code ? (
						<>
							<p className="text-sm text-base-content/70">
								The Anthers app finishes this sign-in. If it did not open, use the button.
							</p>
							<button type="button" className="btn btn-primary w-full" onClick={openApp}>
								Open Anthers
							</button>
							{attempted && (
								<p className="text-xs text-base-content/50">
									The app also finishes on its own when you switch back to it.
								</p>
							)}
						</>
					) : (
						<p className="text-sm text-base-content/70">
							This address finishes a sign-in that started in the Anthers app.
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
