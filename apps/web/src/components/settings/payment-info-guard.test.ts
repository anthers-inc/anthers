// SPDX-License-Identifier: Apache-2.0
//
// What the settings payment card may and may not mount.
//
// 🚨 **This is a source-text guard, in the family of `payments/checkout-address-guard.test.ts`.**
// No browser spec reaches this form: the browser session has no Stripe key, so the portal
// POST 503s before any Element mounts, and the e2e only asserts the card's heading. Until a
// live walk exists, nothing but this file notices the shape the 2026-11-13 split settled:
//
// 1. **Settings owns the billing address.** The address is an `AddressElement` in billing
//    mode, restricted to the US; it is the only address UI on this surface.
// 2. **Stripe owns the card.** The card section is a read-only summary plus the Portal's
//    payment-method deep link; the SetupIntent and PaymentElement form that used to live
//    here are gone, and a reintroduction is a regression of the split.
// 3. **The address is written only from the address form.**
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "PaymentInfoSection.tsx"), "utf8")
	// Block comments first — the file header names every retired mechanism.
	.replace(/\/\*[\s\S]*?\*\//g, "")
	// Then line comments.
	.replace(/^\s*\/\/.*$/gm, "");

describe("the settings payment card", () => {
	it("mounts Stripe's Address Element, restricted to the US", () => {
		expect(source, "the settings card lost its Stripe address element").toContain(
			"<AddressElement",
		);
		expect(source, "the address element is no longer US-only").toContain(
			'allowedCountries: ["US"]',
		);
	});

	it("keeps the card form out of settings and opens the Portal instead", () => {
		// The split: the Portal's payment-method page owns adding, replacing and removing a
		// card. A card field reappearing here is the old surface coming back, not a polish.
		expect(source, "the settings card remounted a card field").not.toContain("<PaymentElement");
		expect(source, "the legacy card field came back").not.toMatch(/\bCardElement\b/);
		expect(source, "the settings card started a SetupIntent again").not.toContain("confirmSetup");
		expect(source, "the settings card lost its Portal link").toContain(
			"/api/subscriptions/payment-method-portal",
		);
	});

	it("does not mount Anthers' own address form on this surface", () => {
		// The own form remains checkout's, where the Checkout-flavored Billing Address
		// Element cannot enforce the US boundary. Settings is not a purchase surface.
		expect(source, "the settings card remounted Anthers' address form").not.toContain(
			"<UsBillingAddressForm",
		);
	});

	it("writes the billing-address route only from the address-only form", () => {
		const addressStart = source.indexOf("function AddressForm");
		expect(addressStart, "AddressForm is gone — update this guard").toBeGreaterThan(-1);
		expect(
			source.slice(addressStart),
			"the address route is written outside the address form",
		).toContain("/api/accounts/me/billing-address");
	});
});
