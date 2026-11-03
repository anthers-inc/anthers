// SPDX-License-Identifier: Apache-2.0
/**
 * The two guards every public intake door wears before it reads a body.
 *
 * 🚨 **Order is the point.** `zValidator` parses and validates the whole body, and the
 * route's `checkRate` used to run in the handler *after* it — so an oversized invalid body
 * was paid for, then refused, and never consumed a rate-limit budget. A handful of
 * concurrent hundred-megabyte posts could exhaust the one-gigabyte container without any
 * one of them being counted as an attempt.
 *
 * The limiter runs first because it is the cheap door, then the cap, then the schema. The
 * cap also refuses a declared `Content-Length` above the maximum without reading a byte,
 * and streams an undeclared body through a counter so a chunked request cannot walk past
 * it. Every refusal is the door's own JSON shape rather than Hono's bare `Payload Too
 * Large`, so the page can render a sentence.
 */

import type { Context, MiddlewareHandler } from "hono";
import { checkRate, clientIp } from "../services/rate-limit.js";

/** What a door says when its caller has spent the window. */
export interface IntakeRefusal {
	error: string;
	code?: string;
}

export interface IntakeDoor {
	/** The limiter's door name. Part of the key, so doors never share a budget. */
	door: string;
	/** Requests allowed inside the window. */
	max: number;
	windowSecs: number;
	/** Refusal body. The status is always 429. */
	refusal: IntakeRefusal;
	/**
	 * The key the window counts. Defaults to the client's address; the abuse and issue doors
	 * key on a session when one is present, because a signed-in reporter is a better unit
	 * than the network they share.
	 */
	key?: (c: Context) => string;
	/** The largest body this door's schema can legitimately produce, plus slack. */
	maxBytes: number;
}

/** The 413 every capped door answers with — one sentence, and never a bare status. */
const TOO_LARGE = {
	error: "That request was larger than this form sends. Try again with a shorter message.",
	code: "body_too_large",
} as const;

/**
 * The door's limiter, as middleware, so it runs before the body is parsed.
 *
 * Use as `app.post(path, intakeLimit({...}), intakeBodyLimit(bytes), zValidator(...), handler)`.
 */
export function intakeLimit(door: Omit<IntakeDoor, "maxBytes">): MiddlewareHandler {
	const key = door.key ?? ((c: Context) => clientIp(c.req.raw.headers));
	return async (c, next) => {
		const verdict = await checkRate(door.door, key(c), door.max, door.windowSecs);
		if (!verdict.ok) {
			return c.json(door.refusal, 429, { "Retry-After": String(verdict.retryAfterSecs) });
		}
		await next();
	};
}

/**
 * The body cap, as middleware, so an oversized request is refused before it is read.
 *
 * 🚨 **The declared length is checked without reading, and an undeclared one is counted as
 * it arrives.** Hono's own `bodyLimit` streams the body through a wrapper and reports the
 * overflow only after the next handler has already tried to parse it, which arrives as a
 * malformed-JSON 500 rather than the door's 413 — and a chunked request with no
 * `Content-Length` is exactly the shape that would otherwise be buffered whole. Reading at
 * most `maxBytes` here is cheap for a schema-bounded form and makes the refusal a plain
 * answer rather than a parse failure.
 */
export function intakeBodyLimit(maxBytes: number): MiddlewareHandler {
	return async (c, next) => {
		const declared = c.req.header("content-length");
		if (declared && Number(declared) > maxBytes) return c.json(TOO_LARGE, 413);
		const body = c.req.raw.body;
		if (!body) return next();

		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				return c.json(TOO_LARGE, 413);
			}
			chunks.push(value);
		}

		c.req.raw = new Request(c.req.raw, {
			body: new Blob(chunks as BlobPart[]),
			duplex: "half",
		} as RequestInit);
		await next();
	};
}
