// SPDX-License-Identifier: Apache-2.0
import { hc } from "hono/client";
import type { AppType } from "../../../../apps/api/src/index.js";

/**
 * Runtime injected by a packaged Anthers shell — the desktop app or the mobile app — on
 * `globalThis.__ANTHERS_NATIVE__`.
 *
 * A Tauri window serves from `tauri://localhost` (macOS, Linux, iOS) or
 * `http://tauri.localhost` (Windows, Android), where host-sniffing cannot work and the
 * `.anthers.org` session cookie is never sent — so the shell supplies the API origin
 * explicitly and carries the session as a bearer token instead. See
 * `apps/api/src/middleware/bearer.ts`.
 *
 * `platform` is what stops every shell from being treated as a desktop: a phone must not
 * inherit the desktop's home preference or its own settings section. `fetch` is optional
 * and is where `tauri-plugin-http` goes: routing requests through Rust means CORS never
 * enters the picture and the token need not live in JS.
 */
export type NativePlatform = "desktop" | "android" | "ios";

export interface NativeRuntime {
	/** Which shell this is. */
	platform: NativePlatform;
	/** Absolute API origin, e.g. "https://anthers.org". No trailing slash. */
	apiBaseUrl: string;
	/** The session token, or null before sign-in completes. */
	getToken(): string | null;
	/** Replace the token the shell holds, where the shell keeps it outside JS. */
	setToken?(token: string | null): void;
	/** Optional replacement transport (tauri-plugin-http). Defaults to global fetch. */
	fetch?: typeof fetch;
}

/** The desktop shell's original shape, from before the runtime carried a platform. */
interface LegacyDesktopRuntime {
	apiBaseUrl: string;
	getToken(): string | null;
	setToken?(token: string | null): void;
	fetch?: typeof fetch;
}

/**
 * The shell's runtime, or null in a browser.
 *
 * ⚠️ **`__ANTHERS_DESKTOP__` is still read, as desktop.** The desktop bundles the web
 * build it was released with, so the two normally move together — but reading the old
 * name costs one line and makes this change safe against a shell that has not taken the
 * new one yet, which is exactly the window between two releases.
 */
export function nativeRuntime(): NativeRuntime | null {
	if (typeof globalThis === "undefined") return null;
	const g = globalThis as {
		__ANTHERS_NATIVE__?: NativeRuntime;
		__ANTHERS_DESKTOP__?: LegacyDesktopRuntime;
	};
	if (g.__ANTHERS_NATIVE__) return g.__ANTHERS_NATIVE__;
	const legacy = g.__ANTHERS_DESKTOP__;
	return legacy ? { ...legacy, platform: "desktop" } : null;
}

/** True in any packaged shell — desktop, Android or iOS — and false in a browser. */
export function isNative(): boolean {
	return nativeRuntime() !== null;
}

/** True only in the desktop shell, for the surfaces that really are the desktop's own. */
export function isDesktop(): boolean {
	return nativeRuntime()?.platform === "desktop";
}

/** True on a phone, where the cookie a browser would carry does not exist either. */
export function isMobile(): boolean {
	const platform = nativeRuntime()?.platform;
	return platform === "android" || platform === "ios";
}

/**
 * Auth headers for transports that CANNOT go through `apiFetch` — specifically the
 * XHR uploads, which exist only because `fetch` has no upload-progress event.
 *
 * Anything bypassing `apiFetch` bypasses the bearer header with it, and in a shell there
 * is no cookie to fall back on, so the request simply 401s. Use this together with
 * `apiSendsCookies()` wherever a raw request is unavoidable.
 */
export function apiAuthHeaders(): Record<string, string> {
	const token = nativeRuntime()?.getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Whether a raw request should carry cookies. False in any shell: there is no cookie,
 * and asking for credentialed CORS there only invites a preflight rejection.
 */
export function apiSendsCookies(): boolean {
	return !isNative();
}

/**
 * Resolve the API origin for whichever app consumes this client.
 *
 * The API and the SPA share the apex origin (anthers.org), so in a browser this is
 * almost always same-origin:
 *   - a packaged shell    → whatever origin it injected (host-sniffing can't work
 *     from `tauri://localhost`, which would otherwise resolve to the app itself)
 *   - localhost / 127.0.0.1 → the dev API, on :8000 or the port the page announces
 *   - a named local URL   → `api.<host>` — portless serves web as `<project>.localhost`
 *     and api as `api.<project>.localhost`, so the two share `.localhost` as a parent.
 *   - otherwise             → same-origin ("")
 *
 * 🚨 **Mirroring the page's own host, whatever it is, is what matters** because cookies are
 * host-scoped and `127.0.0.1` is a different host from `localhost` *and* from
 * `<name>.localhost`. Pinning to one cost the Bluesky signup entirely on 2026-09-04: the
 * ATProto spec permits only `127.0.0.1` / `[::1]` for a loopback client's redirect, so the
 * dev OAuth callback landed on `127.0.0.1:8000` while every other call went to
 * `localhost:8000` — the pending-signup cookie was written on one host and read on the
 * other, so the finishing page found an empty row. Under portless the two halves share
 * `.<name>.localhost` as a parent and the split goes away.
 *
 * There was a `studio.<host>` branch until 2026-08-11 that stripped the label to reach
 * the apex API, because the Studio was a separate cross-origin subdomain. It merged into
 * this app at `/studio`; the subdomain is gone and nothing serves it.
 */
export function apiBaseUrl(): string {
	const native = nativeRuntime();
	if (native) return native.apiBaseUrl.replace(/\/$/, "");
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
	if (h === "localhost" || h === "127.0.0.1") return `http://${h}:${devApiPort()}`;
	if (h.endsWith(".localhost")) {
		// A portless host carries the project in its name — the API lives on its own
		// subdomain of that, so both sides share a parent and cookies scope correctly
		// across the bounce.
		//
		// A git worktree's apps get the branch as a first label (`<branch>.anthers.localhost`
		// for the site), so the API's `api.` label is inserted AFTER the branch label, not at
		// the front — matching what portless actually serves and what `origins.ts` derives
		// from the API's own PORTLESS_URL. A naked prefix produced `api.<branch>.anthers.localhost`,
		// which nothing serves, and every SPA call from a worktree-browsed page died at preflight.
		//
		// An app served on its own subdomain carries its own label there (`admin.anthers`,
		// worktree form `<branch>.admin.anthers`), and its API name substitutes that app
		// label with `api` rather than inserting beside it — `<branch>.admin.anthers`
		// derives `<branch>.api.anthers`, because `api.<branch>.admin.anthers` is a
		// four-label host the proxy serves nothing on (found 2026-10-10: every dev-browsed
		// page of the admin app died at preflight, at the main checkout too, where the
		// same derivation made `admin.api.anthers.localhost`; the site is unaffected
		// because it has no app label to substitute).
		const name = h.slice(0, -".localhost".length);
		const labels = name.split(".");
		const project = labels.pop();
		if (!project) return "";
		const appLabel = labels.at(-1);
		if (appLabel === "admin") labels.pop();
		const apiName = [...labels, "api", project].join(".");
		return `https://${apiName}.localhost`;
	}
	return "";
}

/**
 * The port of the API behind a page served from localhost: `:8000` for `make dev`, or whatever
 * the page's own server says.
 *
 * ⚠️ **A browser test run picks a free port for its API**, so it can run beside `make dev` and
 * beside another run, and its preview server announces that port in a
 * `<meta name="anthers-dev-api-port">` tag (`apps/web/serve.ts`). Nothing else serves the tag, and
 * only a localhost page reads it, so a deployed page cannot be pointed anywhere by one.
 */
export function devApiPort(
	doc: Pick<Document, "querySelector"> | undefined = globalThis.document,
): string {
	const announced = doc
		?.querySelector('meta[name="anthers-dev-api-port"]')
		?.getAttribute("content");
	return announced && /^\d{2,5}$/.test(announced) ? announced : "8000";
}

/**
 * The transport every API call goes through — pass an API path ("/api/…").
 *
 * In a browser this is plain `fetch` with cookies attached. In a shell it swaps the
 * implicit cookie for an explicit `Authorization: Bearer` header, and (when the shell
 * supplies one) routes through `tauri-plugin-http` so the request leaves from Rust and
 * CORS never applies.
 *
 * The URL is re-rooted on `apiBaseUrl()` per-request rather than at module load. That
 * matters twice: it lets the Studio subdomain reach the apex API from a relative path,
 * and it survives the shell injecting its runtime after this module was first
 * evaluated — otherwise a baked-in base would silently win and the app would talk to
 * itself. Only API paths belong here; it is not a general-purpose fetch.
 */
export function apiFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
	const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const parsed = new URL(rawUrl, "http://relative.invalid");
	const url = `${apiBaseUrl()}${parsed.pathname}${parsed.search}`;

	const native = nativeRuntime();
	if (!native) {
		return fetch(url, { credentials: "include", ...init });
	}

	const token = native.getToken();
	const headers = new Headers(
		init.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	if (token) headers.set("Authorization", `Bearer ${token}`);

	// No `credentials: "include"` — there is no cookie to send, and asking for one
	// only invites a CORS preflight we don't need.
	return (native.fetch ?? fetch)(url, { ...init, headers });
}

export const client = hc<AppType>(apiBaseUrl(), {
	// Send cookies for session auth (cross-origin on the Studio); on the desktop this
	// swaps to a bearer header instead — see apiFetch.
	fetch: apiFetch,
});
