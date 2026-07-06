// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resolve the consumer site's origin (anthers.org) as seen from the Studio.
 *
 * The Studio is a separate origin (studio.anthers.org) with no login page, profile,
 * or post views of its own — those live on the consumer site. This is the counterpart
 * to `@anthers/web-shared/rpc`'s API-origin logic, but it points at the consumer SPA,
 * NOT the API:
 *   - localhost / 127.0.0.1 → the consumer dev server on :3000 (the API is :8000)
 *   - studio.<host>         → strip the `studio.` label to reach the apex site
 *   - otherwise             → same-origin ("")
 */
export function consumerOrigin(): string {
	if (typeof location === "undefined") return "";
	const h = location.hostname;
	if (h === "localhost" || h === "127.0.0.1") return "http://localhost:3000";
	if (h.startsWith("studio.")) return `${location.protocol}//${h.slice("studio.".length)}`;
	return "";
}
