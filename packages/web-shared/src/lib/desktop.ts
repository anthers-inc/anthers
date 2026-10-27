// SPDX-License-Identifier: Apache-2.0
/**
 * The web side of the desktop-shell bridge.
 *
 * Lives here rather than in an app because the SAME build serves the browser and is
 * bundled into the Tauri shell, and because `@tauri-apps/api` is already a dependency of
 * this package (imported dynamically, so a browser build never loads it). Everything here
 * is guarded: in a browser `isDesktop()` is false and none of it runs. The shell injects `globalThis.__ANTHERS_DESKTOP__` before any app
 * JS (see `src-tauri/src/main.rs` in anthers-desktop), which is also what
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
 * person reasonably wants the Studio on the machine they author on and the user's tabs on
 * the one they read on, and an account-level setting would force one answer onto both.
 * That is also why it lives in `localStorage` beside `anthers_theme` rather than on the
 * user record. ⭐ **Which tab on the user side is the account's answer, not this one's** —
 * `homeDefaultTab` decides that, and this only decides between the user's tabs and the
 * Studio.
 *
 * Meaningless in a browser — nothing reads it there, because the browser has a real
 * homepage and an address bar.
 */
export type DesktopHome = "user" | "studio";

const HOME_KEY = "anthers_desktop_home";
const HOMES: readonly DesktopHome[] = ["user", "studio"];

/**
 * The stored preference, defaulting to the user's tabs.
 *
 * 🚨 **Anything not exactly one of the known values is treated as absent**, which is the
 * point rather than defensiveness. `localStorage.getItem` returns `null` for a missing
 * key and `""` for one that was set to empty, and this codebase has twice shipped a bug
 * from assuming those behave like `undefined` — a remembered volume of silence, and a
 * `?previewAs=` that locked a creator out of their own page. A `??` default would let
 * `""` through here too, so the membership test is what makes empty and unknown both
 * mean "not set".
 *
 * ⚠️ **`"feed"` is the value installs wrote before the user side was renamed** (2026-10-20),
 * when the choice was between a feed and the Studio. It reads as never answered, which
 * today means the same place: the user's tabs, starting at the account's chosen tab.
 */
export function desktopHome(): DesktopHome {
	try {
		const raw = globalThis.localStorage?.getItem(HOME_KEY);
		return HOMES.includes(raw as DesktopHome) ? (raw as DesktopHome) : "user";
	} catch {
		// Storage can throw outright (Safari private mode, a locked-down webview). A
		// preference is not worth failing a page load over.
		return "user";
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

/**
 * The identity's own credential, typed in the app.
 *
 * `identifier` is whatever the person typed — a handle or the address on the account — because
 * the identity server is the authority on both. `authFactorToken` is the emailed code the server
 * asks for when the account has two-factor on: absent on the first attempt, sent back with the
 * same password on the second.
 */
export interface PasswordSignIn {
	identifier: string;
	password: string;
	authFactorToken?: string;
}

/** What a sign-in attempt answered. */
export type PasswordSignInOutcome =
	/** A session is in the keychain — or in memory only, which the shell reports honestly. */
	| { status: "session"; token: string; persistence: Persistence }
	/** The password was right and the server wants the emailed code as well. */
	| { status: "two-factor" };

/**
 * Open the in-app password sign-in: register the PKCE challenge with the API and remember
 * its verifier in the shell. No browser opens — the flow continues with
 * `passwordSignIn()` in this window.
 */
export function startPasswordSignIn(label: string): Promise<void> {
	return invoke<void>("start_password_sign_in", { label });
}

/**
 * Sign in with the identity's password. The shell sends it to the API in one request, redeems
 * the resulting code itself, and parks the session in the keychain — exactly what the browser
 * handoff's redemption does. The password is not stored anywhere.
 */
export async function passwordSignIn(credentials: PasswordSignIn): Promise<PasswordSignInOutcome> {
	const result = await invoke<PasswordSignInOutcome>("password_sign_in", {
		identifier: credentials.identifier,
		password: credentials.password,
		authFactorToken: credentials.authFactorToken ?? null,
	});
	if (result.status === "session") bridge()?.setToken(result.token);
	return result;
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
	let canceled = false;

	import("@tauri-apps/api/event")
		.then(({ listen }) => listen<string>("desktop-auth-code", (e) => handler(e.payload)))
		.then((off) => {
			// Unsubscribed before the listener finished registering — tear it straight down.
			if (canceled) off();
			else unlisten = off;
		})
		.catch(() => {});

	return () => {
		canceled = true;
		unlisten?.();
	};
}

/**
 * A human-recognizable name for this machine, used as the device label in the Devices
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
