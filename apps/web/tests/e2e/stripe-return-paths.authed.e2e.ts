// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every path the API hands Stripe reaches a real page that reads what it was sent.
 *
 * 🚨 **This is the half of the guard that needs a browser, and the defect it exists for could
 * not have been found any other way.** Connect's onboarding returned creators to
 * `/studio/payouts?onboarded=1` from the day it was written until 2026-08-29. That route has
 * never existed and that parameter has never been read — but the server only ever *composed*
 * the string and handed it to Stripe, so no request of ours was ever made against it, and this
 * app's `/:username` catch-all rendered a stranger's profile rather than a 404. Nothing was
 * red. `scripts/stripe-redirect-guard.test.ts` is the other half: it keeps every such URL in
 * `STRIPE_RETURN_PATHS`, which is what makes the walk below exhaustive.
 *
 * ⚠️ **Assert what is on the page, never only the URL.** A wrong path here resolves — that is
 * the whole trap — so `toHaveURL` would pass on the broken version. The same lesson
 * `studio-routes.authed.e2e.ts` learned when three Studio buttons went to real, wrong pages.
 */

import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import { expect, type Page, test } from "@playwright/test";
import { signInAsCreator } from "./fixtures";

/**
 * What has to be on screen at each destination, keyed by the path it belongs to.
 *
 * 🚨 **Pinned against the record below, so a path added without an expectation fails rather
 * than being skipped.** Two enumerations of the same set, one written and one consumed, is
 * how a list quietly stops covering what it names — the moderation queue hydrated three of
 * four subject types for exactly this reason.
 */
const EXPECTATIONS: Record<keyof typeof STRIPE_RETURN_PATHS, (page: Page) => Promise<void>> = {
	/**
	 * The Payouts section, inside the Studio shell.
	 *
	 * ⭐ The `?stripe=complete` acknowledgement itself is deliberately not asserted: it renders
	 * only for an account Stripe has not yet enabled, so whether the fixture creator sees it
	 * depends on Connect state this suite does not own. `connectRefresh` below carries the
	 * proof that the parameter is read at all, because its alert is unconditional.
	 */
	connectReturn: async (page) => {
		await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
		await expect(
			page.getByRole("navigation").getByRole("link", { name: "Dashboard" }),
			"left the Studio shell — this is the catch-all rendering something else",
		).toBeVisible();
	},

	/**
	 * The expired-link notice, which is the observable proof that the page read the parameter
	 * rather than merely happening to exist at that address.
	 */
	connectRefresh: async (page) => {
		await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
		await expect(page.getByText(/onboarding link expired/i)).toBeVisible();
	},

	/**
	 * The subscription page. Either heading proves the route matched — a `/:username` fall
	 * through would have rendered a profile — and which one appears depends on whether the
	 * fixture creator has a billing account, which is not this test's subject.
	 */
	billingPortalReturn: async (page) => {
		await expect(
			page.getByRole("heading", { name: /Your Anthers|Account unavailable/ }),
		).toBeVisible();
	},
};

test("every Stripe return path is pinned here", () => {
	expect(Object.keys(EXPECTATIONS).sort()).toEqual(Object.keys(STRIPE_RETURN_PATHS).sort());
});

for (const [key, path] of Object.entries(STRIPE_RETURN_PATHS)) {
	test(`Stripe's ${key} lands on a page that answers: ${path}`, async ({ page, context }) => {
		// Signed in as the creator rather than the stored viewer: two of the three paths sit
		// behind the Studio's creator gate, and signed out every route on this app renders the
		// same marketing page — which would make all three assertions vacuous.
		await signInAsCreator(context);

		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));

		await page.goto(path);
		await EXPECTATIONS[key as keyof typeof STRIPE_RETURN_PATHS](page);
		expect(errors, `${path} threw`).toEqual([]);
	});
}
