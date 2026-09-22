// SPDX-License-Identifier: Apache-2.0
import { isPublicDeployment } from "./lib/deployment.js";

/**
 * The origins a packaged desktop Studio window serves from. Tauri uses a custom
 * scheme on Linux/macOS and a localhost-shaped one on Windows.
 *
 * Admitting these is safe *because* the desktop app authenticates by bearer token,
 * never by cookie: its requests are non-credentialed, so allowlisting the origin
 * grants no ambient authority. (`apps/api/src/middleware/bearer.ts` rejected an earlier version of this idea, on
 * the grounds that the cookie still wouldn't be sent and it would have forced
 * `SameSite=None` — that reasoning applied to keeping cookie auth, which we didn't.)
 * These are constants present in every Tauri app, so they identify nothing and are
 * not a credential; the bearer token is.
 */
const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

/**
 * Origins allowed to make credentialed requests to the API — the site (`FRONTEND_URL`)
 * plus the desktop Studio's own origins. Shared by CORS and CSRF so they never drift.
 * Localhost dev origins are added only when this is not a public deployment.
 *
 * 🚨 **That condition read `NODE_ENV === "production"` until 2026-08-23, and `NODE_ENV` is
 * set nowhere in this app** — so production took the other branch and admitted
 * `http://localhost:3000`, `:3001`, `:4173` and `:8000` as **credentialed** origins on
 * `anthers.org`. Any page served from localhost on a visitor's machine could therefore make
 * credentialed cross-origin requests to the live API, read the responses, and pass the CSRF
 * origin check. `isPublicDeployment()` detects the deployment itself rather than a label
 * describing it; the reasoning is in `lib/deployment.ts`.
 *
 * `STUDIO_URL` was here until 2026-08-11, for the Studio's separate subdomain. The Studio
 * is a section of the site now (`/studio`), so it is same-origin and needs no entry — and
 * an allowlist entry for a host that no longer resolves is worse than none, because it
 * reads as intentional.
 */
export function allowedOrigins(): string[] {
	const configured = [process.env.FRONTEND_URL].filter((o): o is string => !!o);
	if (isPublicDeployment()) return [...new Set([...configured, ...DESKTOP_ORIGINS])];
	return [
		...new Set([
			...configured,
			...DESKTOP_ORIGINS,
			"http://localhost:3000",
			"http://localhost:3001",
			// 🚨 The `127.0.0.1` spellings are NOT duplicates — a browser treats them as a
			// different host from `localhost`, and the ATProto loopback client is required to
			// register `127.0.0.1` for its redirect. Dev is served from `127.0.0.1:3000` so the
			// OAuth round trip and everything around it share one cookie jar.
			"http://127.0.0.1:3000",
			"http://127.0.0.1:3001",
			"http://127.0.0.1:4173",
			"http://127.0.0.1:4174",
			"http://127.0.0.1:8000",
			// The Playwright e2e preview (apps/web build + serve) — the SPA client targets
			// localhost:8000 from any localhost page, so e2e needs CORS/CSRF passage too.
			"http://localhost:4173",
			// The admin app's preview, beside the site's in a browser run without a session.
			"http://localhost:4174",
			// 🚨 The portless path: when the dev proxy serves web/admin from a named host,
			// api.<name>.localhost is the API's own origin, so the page's credentialed call
			// back to it passes CORS. Without these, the new dev URLs return the request as
			// cross-origin and fail preflight.
			"https://anthers.localhost",
			"https://api.anthers.localhost",
			"https://admin.anthers.localhost",
			// The per-worktree forms the proxy allocates under portless, derived from this API's
			// own PORTLESS_URL: a worktree's web app answers at `<worktree>.anthers.localhost`
			// while this API answers at `<worktree>.api.anthers.localhost`, and the page's
			// credentialed call to the API carries the web origin. Dev-only by the guard above —
			// PORTLESS_URL is unset outside the proxy and these only ever name `.localhost`.
			...portlessWorktreeOrigins(),
			// The API itself serves spike test pages that make credentialed requests back
			// to the API. Dev-only — no production page is served from the API origin.
			"http://localhost:8000",
			...sessionPreviewOrigins(),
		]),
	];
}

/**
 * The named dev origins a worktree serves under portless, derived from this process's own
 * `PORTLESS_URL` — which names the API (`https://<worktree>.api.anthers.localhost`), so the
 * sibling web and admin origins follow from it. Empty outside the proxy.
 */
function portlessWorktreeOrigins(): string[] {
	const url = process.env.PORTLESS_URL ?? "";
	const m = /^https:\/\/(.+)\.api\.anthers\.localhost$/.exec(url);
	if (!m) return [];
	const worktree = m[1];
	return [`https://${worktree}.anthers.localhost`, `https://${worktree}.admin.anthers.localhost`];
}

/**
 * The preview origin of the browser test session this API belongs to, which took a free port
 * rather than :4173 so that runs can overlap (`scripts/session.ts`). Exactly that one port, never a
 * range: a local API accepting credentialed requests from every localhost page would trust
 * whatever else a developer has running.
 */
function sessionPreviewOrigins(): string[] {
	// The site's preview and the admin app's, which a browser run starts side by side.
	return [process.env.PREVIEW_PORT, process.env.ADMIN_PREVIEW_PORT]
		.filter((port): port is string => !!port && /^\d{2,5}$/.test(port))
		.flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}
