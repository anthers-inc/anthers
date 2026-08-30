// SPDX-License-Identifier: AGPL-3.0-or-later
import { hc } from "hono/client";
import type { AppType } from "../../../../apps/api/src/index.js";

/**
 * Runtime injected by the packaged desktop Studio, on `globalThis.__ANTHERS_DESKTOP__`.
 *
 * A Tauri window serves from `tauri://localhost`, where host-sniffing cannot work and
 * the `.anthers.org` session cookie is never sent — so the shell supplies the API
 * origin explicitly and carries the session as a bearer token instead. See
 * 42.06 § Desktop auth.
 *
 * `fetch` is optional and is where `tauri-plugin-http` goes: routing requests through
 * Rust means CORS never enters the picture and the token need not live in JS.
 */
export interface DesktopRuntime {
	/** Absolute API origin, e.g. "https://anthers.org". No trailing slash. */
	apiBaseUrl: string;
	/** The desktop session token, or null before enrollment completes. */
	getToken(): string | null;
	/** Optional replacement transport (tauri-plugin-http). Defaults to global fetch. */
	fetch?: typeof fetch;
}

function desktopRuntime(): DesktopRuntime | null {
	if (typeof globalThis === "undefined") return null;
	return (globalThis as { __ANTHERS_DESKTOP__?: DesktopRuntime }).__ANTHERS_DESKTOP__ ?? null;
}

/** True when running inside the packaged desktop Studio rather than a browser. */
export function isDesktop(): boolean {
	return desktopRuntime() !== null;
}

/**
 * Auth headers for transports that CANNOT go through `apiFetch` — specifically the
 * XHR uploads, which exist only because `fetch` has no upload-progress event.
 *
 * Anything bypassing `apiFetch` bypasses the bearer header with it, and on the desktop
 * there is no cookie to fall back on, so the request simply 401s. Use this together
 * with `apiSendsCookies()` wherever a raw request is unavoidable.
 */
export function apiAuthHeaders(): Record<string, string> {
	const token = desktopRuntime()?.getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Whether a raw request should carry cookies. False on the desktop: there is no
 * cookie, and asking for credentialed CORS there only invites a preflight rejection.
 */
export function apiSendsCookies(): boolean {
	return !isDesktop();
}

/**
 * Resolve the API origin for whichever app consumes this client.
 *
 * The API and the SPA share the apex origin (anthers.org), so in a browser this is
 * almost always same-origin:
 *   - the desktop shell   → whatever origin it injected (host-sniffing can't work
 *     from `tauri://localhost`, which would otherwise resolve to the app itself)
 *   - localhost / 127.0.0.1 → the dev API on :8000
 *   - otherwise             → same-origin ("")
 *
 * There was a `studio.<host>` branch until 2026-08-11 that stripped the label to reach
 * the apex API, because the Studio was a separate cross-origin subdomain. It merged into
 * this app at `/studio`; the subdomain is gone and nothing serves it.
 */
export function apiBaseUrl(): string {
	const desktop = desktopRuntime();
	if (desktop) return desktop.apiBaseUrl.replace(/\/$/, "");
	if (typeof location === "undefined") return "";
	const h = location.hostname;
	// 🚨 **Mirror the page's own host rather than pinning `localhost`, because cookies are
	// host-scoped and `127.0.0.1` is a different host.** Pinning cost the Bluesky signup
	// entirely: the ATProto spec permits only `127.0.0.1` / `[::1]` for a loopback client's
	// redirect, never `localhost`, so the dev OAuth callback lands on `127.0.0.1:8000` while
	// every other call went to `localhost:8000`. The pending-signup cookie was written on one
	// host and read on the other, so the finishing page found an empty row and asked for an
	// address Bluesky had already given us. Serve dev from `http://127.0.0.1:3000` and the
	// whole flow stays on one host.
	if (h === "localhost" || h === "127.0.0.1") return `http://${h}:8000`;
	return "";
}

/**
 * The transport every API call goes through — pass an API path ("/api/…").
 *
 * In a browser this is plain `fetch` with cookies attached. On the desktop it swaps
 * the implicit cookie for an explicit `Authorization: Bearer` header, and (when the
 * shell supplies one) routes through `tauri-plugin-http` so the request leaves from
 * Rust and CORS never applies.
 *
 * The URL is re-rooted on `apiBaseUrl()` per-request rather than at module load. That
 * matters twice: it lets the Studio subdomain reach the apex API from a relative path,
 * and it survives the desktop shell injecting its runtime after this module was first
 * evaluated — otherwise a baked-in base would silently win and the app would talk to
 * itself. Only API paths belong here; it is not a general-purpose fetch.
 */
export function apiFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
	const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const parsed = new URL(rawUrl, "http://relative.invalid");
	const url = `${apiBaseUrl()}${parsed.pathname}${parsed.search}`;

	const desktop = desktopRuntime();
	if (!desktop) {
		return fetch(url, { credentials: "include", ...init });
	}

	const token = desktop.getToken();
	const headers = new Headers(
		init.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	if (token) headers.set("Authorization", `Bearer ${token}`);

	// No `credentials: "include"` — there is no cookie to send, and asking for one
	// only invites a CORS preflight we don't need.
	return (desktop.fetch ?? fetch)(url, { ...init, headers });
}

export const client = hc<AppType>(apiBaseUrl(), {
	// Send cookies for session auth (cross-origin on the Studio); on the desktop this
	// swaps to a bearer header instead — see apiFetch.
	fetch: apiFetch,
});
