// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { studioOrigin } from "../../lib/studio";

/**
 * Creator tooling moved to the Studio (studio.anthers.org, a separate origin). The old
 * in-site `/dashboard/*` routes are kept as a safety net for bookmarks/stale links and
 * hard-redirect to the Studio equivalent — the Studio's root IS the dashboard, so we
 * just strip the `/dashboard` prefix (`/dashboard/analytics` → `/analytics`,
 * `/dashboard` → `/`).
 */
export default function StudioRedirect() {
	const { pathname, search } = useLocation();

	useEffect(() => {
		const studioPath = pathname.replace(/^\/dashboard/, "") || "/";
		window.location.href = `${studioOrigin()}${studioPath}${search}`;
	}, [pathname, search]);

	return (
		<div className="flex justify-center items-center min-h-[60vh] text-base-content/60">
			Opening the Studio…
		</div>
	);
}
