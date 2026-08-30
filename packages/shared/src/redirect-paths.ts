// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client paths the server hands to a third party, in the one place both sides can see them.
 *
 * 🚨 **A redirect URL is the one kind of route reference nothing in this repository could
 * check.** The server never navigates to it — it composes a string, gives it to Stripe, and
 * Stripe sends the person there afterwards — so a typecheck sees a valid string, a lint sees
 * valid syntax, and every route test passes because no request was ever made. Connect's
 * onboarding pointed at `/studio/payouts` from the day it was written until 2026-08-29, and
 * `/studio/payouts` has never existed: a creator who finished onboarding was returned to the
 * `/:username` catch-all, which renders somebody's profile rather than a 404, so it did not
 * even look broken.
 *
 * ⚠️ **The absence of a route is not the only way to get this wrong.** A path that resolves
 * but ignores the query is the same failure one step quieter — the page renders, the creator
 * sees no acknowledgment that anything happened, and nothing anywhere errors. So each entry
 * below names both the page and the parameter that page reads, and the e2e guard asserts the
 * thing the parameter produces rather than only that the URL resolves.
 *
 * **Two tests keep this honest and neither works alone.** `scripts/stripe-redirect-guard.test.ts`
 * asserts that no Stripe redirect URL anywhere in the API is typed inline, so every one of
 * them is a key in here; `apps/web/tests/e2e/stripe-return-paths.authed.e2e.ts` visits every
 * value and asserts a real page answers. Adding a key without an expectation fails the second.
 */

/**
 * Where Stripe returns somebody after a hosted flow, relative to the web origin.
 *
 * ⭐ **Paths rather than URLs, because the origin is decided per deployment.** The API resolves
 * it from `PUBLIC_WEB_URL`, falling back to the request's `Origin` — see the call sites. A
 * fully-qualified constant here would either hard-code production or need the environment,
 * and neither is a thing a shared package should know.
 */
export const STRIPE_RETURN_PATHS = {
	/**
	 * A creator who has finished Connect onboarding.
	 *
	 * `/studio/settings` rather than a page of its own: the payout section already lives
	 * there, already reads `?stripe=`, and a second page would be a second copy of the same
	 * three states. `complete` is the value `StudioSettingsPage` was written to read — the
	 * old URL said `onboarded=1`, which nothing anywhere has ever looked at.
	 */
	connectReturn: "/studio/settings?stripe=complete",
	/**
	 * A creator whose onboarding link expired before they finished.
	 *
	 * Stripe fetches this when the link it issued is stale, so the page has to offer a way to
	 * start again rather than merely explaining. The settings section does.
	 */
	connectRefresh: "/studio/settings?stripe=refresh",
	/** Somebody leaving the Stripe billing portal, back to their own subscription. */
	billingPortalReturn: "/subscription",
} as const;

export type StripeReturnPath = keyof typeof STRIPE_RETURN_PATHS;
