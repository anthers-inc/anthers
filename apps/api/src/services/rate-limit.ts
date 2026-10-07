// SPDX-License-Identifier: Apache-2.0
/**
 * The per-IP rate limiter — the limit layer for the doors an account ceremony does not
 * already gate, held in the database so it binds every instance.
 *
 * 🚨 **Why the database rather than memory.** App Platform runs more than one instance of
 * the API at deploy (and, at scale, at run) time; an in-process counter is a suggestion a
 * second instance never heard of. The rolling window is one small table and one round-trip,
 * which is affordable at the request rates these doors see — and every door this layer
 * guards is one where a refused request is *cheaper* than an accepted flood.
 *
 * **Fixed windows, not token buckets — the simplicity is a security decision, not a
 * shortcut.** A fixed window can admit up to 2× the nominal burst across a boundary, which
 * is tolerable for every door here because the alternative (a correct token bucket in SQL)
 * wants either row-level locking discipline or a second state store, and a rate limiter
 * that quietly loses counts under concurrency is worse than a slightly generous window.
 * The doors' real defenses sit behind this layer (argon2id hashes, single-use codes, the
 * proof-of-work challenge); this buys *slowing a scripted flood*, the thing none of those
 * do today.
 *
 * **The caller names the door; the limiter only counts.** Every limit lives beside its own
 * route's rationale (the way every hardening rule lives in its service), so a table of
 * "all the limits" here would be a second copy of the rules that drifts. What is shared is
 * the mechanism: fixed windows, per-IP + per-door keys, atomic increment, and the same
 * refusal shape everywhere.
 */

import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import { rowsOf } from "./rows.js";

/** Sweep the rate limiter's spent windows — every row whose window rolled is history. */
export async function sweepRateLimits(): Promise<number> {
	const result = await db.execute(sql`DELETE FROM rate_limits WHERE reset_at <= now()`);
	const rows = rowsOf(result);
	return rows.length;
}

/** The answer every limited route renders the same way. */
export interface LimitVerdict {
	/** False when the window is full — the route answers 429 and says nothing else. */
	ok: boolean;
	/** Seconds until the window rolls. Rendered verbatim in the 429. */
	retryAfterSecs: number;
}

/**
 * The client's address, as the headers App Platform actually presents it. 🚨 The
 * `X-Forwarded-For` list's *first* entry is client-controlled when nobody strips it; the
 * *last* entry is added by the edge that finally forwarded the request, which is the only
 * hop in the chain that did not arrive in the request itself. This reads the last entry
 * rather than the first for that reason, falling back to the single-address form.
 */
export function clientIp(headers: Headers): string {
	const forwarded = headers.get("x-forwarded-for");
	if (forwarded) {
		const entries = forwarded
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
		if (entries.length > 0) return entries[entries.length - 1];
	}
	return headers.get("x-real-ip") ?? "unknown";
}

/** One door's limit, named per call. The name is part of the key, so doors cannot share budgets. */
export async function checkRate(
	door: string,
	ip: string,
	max: number,
	windowSecs: number,
): Promise<LimitVerdict> {
	try {
		// One atomic upsert: the counter exists after this statement whatever raced, and
		// `reset_at` is stamped only on insert — the window opens at first sight of the
		// key and rolls windowSecs later, whatever the volume inside it.
		const result = await db.execute(sql`
			INSERT INTO rate_limits AS rl (door, ip, count, reset_at)
			VALUES (${door}, ${ip}, 1, now() + make_interval(secs => ${windowSecs}))
			ON CONFLICT (door, ip) DO UPDATE SET
				count = CASE
					WHEN rl.reset_at <= now() THEN 1
					ELSE rl.count + 1
				END,
				reset_at = CASE
					WHEN rl.reset_at <= now() THEN now() + make_interval(secs => ${windowSecs})
					ELSE rl.reset_at
				END
			RETURNING count, extract(epoch from reset_at - now())::int AS retry_after
		`);
		const row = rowsOf<{ count: number; retry_after: number }>(result)[0];
		if (!row) return { ok: true, retryAfterSecs: windowSecs };
		return {
			ok: row.count <= max,
			retryAfterSecs: Math.max(0, row.retry_after),
		};
	} catch (error) {
		// 🚨 The limiter failing must never take the door with it: a broken rate limit
		// degrades to *no* rate limit, loudly logged, rather than refusing every real
		// person on the platform. The doors behind this layer keep their own hardening.
		console.error(
			`[rate-limit] check failed for ${door}:`,
			error instanceof Error ? error.message : error,
		);
		return { ok: true, retryAfterSecs: 0 };
	}
}

/** Hono handler body: the 429 a limited route returns, with the retry window. */
export function limitResponse(verdict: LimitVerdict) {
	return Response.json(
		{ error: "Too many requests. Try again shortly." },
		{ status: 429, headers: { "Retry-After": String(verdict.retryAfterSecs) } },
	);
}
