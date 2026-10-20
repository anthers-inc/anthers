// SPDX-License-Identifier: Apache-2.0
/**
 * Whether this browser is on an Apple platform, for the one thing that depends on it:
 * `Mod` in a stored chord means Command there and Control everywhere else.
 *
 * `navigator.platform` is deprecated but remains the cheapest signal and is present in
 * every browser this app supports; the user-agent fallback covers a webview that omits
 * it. A non-browser (a test importing this module) is treated as non-Apple, which is the
 * conservative answer: Control is the chord the server-side grammar calls `Mod` too.
 */
export function isApplePlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	const platform = navigator.platform || navigator.userAgent || "";
	return /Mac|iPhone|iPad|iPod/.test(platform);
}
