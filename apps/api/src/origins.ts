// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The origins a packaged desktop Studio window serves from. Tauri uses a custom
 * scheme on Linux/macOS and a localhost-shaped one on Windows.
 *
 * Admitting these is safe *because* the desktop app authenticates by bearer token,
 * never by cookie: its requests are non-credentialed, so allowlisting the origin
 * grants no ambient authority. (42.06 rejected an earlier version of this idea, on
 * the grounds that the cookie still wouldn't be sent and it would have forced
 * `SameSite=None` — that reasoning applied to keeping cookie auth, which we didn't.)
 * These are constants present in every Tauri app, so they identify nothing and are
 * not a credential; the bearer token is.
 */
const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

/**
 * Origins allowed to make credentialed requests to the API — the consumer site
 * (`FRONTEND_URL`) and the Creator Studio (`STUDIO_URL`, a separate subdomain), plus
 * the desktop Studio's own origins. Shared by CORS and CSRF so they never drift.
 * Localhost dev origins for both apps are added outside production.
 */
export function allowedOrigins(): string[] {
	const configured = [process.env.FRONTEND_URL, process.env.STUDIO_URL].filter(
		(o): o is string => !!o,
	);
	if (process.env.NODE_ENV === "production")
		return [...new Set([...configured, ...DESKTOP_ORIGINS])];
	return [
		...new Set([
			...configured,
			...DESKTOP_ORIGINS,
			"http://localhost:3000",
			"http://localhost:3001",
			// The Playwright e2e preview (apps/web build + serve) — the SPA client targets
			// localhost:8000 from any localhost page, so e2e needs CORS/CSRF passage too.
			"http://localhost:4173",
		]),
	];
}
