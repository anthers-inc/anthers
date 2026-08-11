// SPDX-License-Identifier: AGPL-3.0-or-later
import { Navigate, useLocation } from "react-router-dom";

/**
 * Legacy `/dashboard/*` paths, kept as a safety net for bookmarks and stale links.
 *
 * These used to hard-navigate to `studio.anthers.org`, a separate origin. The Studio is a
 * section of this app now, so the same mapping is an in-app redirect: strip `/dashboard`
 * and land under `/studio` (`/dashboard/analytics` → `/studio/analytics`, `/dashboard` →
 * `/studio`). Client-side, so it costs no round trip and keeps the history entry tidy via
 * `replace`.
 */
export default function StudioRedirect() {
	const { pathname, search } = useLocation();
	const rest = pathname.replace(/^\/dashboard/, "");
	return <Navigate to={`/studio${rest}${search}`} replace />;
}
