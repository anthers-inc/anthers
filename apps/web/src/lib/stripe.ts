// SPDX-License-Identifier: AGPL-3.0-or-later
import { client } from "@anthers/web-shared/rpc";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

/**
 * Stripe.js, loaded from the publishable key the API serves at `/payments/stripe/config`.
 * Resolving the key at runtime (rather than a build-time define) matches how the rest of
 * the app resolves config, and keeps the key in one place — the server's `.env`.
 * Resolves to null when payments aren't configured, so `<Elements>` simply stays inert.
 */
export const stripePromise: Promise<Stripe | null> = (async () => {
	try {
		const res = await client.api.payments.stripe.config.$get();
		const { publishableKey } = (await res.json()) as { publishableKey: string };
		return publishableKey ? await loadStripe(publishableKey) : null;
	} catch {
		return null;
	}
})();
