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

/**
 * Advanced fraud detection OFF — Anthers does not fingerprint, and does not let its
 * payment processor do it either (Parker, 2026-08-31).
 *
 * Stripe's advanced fraud signals are two families: **device characteristics** (browser,
 * screen, device configuration) and **activity indicators** (mouse movement, time on page,
 * whether the card number was typed or pasted), beaconed to `m.stripe.com`. This turns both
 * off. The point is a claim we can make without an asterisk — *no device fingerprinting,
 * ours or our processor's* — where the version with an asterisk was worth less than the
 * signal it bought.
 *
 * 🚨 **This is a lever, not a principle, and it exists to be pulled back if fraud arrives.**
 * Stripe says disabling raises fraud risk, **especially card testing**, and publishes no
 * number for it — so the trade was made on Anthers' own exposure rather than on evidence
 * Stripe supplied. What makes it affordable is that **payment is gated behind a verified
 * account**: `POST /checkout/:slug` and `/basket/checkout` both carry `requireVerified`, so
 * card testing needs a distinct email-verified account per attempt rather than an open form
 * to hammer. That is the structural half of what device signals are usually bought for.
 *
 * ⚠️ **What to watch, so the decision gets revisited on evidence rather than on nerve:** a
 * rise in declined-card attempts per account, small-amount authorizations clustering in
 * time, or any Radar/Stripe notice about card testing. Any of those, and flip this to `true`
 * first and argue afterwards — then correct the privacy claim in the same change, because
 * the claim is the reason this is off.
 *
 * **What this does NOT turn off**, and the privacy copy must not overstate it: interactions
 * with Stripe-managed Elements fields, and basic device information during 3D Secure 2
 * authentication, which the issuing bank requires. Stripe also keeps collecting on its own
 * domains. And Stripe necessarily sees the IP of any browser that talks to it — that is
 * inherent to making the request and was never a setting.
 *
 * Called at module scope deliberately, and it is safe here where the old `stripePromise`
 * IIFE was not: `setLoadParameters` only records a flag for a later `loadStripe()` and
 * injects no script, which is the whole reason the `/pure` entry exists.
 */
loadStripe.setLoadParameters({ advancedFraudSignals: false });

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
 * for Radar's benefit; Anthers declines, and since 2026-08-31 declines the fraud signals
 * on payment surfaces too (see above). ⚠️ **Do not re-derive that from "prod is in test
 * mode"** — this comment argued exactly that until 2026-08-31, and it is a temporary state
 * that ends when payments go live, not a reason. The reasons that survive going live are
 * the published no-fingerprinting claim and `requireVerified` on checkout.
 *
 * See `Privacy Policy`, `stripe.test.ts`, and the third-party-requests e2e spec, which
 * fails if an off-origin request reappears on a marketing route.
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
