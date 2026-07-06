// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { consumerOrigin } from "../lib/consumer";

/**
 * The Studio is the creator management surface, so its pages require a signed-in
 * *creator*. It shares the consumer session (the `.anthers.org`-scoped cookie; see
 * epic E50) but has no login of its own, and creator mode is enabled on the consumer
 * site. So:
 *   - not signed in            → consumer /login
 *   - signed in, not a creator → consumer /settings (where creator mode is enabled)
 *   - signed-in creator        → render
 * While auth resolves, show a spinner rather than flashing the page.
 */
export default function StudioAuthGate({ children }: { children: ReactNode }) {
	const { user, isAuthenticated, isLoading } = useAuth();
	const isCreator = Boolean(user?.isCreator);

	useEffect(() => {
		if (isLoading) return;
		if (!isAuthenticated) {
			window.location.href = `${consumerOrigin()}/login`;
		} else if (!isCreator) {
			window.location.href = `${consumerOrigin()}/settings`;
		}
	}, [isLoading, isAuthenticated, isCreator]);

	if (isLoading || !isAuthenticated || !isCreator) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return <>{children}</>;
}
