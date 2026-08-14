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
