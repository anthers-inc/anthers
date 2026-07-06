// SPDX-License-Identifier: AGPL-3.0-or-later
import { hc } from "hono/client";
import type { AppType } from "../../../../apps/api/src/index.js";

/**
 * Resolve the API origin for whichever app consumes this client.
 *
 * The API and the consumer SPA share the apex origin (anthers.org); the Studio is
 * a separate, cross-origin subdomain (studio.anthers.org). So:
 *   - localhost / 127.0.0.1 → the dev API on :8000
 *   - studio.<host>         → strip the `studio.` label to reach the apex API. This
 *     is a credentialed cross-origin call; CORS + the `.anthers.org`-scoped session
 *     cookie make the shared login work (see epic E50 — Creator Studio).
 *   - otherwise             → same-origin ("") — the consumer site on the apex.
 */
export function apiBaseUrl(): string {
	if (typeof location === "undefined") return "";
	const h = location.hostname;
	if (h === "localhost" || h === "127.0.0.1") return "http://localhost:8000";
	if (h.startsWith("studio.")) return `${location.protocol}//${h.slice("studio.".length)}`;
	return "";
}

export const client = hc<AppType>(apiBaseUrl(), {
	init: {
		credentials: "include", // Send cookies for session auth (cross-origin on the Studio)
	},
});
