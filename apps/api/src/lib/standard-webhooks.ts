// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signature verification for Standard Webhooks — the scheme Svix implements and Resend
 * sends with.
 *
 * 🚨 **Hand-rolled rather than taking the `svix` dependency, and that is a decision with a
 * cost.** Rolling your own crypto is usually the wrong instinct; what makes it defensible
 * here is that this is not crypto design, it is an HMAC over a documented string with a
 * documented encoding, and the whole of it fits on one screen where it can be read. The
 * alternative is a dependency whose surface is far larger than the twenty lines it would
 * replace, on a path that runs before authentication. Every rule below is from the
 * Standard Webhooks specification rather than invented here, and the tests pin each one.
 *
 * The scheme, in full:
 *
 * 1. The signed content is `{id}.{timestamp}.{body}` — the **raw** body, byte for byte.
 *    Parsing the JSON first and re-serializing it changes the bytes and every signature
 *    fails, which is the same trap the Stripe handler documents.
 * 2. The secret arrives as `whsec_<base64>`; the key is the **decoded** bytes after that
 *    prefix, not the string itself.
 * 3. The signature header carries a space-separated list of `v{n},{base64}` entries,
 *    because a secret being rotated means two valid signatures at once. Any one matching
 *    is a pass.
 * 4. The timestamp is checked against a tolerance, or a captured request stays replayable
 *    forever.
 *
 * ⚠️ **Every comparison is timing-safe and every failure returns the same thing to the
 * caller.** The `reason` exists for our logs; handing it to the sender would turn this
 * into an oracle that distinguishes "wrong signature" from "stale timestamp".
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface StandardWebhookHeaders {
	id: string | undefined;
	timestamp: string | undefined;
	signature: string | undefined;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Five minutes either way, which is the specification's own recommendation. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/**
 * Read the three headers under either naming.
 *
 * Svix sends `svix-*`; the vendor-neutral specification renames them `webhook-*`, and
 * senders migrate. Accepting both costs nothing and avoids a silent outage on the day a
 * provider switches — the failure would look exactly like a bad secret.
 */
export function standardWebhookHeaders(get: (name: string) => string | undefined) {
	return {
		id: get("svix-id") ?? get("webhook-id"),
		timestamp: get("svix-timestamp") ?? get("webhook-timestamp"),
		signature: get("svix-signature") ?? get("webhook-signature"),
	} satisfies StandardWebhookHeaders;
}

/** The key bytes a `whsec_`-prefixed secret actually names. */
function keyFor(secret: string): Buffer {
	const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
	return Buffer.from(raw, "base64");
}

/** Constant-time equality that does not leak length through an early return. */
function sameSignature(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	// `timingSafeEqual` throws on a length mismatch, which would itself be a timing
	// signal — so unequal lengths are compared against a copy of the same length and
	// then rejected regardless.
	if (left.length !== right.length) {
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

export function verifyStandardWebhook(opts: {
	secret: string;
	headers: StandardWebhookHeaders;
	/** The raw request body. Must not have been parsed and re-serialized. */
	body: string;
	toleranceSeconds?: number;
	now?: Date;
}): VerifyResult {
	const { id, timestamp, signature } = opts.headers;
	if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
	if (!opts.secret) return { ok: false, reason: "no_secret" };

	const sentAt = Number(timestamp);
	if (!Number.isFinite(sentAt)) return { ok: false, reason: "bad_timestamp" };
	const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
	// Both directions. A future timestamp is as much a red flag as a stale one, and
	// checking only the past leaves a captured request replayable by anyone who can skew
	// a clock forward.
	if (Math.abs(nowSeconds - sentAt) > tolerance)
		return { ok: false, reason: "timestamp_outside_tolerance" };

	const expected = createHmac("sha256", keyFor(opts.secret))
		.update(`${id}.${timestamp}.${opts.body}`)
		.digest("base64");

	// A rotating secret means two valid signatures arrive together, so any match passes.
	// Versions other than v1 are skipped rather than rejected: an unknown scheme is not
	// something to guess at, and ignoring it leaves the known one still required.
	for (const entry of signature.split(" ")) {
		const [version, value] = entry.split(",", 2);
		if (version !== "v1" || !value) continue;
		if (sameSignature(value, expected)) return { ok: true };
	}
	return { ok: false, reason: "no_matching_signature" };
}

/** Sign a payload the way a sender would. Exported for tests; nothing in the app signs. */
export function signStandardWebhook(opts: {
	secret: string;
	id: string;
	timestamp: number;
	body: string;
}): string {
	const mac = createHmac("sha256", keyFor(opts.secret))
		.update(`${opts.id}.${opts.timestamp}.${opts.body}`)
		.digest("base64");
	return `v1,${mac}`;
}
