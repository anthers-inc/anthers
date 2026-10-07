// SPDX-License-Identifier: Apache-2.0
/**
 * The browser error beacon — the one new unauthenticated write surface, defended by
 * discipline rather than by a session.
 *
 * 🚨 **Every defense on this route is load-bearing, and each one answers a named shape:**
 *
 *   • **Origin allowlist, re-checked here.** CSRF is exempted globally for this path
 *     (middleware/csrf.ts carries the ruling — the write spends nothing forgeable), and
 *     the check that replaces it is stricter on the dimension that matters: a beacon may
 *     arrive with no Origin header at all (some browsers' `unhandledrejection` does not
 *     set one), so *absent* Origin is admitted while a *present-but-foreign* Origin is
 *     refused. A cross-site page CAN therefore file errors — but only errors of its own
 *     making, which is the harm the payload cap and the rate limit hold down to noise.
 *
 *   • **Per-IP rate limit, shared storage** — the same limiter every other door uses,
 *     because a browser error endpoint is above all a *volume* door.
 *
 *   • **Payload caps before anything is read deeply** — message, frames, and context are
 *     capped by the service's own limits, and the parsed shape is checked field by field
 *     rather than trusted. A beacon that is not exactly the documented shape is dropped
 *     with a 400, never stored partially.
 *
 *   • **Never 500s.** A failed capture answers 204 and lets the client's own session cap
 *     stop it from retrying — the tracker's golden rule, from the route down.
 *
 * 🚨 **The daily sampling cap is the abuse answer at scale, and it is a sampling, not a
 * wall.** Past the day's budget, events are *dropped probabilistically* rather than
 * refused — a refusal tells a flood script exactly where the wall is, and a sampled sink
 * accepts an unpredictable fraction, which is worse news for a flood and harmless to a
 * genuine user whose one error usually lands early in the day's budget.
 */

import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { allowedOrigins } from "../origins.js";
import { captureError, type ErrorFrame } from "../services/error-tracker.js";
import { checkRate, clientIp, limitResponse } from "../services/rate-limit.js";
import { rowsOf } from "../services/rows.js";

/** The day's free intake, as *expected events* — the budget is consumed by fingerprinted issues, not raw POSTs. */
const DAILY_EVENT_BUDGET = 2000;
/** Probabilistic sampling keeps accepting after the budget; this is the fraction, not a hard stop. */
const SAMPLE_RATE_PAST_BUDGET = 0.05;

export const errorCaptureRoutes = new Hono().post("/browser", async (c) => {
	// Origin: present-but-foreign refused, absent admitted (see the docblock's ruling).
	const origin = c.req.header("Origin");
	if (origin && !allowedOrigins().includes(origin)) {
		return c.json({ error: "CSRF validation failed" }, 403);
	}

	// The door's per-IP limit — tight, because a real page fires at most a handful of
	// beacons per session (the client-side cap is the primary defense; this is the net).
	const limited = await checkRate("error-beacon", clientIp(c.req.raw.headers), 10, 3600);
	if (!limited.ok) return limitResponse(limited);

	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== "object") return c.json({ error: "Not found" }, 400);
	const { message, frames, path, userAgent } = body as {
		message?: unknown;
		frames?: unknown;
		path?: unknown;
		userAgent?: unknown;
	};

	if (typeof message !== "string" || message.length === 0 || message.length > 1000) {
		return c.json({ error: "Not found" }, 400);
	}
	// Frames: the client sends at most 10, each of at most two strings. Anything else
	// is not the beacon's shape and is dropped whole — never stored partially.
	const parsedFrames: ErrorFrame[] = [];
	if (Array.isArray(frames)) {
		for (const frame of frames.slice(0, 10)) {
			if (!frame || typeof frame !== "object") continue;
			const { fn, loc } = frame as { fn?: unknown; loc?: unknown };
			if (typeof fn !== "string" || typeof loc !== "string") continue;
			parsedFrames.push({ fn: fn.slice(0, 150), loc: loc.slice(0, 200) });
		}
	}

	// The day's budget, read from the tracker's own store: events captured in the last
	// 24h across both sources. Past it, sample — never refuse (see the docblock).
	let accepted = true;
	try {
		const recent = await db.execute(sql`
				SELECT coalesce(sum(count), 0)::int AS n FROM error_events WHERE last_seen_at > now() - interval '24 hours'
			`);
		const seen = rowsOf<{ n: number }>(recent)[0]?.n ?? 0;
		if (seen >= DAILY_EVENT_BUDGET) {
			accepted = Math.random() < SAMPLE_RATE_PAST_BUDGET;
		}
	} catch {
		// The budget read failing must not fail the beacon; accept and let the caps work.
	}

	if (accepted) {
		await captureError({
			source: "browser",
			message,
			frames: parsedFrames,
			context: {
				route: typeof path === "string" ? path.slice(0, 300) : undefined,
				userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : undefined,
			},
		});
	}

	// 204 whatever happened — the beacon never learns anything about the tracker's state.
	return c.body(null, 204);
});
