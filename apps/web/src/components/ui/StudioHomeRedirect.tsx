// SPDX-License-Identifier: Apache-2.0
import { useAuth } from "@anthers/web-shared/auth";
import { profileUrl } from "@anthers/web-shared/profile";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Navigate } from "react-router-dom";

/**
 * `/studio` itself, which used to be the Studio's Dashboard page.
 *
 * ⭐ **The Dashboard is a tab on the creator's own profile now** (Parker, 2026-10-23), so the
 * Studio's root has no page of its own and sends a creator to that profile with the tab open.
 * It stays a route rather than being deleted because the address is a destination in the world:
 * `RootRedirect` sends a desktop app whose home is the Studio here, the creator side of the mode
 * switch goes through it, and `/dashboard/* → /studio/*` lands on it.
 *
 * ⚠️ **The gate has already run** — this renders inside `StudioAuthGate`, so a signed-in
 * creator is the only case that arrives. The spinner covers the frame before auth resolves,
 * when the gate is still deciding, and a handle-less account falls back to the Studio's Works
 * page rather than composing a profile URL out of nothing.
 */
export default function StudioHomeRedirect() {
	const { user, isLoading } = useAuth();

	if (isLoading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!user?.handle) return <Navigate to="/studio/works" replace />;
	return <Navigate to={`${profileUrl(user.handle)}?tab=dashboard`} replace />;
}
