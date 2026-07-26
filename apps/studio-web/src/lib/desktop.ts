// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Studio's side of the desktop-shell bridge.
 *
 * The same `apps/studio-web` build serves the browser Studio and is bundled into the
 * Tauri app, so everything here is guarded: in a browser `isDesktop()` is false and
 * none of it runs. The shell injects `globalThis.__ANTHERS_DESKTOP__` before any app
 * JS (see `apps/studio-desktop/src-tauri/src/main.rs`), which is also what
 * `@anthers/web-shared`'s `apiFetch()` reads to pick its transport.
 *
 * `@tauri-apps/api` is imported dynamically so the browser build never loads it.
 */
import { isDesktop } from "@anthers/web-shared/rpc";

export { isDesktop };

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
	return `Anthers Studio on ${os}`;
}
