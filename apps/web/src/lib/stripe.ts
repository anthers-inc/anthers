// SPDX-License-Identifier: AGPL-3.0-or-later
import { client } from "@anthers/web-shared/rpc";
import type { Stripe } from "@stripe/stripe-js";
// `/pure`, not the main entry — deliberately. The main entry injects the Stripe.js
// <script> as a side effect of being IMPORTED (a top-level `Promise.resolve().then(
// getStripePromise)` at the bottom of its bundle), so merely importing `loadStripe`
// anywhere in the graph loads Stripe on every route. `/pure` defers that to the
// actual `loadStripe()` call. The type import above is erased at build time and
// carries no side effect. See the note on getStripe below.
import { loadStripe } from "@stripe/stripe-js/pure";

let cached: Promise<Stripe | null> | null = null;

/**
 * Stripe.js, loaded from the publishable key the API serves at `/payments/stripe/config`.
 * Resolving the key at runtime (rather than a build-time define) matches how the rest of
 * the app resolves config, and keeps the key in one place — the server's `.env`.
 * Resolves to null when payments aren't configured, so `<Elements>` simply stays inert.
 *
 * **Call this from a payment surface only — never at module scope.** This used to be a
 * top-level `const stripePromise = (async () => …)()`, which meant it ran when the bundle
 * booted rather than when a payment component mounted: every visitor on every route,
 * including signed-out ones reading /about, loaded Stripe.js and got fingerprinted for it
 * (`m.stripe.com/6`, plus a year-long `__stripe_mid` machine-ID cookie). Nobody chose
 * that — it was a module-evaluation side effect. Stripe does recommend loading site-wide
 * for Radar's benefit, but prod runs in test mode and the Payment Processing Setup Guide's posture is "never contest,
 * always refund fast", so it bought signal we've decided not to use, at the cost of a
 * claim the privacy policy makes. See `Privacy Policy` and the third-party-requests
 * e2e spec, which fails if an off-origin request reappears on a marketing route.
 *
 * Memoized rather than fresh per call because `<Elements stripe={…}>` re-initializes if
 * the promise identity changes between renders.
 */
export function getStripe(): Promise<Stripe | null> {
	cached ??= (async () => {
		try {
			const res = await client.api.payments.stripe.config.$get();
			const { publishableKey } = (await res.json()) as { publishableKey: string };
			return publishableKey ? await loadStripe(publishableKey) : null;
		} catch {
			return null;
		}
	})();
	return cached;
}
