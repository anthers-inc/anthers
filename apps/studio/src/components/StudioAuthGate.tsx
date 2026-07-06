// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { consumerOrigin } from "../lib/consumer";

/**
 * Studio pages require a signed-in creator. The Studio shares the consumer session
 * (the `.anthers.org`-scoped cookie; see epic E50) but has no login page of its own —
 * so an unauthenticated visitor is sent to the consumer site's login (a full
 * cross-origin navigation). While auth resolves, show a spinner rather than flashing
 * the form.
 */
export default function StudioAuthGate({ children }: { children: ReactNode }) {
	const { isAuthenticated, isLoading } = useAuth();

	useEffect(() => {
		if (!isLoading && !isAuthenticated) {
			window.location.href = `${consumerOrigin()}/login`;
		}
	}, [isLoading, isAuthenticated]);

	if (isLoading || !isAuthenticated) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return <>{children}</>;
}
