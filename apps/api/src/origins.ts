// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Origins allowed to make credentialed requests to the API — the consumer site
 * (`FRONTEND_URL`) and the Creator Studio (`STUDIO_URL`, a separate subdomain).
 * Shared by CORS and CSRF so they never drift. Localhost dev origins for both apps
 * are added outside production.
 */
export function allowedOrigins(): string[] {
	const configured = [process.env.FRONTEND_URL, process.env.STUDIO_URL].filter(
		(o): o is string => !!o,
	);
	if (process.env.NODE_ENV === "production") return [...new Set(configured)];
	return [...new Set([...configured, "http://localhost:3000", "http://localhost:3001"])];
}
