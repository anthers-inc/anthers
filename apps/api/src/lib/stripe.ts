// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server-side Stripe client — one shared instance built from STRIPE_SECRET_KEY.
 *
 * Null when the key is absent (a test run or a not-yet-configured environment) so
 * routes can return a clean 503 instead of the module throwing at import time. The
 * SDK picks its own pinned API version; we don't override it.
 *
 * **Read it through `getStripe()`, never as a module-level binding.** This used to be
 * `export const stripe`, which made "are payments configured?" a property of the
 * process rather than something a test could choose: with a local `.env` the client
 * was non-null and in CI it was null, so an assertion about the 503 guards passed in
 * one place and failed in the other. That is why those guards shipped untested
 * (PR #142). Reading through a function lets a test drive both sides of the branch,
 * and lets the money path be exercised against a fake with no network.
 */
import Stripe from "stripe";

function fromEnv(): Stripe | null {
	const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
	return secretKey ? new Stripe(secretKey) : null;
}

let client: Stripe | null = fromEnv();

/** The shared Stripe client, or null when payments aren't configured. */
export function getStripe(): Stripe | null {
	return client;
}

/**
 * Replace the shared client. **Tests only** — production builds it once from the
 * environment above. Returns the previous value so a test can restore it.
 */
export function setStripeClient(next: Stripe | null): Stripe | null {
	const previous = client;
	client = next;
	return previous;
}
