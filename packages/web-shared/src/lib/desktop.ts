// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The web side of the desktop-shell bridge.
 *
 * Lives here rather than in an app because the SAME build serves the browser and is
 * bundled into the Tauri shell, and because `@tauri-apps/api` is already a dependency of
 * this package (imported dynamically, so a browser build never loads it). Everything here
 * is guarded: in a browser `isDesktop()` is false and none of it runs. The shell injects `globalThis.__ANTHERS_DESKTOP__` before any app
 * JS (see `apps/desktop/src-tauri/src/main.rs`), which is also what
 * `@anthers/web-shared`'s `apiFetch()` reads to pick its transport.
 *
 * `@tauri-apps/api` is imported dynamically so the browser build never loads it.
 */
import { isDesktop } from "./rpc";

export { isDesktop };

/**
 * Where the desktop app opens after sign-in.
 *
 * A **per-install** preference rather than an account setting, deliberately: the same
 * person reasonably wants the Studio on the machine they author on and the feed on the
 * one they read on, and an account-level setting would force one answer onto both.
 * That is also why it lives in `localStorage` beside `anthers_theme` rather than on the
 * user record.
 *
 * Meaningless in a browser — nothing reads it there, because the browser has a real
 * homepage and an address bar.
 */
export type DesktopHome = "feed" | "studio";

const HOME_KEY = "anthers_desktop_home";
const HOMES: readonly DesktopHome[] = ["feed", "studio"];

/**
 * The stored preference, defaulting to the feed.
 *
 * 🚨 **Anything not exactly one of the known values is treated as absent**, which is the
 * point rather than defensiveness. `localStorage.getItem` returns `null` for a missing
 * key and `""` for one that was set to empty, and this codebase has twice shipped a bug
 * from assuming those behave like `undefined` — a remembered volume of silence, and a
 * `?previewAs=` that locked a creator out of their own page. A `??` default would let
 * `""` through here too, so the membership test is what makes empty and unknown both
 * mean "not set".
 */
export function desktopHome(): DesktopHome {
	try {
		const raw = globalThis.localStorage?.getItem(HOME_KEY);
		return HOMES.includes(raw as DesktopHome) ? (raw as DesktopHome) : "feed";
	} catch {
		// Storage can throw outright (Safari private mode, a locked-down webview). A
		// preference is not worth failing a page load over.
		return "feed";
	}
}

export function setDesktopHome(home: DesktopHome): void {
	try {
		globalThis.localStorage?.setItem(HOME_KEY, home);
	} catch {}
}

/** Whether the enrolled token survives a restart — the shell reports this honestly. */
export type Persistence = "keychain" | "memoryOnly";

interface DesktopBridge {
	setToken(token: string | null): void;
}

function bridge(): DesktopBridge | null {
	return (globalThis as { __ANTHERS_DESKTOP__?: DesktopBridge }).__ANTHERS_DESKTOP__ ?? null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
	return tauriInvoke<T>(cmd, args);
}

/**
 * Open the sign-in handoff: the shell mints a PKCE verifier, registers its challenge,
 * and opens the authorize page in the SYSTEM browser. Returns the opened URL so the UI
 * can offer it as copyable text — on a machine with no default browser handler, a
 * button that silently does nothing is a dead end.
 */
export function beginSignIn(label: string): Promise<string> {
	return invoke<string>("begin_sign_in", { label });
}

/**
 * Redeem a callback code for the session token and hand it to the running app, so the
 * next API call is authenticated without a reload.
 */
export async function completeSignIn(
	code: string,
): Promise<{ token: string; persistence: Persistence }> {
	const result = await invoke<{ token: string; persistence: Persistence }>("complete_sign_in", {
		code,
	});
	bridge()?.setToken(result.token);
	return result;
}

/** A callback code that arrived before the webview mounted (cold start). */
export function takePendingCode(): Promise<string | null> {
	return invoke<string | null>("take_pending_code");
}

/** Drop the local credential. Safe to call even if the server-side sign-out failed. */
export async function desktopSignOut(): Promise<void> {
	await invoke<void>("sign_out");
	bridge()?.setToken(null);
}

/**
 * Subscribe to codes delivered while the app is already running — the common case,
 * since the creator usually leaves the Studio open while confirming in their browser.
 * Cold starts are covered by `takePendingCode()` instead. Returns an unsubscribe.
 */
export function onAuthCode(handler: (code: string) => void): () => void {
	let unlisten: (() => void) | null = null;
	let cancelled = false;

	import("@tauri-apps/api/event")
		.then(({ listen }) => listen<string>("desktop-auth-code", (e) => handler(e.payload)))
		.then((off) => {
			// Unsubscribed before the listener finished registering — tear it straight down.
			if (cancelled) off();
			else unlisten = off;
		})
		.catch(() => {});

	return () => {
		cancelled = true;
		unlisten?.();
	};
}

/**
 * A human-recognisable name for this machine, used as the device label in the Devices
 * list. The webview cannot read a hostname, so this is the best honest approximation —
 * the creator sees it on the authorize page before approving, which is what matters.
 */
export function deviceLabel(): string {
	const ua = navigator.userAgent;
	const os = /Windows/.test(ua)
		? "Windows"
		: /Mac OS X|Macintosh/.test(ua)
			? "Mac"
			: /Linux/.test(ua)
				? "Linux"
				: "Desktop";
	return `Anthers on ${os}`;
}
