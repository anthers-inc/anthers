// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import LoggedInLayout from "./LoggedInLayout";
import LoggedOutLayout from "./LoggedOutLayout";

/**
 * The single shell for the whole public surface — both the always-marketing pages
 * (For Users / For Creators / About / compare / demos) and the auth-switching
 * shared pages (subscribe, faq, roadmap, resources, creator profiles).
 *
 * Both route groups render THIS component, so React keeps one shell instance
 * mounted across every public navigation instead of tearing it down and rebuilding
 * it (which is what made the botanical decor — vines + grassy floor — repaint and
 * "pop" when you crossed the old LoggedOutLayout↔Layout boundary). Only the
 * <Outlet> content swaps; the shell, its decor, and its scroll survive.
 *
 * `forceMarketing` preserves the intentional distinction the two groups used to
 * encode with different components: marketing pages always show the logged-out
 * chrome (sign up / log in), while shared pages show the app chrome to logged-in
 * users. It's a prop, not a component swap, so the shell type stays stable and the
 * decor never remounts for logged-out visitors.
 *
 * 🚨 **The stability above is across NAVIGATION only. Across a change of AUTH STATE this
 * component unmounts everything beneath it, and that is the trap.** The return below picks
 * `LoggedOutLayout` or `LoggedInLayout`, which are different component types — so React
 * cannot reconcile one into the other and tears down the whole subtree, including the page
 * the user is standing on and all of its state.
 *
 * **So any flow that signs somebody in AND THEN KEEPS WORKING on the same page has this
 * shape, and it fails silently.** The subscribe ceremony is the case that found it: it
 * refreshed the auth context the moment the emailed code verified, the payment modal's
 * state update then landed on an unmounted component, and the modal simply never opened.
 * No error, no warning, no failing test — React discards a state update on an unmounted
 * tree without complaint.
 *
 * ⭐ **The fix is ORDERING, not detection: tell the auth context LAST, once the page is
 * finished with it.** The session cookie is set at verification, so every request in
 * between is already authenticated and nothing needs the context to be current — the
 * context is the only thing that does not know yet, and it does not need to know until
 * the user is leaving the page. Refreshing it early buys nothing and costs the subtree.
 */
export default function PublicShell({ forceMarketing = false }: { forceMarketing?: boolean }) {
	const { isAuthenticated, isLoading } = useAuth();

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-screen">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return forceMarketing || !isAuthenticated ? <LoggedOutLayout /> : <LoggedInLayout />;
}
