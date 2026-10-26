// SPDX-License-Identifier: Apache-2.0
//
// What the purchase surfaces may and may not do with a billing address.
//
// 🚨 **This is a source-text guard, in the family of `lib/stripe.test.ts`**, and it exists
// for the same reason that one does: no browser spec reaches the payment form. The
// browser session has no Stripe key, so the checkout POST 503s before the form mounts —
// the observational walk is Roadmap work (the `GAUNTLET_STRIPE=1` mode), and until it
// exists, nothing but this file notices the purchase surfaces mounting an element that
// cannot enforce the US-only boundary.
//
// The two properties it pins:
//
// 1. **Neither purchase surface mounts Stripe's Checkout Billing Address Element.** The
//    Checkout-flavored element offers only `contacts` and `display` — no
//    `allowedCountries` — so a buyer could select any country it offers, complete a
//    card charge, and only the server-side completion path would refuse it, after the
//    money moved and while the rows sat `pending` for a hand refund. The fix is
//    Anthers' own US-only form (`UsBillingAddressForm`), which is US by construction:
//    no country field exists to set.
//
// 2. **Confirm is gated on an accepted address.** `canConfirm` is Stripe's readiness for
//    the Payment Element and does not track our address form — a buyer with a blank
//    address satisfies it. Both surfaces must route their Pay button through `mayConfirm`
//    (Stripe's readiness AND the address the session accepted), and must refuse to
//    confirm without the address on the session.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const surfaces = {
	BasketCheckout: "src/components/basket/BasketCheckout.tsx",
} as const;

/**
 * The surfaces that must NOT carry a purchase form, with what their retirement means.
 *
 * `ProjectPricing` sat in this list as a purchase surface until 2026-10-03, when its
 * whole checkout half was retired and it became a price card: it now appears below,
 * where "must not mount Checkout" belongs, because the Work page is no longer a
 * purchase surface at all — Parker's decision, "we really just shouldn't have a
 * payment/billing form on the Work page at all."
 */
const retiredSurfaces = {
	ProjectPricing: "src/components/project/ProjectPricing.tsx",
	WorkPage: "src/pages/WorkPage.tsx",
} as const;

const read = (rel: string) => readFileSync(join(import.meta.dir, "../../..", rel), "utf8");

describe("the purchase surface's billing address", () => {
	for (const [name, rel] of Object.entries(surfaces)) {
		const source = read(rel);

		it(`${name} does not mount the Checkout Billing Address Element`, () => {
			// The whole reason the element had to go: it cannot be constrained to the US,
			// and a non-US buyer could complete a charge the server would then refuse by
			// hand. Import and JSX both named, so either half of a reintroduction fails.
			expect(source, `${name} remounted Stripe's Billing Address Element`).not.toContain(
				"BillingAddressElement",
			);
		});

		it(`${name} collects the address through Anthers' US-only form`, () => {
			expect(source, `${name} lost its billing address block entirely`).toContain(
				"CheckoutBillingAddressBlock",
			);
		});

		it(`${name} gates confirm on an address the session accepted`, () => {
			// `mayConfirm` is the shared predicate that requires BOTH Stripe's readiness
			// and our record that `updateBillingAddress` was accepted. Gating on
			// `canConfirm` alone is the defect this exists for: Stripe reports the Payment
			// Element ready the moment it mounts, with no address anywhere.
			expect(source, `${name} must route its Pay gate through mayConfirm`).toContain("mayConfirm(");
			// And the submit handler must refuse to confirm without the address — the
			// button's `disabled` is UI, not enforcement. 🚨 Match the NEGATED use, not
			// any occurrence: the positive `billing.accepted` inside the `mayConfirm(...)`
			// call satisfies a bare match, which is exactly how this test initially passed
			// the deliberate break with both handlers stubbed open. The unit tests on
			// `mayConfirm` catch a break inside the predicate; this catches the handler.
			expect(source, `${name} must refuse to confirm without an accepted address`).toMatch(
				/!billing\.accepted/,
			);
		});

		it(`${name} does not double-collect billing details on the Payment Element`, () => {
			// The address form above already collected everything AVS would check; the
			// docs' remedy for the re-ask is `fields.billingDetails: "never"`. If this
			// line is ever removed, the buyer is being asked for the same address twice
			// on one screen — put it back, or write down why it cannot be.
			expect(source, `${name} re-asks for billing details on the Payment Element`).toContain(
				'fields: { billingDetails: "never" }',
			);
		});
	}
});

describe("checkout lives in exactly one place", () => {
	// 🚨 **The Work page's inline checkout is retired, not deprecated.** It cost the
	// first live purchase three defects at once (nested forms, a session POST per page
	// view, swallowed refusals), and the fix was the decision that purchases go through
	// the basket — so any reappearance of Checkout on the Work page's tree regresses a
	// decision, and this is the guard that says so at a glance.
	//
	// Comments are stripped before matching: the retirement's doc comments name the
	// retired mechanism ("CheckoutElementsProvider") to explain why it must not come
	// back, and a scan over the whole file would read that history as a reintroduction —
	// the same lesson `stripe-redirect-guard.test.ts` records about prose matching.

	const code = (rel: string) =>
		read(rel)
			// Block comments first — the file headers live in them.
			.replace(/\/\*[\s\S]*?\*\//g, "")
			// Then line comments.
			.replace(/^\s*\/\/.*$/gm, "");

	for (const [name, rel] of Object.entries(retiredSurfaces)) {
		const source = code(rel);

		it(`${name} mounts no Checkout of any kind`, () => {
			expect(source, `${name} re-imported the checkout subtree`).not.toContain(
				"CheckoutElementsProvider",
			);
			expect(source, `${name} re-imported the checkout subtree`).not.toContain(
				"useCheckoutElements",
			);
		});

		it(`${name} renders no payment form`, () => {
			if (name === "ProjectPricing") {
				// The price card keeps one form-free rule: no `<form>` at all — its two
				// buttons are plain buttons, and buying happens elsewhere.
				expect(source, `${name} grew a form; buying happens in the basket`).not.toMatch(
					/<form[\s>]/,
				);
			}
		});
	}
});
