// SPDX-License-Identifier: Apache-2.0
/**
 * Traffic tracking — the browser half of first-party, site-wide traffic measurement.
 *
 * This is the traffic-side sibling of `attention.ts`, deliberately much smaller: there
 * is no policy to evaluate and no second to split, because a page view is instant. It
 * does three things, and nothing else:
 *
 * - **One beacon per page view.** Fired from a hook that watches the router's location
 *   (so SPA navigation counts like a load does), skipping repeats of the same path and
 *   skipping the embed route, which is a page loaded in somebody else's document.
 * - **A session id that is not an identity.** A random UUID in `sessionStorage`, dying
 *   with the tab — carried so the server can count distinct sessions, and powerless to
 *   re-identify anybody (packages/shared/src/traffic.ts carries the reasoning). When
 *   storage is unavailable it degrades to a per-page-load id, which only costs the
 *   session count some precision.
 * - **Fire and forget.** No retry, no queue, no backlog. Traffic is lossy telemetry:
 *   a dropped view is acceptable, a client that persists page views and replays them
 *   is a behavior the privacy story did not sign up for.
 *
 * What this file deliberately does NOT do: read or send anything about the user. No
 * auth state, no account, no fingerprint, nothing from the URL's query string.
 */

import { apiFetch } from "@anthers/web-shared/rpc";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const SESSION_KEY = "anthers-traffic-session";
/** Guard so React 18 StrictMode's double mount does not double-beacon the entry view. */
const ENTRY_SENT_KEY = "anthers-traffic-entry";
const EMBED_PREFIX = "/embed";

let fallbackSessionId: string | null = null;

function randomId(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
	return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The session id: random, per tab, dying with the tab. `sessionStorage` is not a
 * cookie, requires no banner, and cannot survive what a cookie survives — that is
 * the whole point of choosing it rather than anything durable.
 */
export function sessionId(): string {
	try {
		const held = sessionStorage.getItem(SESSION_KEY);
		if (held) return held;
		const fresh = randomId();
		sessionStorage.setItem(SESSION_KEY, fresh);
		return fresh;
	} catch {
		if (!fallbackSessionId) fallbackSessionId = randomId();
		return fallbackSessionId;
	}
}

function isEntryBeacon(): boolean {
	try {
		if (sessionStorage.getItem(ENTRY_SENT_KEY)) return false;
		sessionStorage.setItem(ENTRY_SENT_KEY, "1");
		return true;
	} catch {
		// No storage: treat every page as its own entry, which over-sends referrer
		// headers (harmless — they are the browser's own) and never under-sends one.
		return true;
	}
}

/** One page view, sent now, never retried. Returns immediately; nothing waits on it. */
function sendPageView(path: string, previousPath: string | null): void {
	const entry = isEntryBeacon();
	apiFetch("/api/traffic/page-view", {
		method: "POST",
		// keepalive lets a beacon survive the document unloading behind it (a link
		// that navigated away in the same tick); it costs a 64KB cap, which a capped
		// body never meets.
		keepalive: true,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			path,
			host: window.location.host,
			// The browser's own record of how this tab arrived. Sent only with the
			// entry beacon: a `document.referrer` read later in a session still names
			// the entry page, and attaching it to every view would mislabel where
			// readers came from.
			...(entry ? { referrer: document.referrer || null } : {}),
			...(previousPath ? { previousPath } : {}),
			sessionId: sessionId(),
		}),
	}).catch(() => {
		// Deliberate: traffic is lossy, and the catch is what makes it so.
	});
}

/** The path currently being shown, remembered so the next view carries it as `previousPath`. */
let lastPath: string | null = null;

/**
 * Fire the page-view beacon on entry and on every SPA navigation. Mounted once at the
 * app root; the embed route (a player inside somebody else's page) is skipped —
 * third-party embedding is a different measurement with different referrer semantics,
 * and this task measured the site itself.
 */
export function useTrafficBeacon(): void {
	const location = useLocation();

	useEffect(() => {
		const path = location.pathname;
		if (path.startsWith(EMBED_PREFIX)) return;
		if (path === lastPath) return; // Same path re-rendered (search params changed) is not a new page view.
		const previous = lastPath;
		lastPath = path;
		sendPageView(path, previous);
	}, [location.pathname]);
}

// ── Card impressions (Discover) ──────────────────────────────────────────────

interface CardEvent {
	subjectKind: string;
	subjectId: number;
	kind: "shown" | "click";
	surface: string;
}

let pendingCards: CardEvent[] = [];
let cardFlusher: ReturnType<typeof setTimeout> | null = null;

function flushCards(): void {
	cardFlusher = null;
	if (pendingCards.length === 0) return;
	const events = pendingCards;
	pendingCards = [];
	apiFetch("/api/traffic/card", {
		method: "POST",
		keepalive: true,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ events }),
	}).catch(() => {
		// Lossy by the same rule as page views, in both directions: drops are drops.
	});
}

function queueCardEvent(event: CardEvent): void {
	pendingCards.push(event);
	if (cardFlusher == null) cardFlusher = setTimeout(flushCards, 2_000);
}

/**
 * Observe one card for Discovery impressions. The returned handlers go on a wrapper
 * element around the card; `enabled` keeps tracking off wherever the subject is
 * unknown. An impression is the card reaching the viewport — one per card per page
 * view, deduped here, so scrolling past and back does not inflate a creator's shown
 * count.
 */
export function trackCardDisplay(
	subjectKind: string,
	subjectId: number,
	surface = "discover",
): { observe: (el: Element) => () => void; onClickCapture: (e: React.MouseEvent) => void } {
	let counted = false;
	return {
		observe(el: Element): () => void {
			if (typeof IntersectionObserver === "undefined") return () => {};
			const observer = new IntersectionObserver(
				(entries) => {
					const entry = entries[0];
					if (!entry?.isIntersecting || counted) return;
					// Counting threshold: any pixel of the card showing. The card exists
					// to be seen; the idle gates that protect attention's credit have no
					// counterpart here because nothing is being credited but a render.
					counted = true;
					observer.disconnect();
					queueCardEvent({ subjectKind, subjectId, kind: "shown", surface });
				},
				{ threshold: 0 },
			);
			observer.observe(el);
			return () => observer.disconnect();
		},
		onClickCapture(e: React.MouseEvent): void {
			// A click on a nested control (CreatorCard's Follow button) is engagement
			// with the card's chrome, not a click-through to the subject.
			if (e.target instanceof Element && e.target.closest("button")) return;
			queueCardEvent({ subjectKind, subjectId, kind: "click", surface });
		},
	};
}

/** Flush anything pending when the page is going away — the events a reader generated but the timer never drained. */
if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => {
		if (cardFlusher != null) {
			clearTimeout(cardFlusher);
			flushCards();
		}
	});
}
