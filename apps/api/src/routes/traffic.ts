// SPDX-License-Identifier: Apache-2.0
/**
 * The traffic beacon — the intake door for first-party, site-wide page views and card
 * impressions, and (with the browser error beacon, whose route this file is modeled
 * on) one of a deliberately short list of unauthenticated write surfaces.
 *
 * 🚨 **Every defense on this route is load-bearing, and each one answers a named shape:**
 *
 *   • **Origin allowlist, re-checked here** — present-but-foreign refused, absent
 *     admitted. The route is exempted in `middleware/csrf.ts` for the same reason the
 *     error beacon is (the blanket check refuses an absent Origin; the write is not
 *     cookie-forgeable to any effect — a page view records nothing addressed toward
 *     anyone), and the route's own re-check is the strictness that replaces it: a
 *     plain `fetch` always sets Origin, so the one shape that can arrive without one
 *     is a client quirk, not an attack.
 *
 *   • **Per-IP rate limit, shared storage** — door `traffic-beacon`, the same limiter
 *     every other door uses. A real tab fires one beacon per page view; the cap is
 *     generous to humans and boring to a flood.
 *
 *   • **Payload caps before anything is read deeply** — and *nothing* is stored that
 *     the service did not cap or classify itself: paths are capped and query-stripped
 *     by the client, referrers are reduced to host-only, the session id is capped, and
 *     device/source enums are decided from UA and classification, never from the body.
 *
 *   • **Bots refused at the door** — a UA that reads as a crawler, pre-viewer or
 *     automation client counts nothing (`isBotUserAgent`); this is the one defense
 *     that protects the *number*, not the infrastructure.
 *
 *   • **Never 500s.** A failed beacon answers 204 and the client moves on — the same
 *     golden rule the error tracker runs by, from the route down. There is no retry
 *     on the client for dropped page views, by design: traffic is lossy telemetry,
 *     and a retry storm teaching itself to exist is worse than a slightly low count.
 */

import { isBotUserAgent, isTrackedHost } from "@anthers/shared/traffic";
import type { Context } from "hono";
import { Hono } from "hono";
import { allowedOrigins } from "../origins.js";
import { checkRate, clientIp, limitResponse } from "../services/rate-limit.js";
import { recordCardDisplay, recordPageView } from "../services/traffic.js";

/**
 * The door's per-IP budget: 400 page views per hour is far past what a human
 * browsing produces (dozens), and caps a scripted flood at noise. Fixed windows
 * accept up to 2× across a boundary — tolerable here for the same reason the limiter's
 * docblock accepts it everywhere.
 */
const HOURLY_BEACON_LIMIT = 400;

/** The most card events one request may carry. The client batches per flush. */
const MAX_CARD_EVENTS = 100;

/** The most page views one request may carry. The emitter sends one; batching here is future room, bounded now. */
const MAX_PAGE_VIEWS = 10;

/** Same ruling as the error beacon: absent Origin admitted, present-but-foreign refused. */
function originIsAllowed(c: Context): boolean {
	const origin = c.req.header("Origin");
	return !origin || allowedOrigins().includes(origin);
}

function limitedByBot(c: Context): boolean {
	return isBotUserAgent(c.req.header("User-Agent") ?? null);
}

async function bodyIsObject(c: Context): Promise<Record<string, unknown> | null> {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function drop(c: Context): Response {
	return c.body(null, 204);
}

/**
 * The host a claimed page view happened on must be a host this pipeline tracks. The
 * admin console is operator traffic, not site traffic, and an unexpected host is a
 * mis-routed beacon or a hand-built one — both drop silently rather than write a row
 * whose provenance nobody can vouch for. An absent host is admitted: the client that
 * sends it is our own emitter.
 */
function tracksThisHost(host: string | null): boolean {
	return host == null || isTrackedHost(host);
}

export const trafficRoutes = new Hono()
	.post("/page-view", async (c) => {
		if (!originIsAllowed(c)) return c.json({ error: "CSRF validation failed" }, 403);
		if (limitedByBot(c)) return drop(c);
		const limited = await checkRate(
			"traffic-beacon",
			clientIp(c.req.raw.headers),
			HOURLY_BEACON_LIMIT,
			3600,
		);
		if (!limited.ok) return limitResponse(limited);

		const body = await bodyIsObject(c);
		if (!body) return drop(c);

		const views = body.path != null ? [body] : (body.views as unknown);
		if (!Array.isArray(views) || views.length === 0 || views.length > MAX_PAGE_VIEWS) {
			return drop(c);
		}
		for (const view of views.slice(0, MAX_PAGE_VIEWS)) {
			if (!view || typeof view !== "object") continue;
			const v = view as Record<string, unknown>;
			const pageHost = str(v.host);
			if (!tracksThisHost(pageHost)) continue;
			await recordPageView({
				path: str(v.path) ?? "/",
				referrerHost: str(v.referrer),
				previousPath: str(v.previousPath),
				sessionId: str(v.sessionId) ?? "",
				pageHost,
				userAgent: c.req.header("User-Agent") ?? null,
			});
		}
		return drop(c);
	})
	.post("/card", async (c) => {
		if (!originIsAllowed(c)) return c.json({ error: "CSRF validation failed" }, 403);
		if (limitedByBot(c)) return drop(c);
		const limited = await checkRate(
			"traffic-beacon",
			clientIp(c.req.raw.headers),
			HOURLY_BEACON_LIMIT,
			3600,
		);
		if (!limited.ok) return limitResponse(limited);

		const body = await bodyIsObject(c);
		if (!body) return drop(c);
		const events = body.events as unknown;
		if (!Array.isArray(events) || events.length === 0 || events.length > MAX_CARD_EVENTS) {
			return drop(c);
		}
		for (const event of events.slice(0, MAX_CARD_EVENTS)) {
			if (!event || typeof event !== "object") continue;
			const e = event as Record<string, unknown>;
			const subjectId = e.subjectId;
			await recordCardDisplay({
				subjectKind: str(e.subjectKind) ?? "",
				subjectId: typeof subjectId === "number" ? subjectId : Number(subjectId),
				kind: str(e.kind) ?? "",
				surface: str(e.surface) ?? "discover",
			});
		}
		return drop(c);
	});
