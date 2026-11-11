// SPDX-License-Identifier: Apache-2.0
//
// What the settings payment card may and may not mount.
//
// 🚨 **This is a source-text guard, in the family of `payments/checkout-address-guard.test.ts`.**
// No browser spec reaches this form: the browser session has no Stripe key, so the setup POST
// 503s before any Element mounts, and the e2e only asserts the card's heading. Until a live
// walk exists, nothing but this file notices the shape the 2026-11-11 change settled:
//
// 1. **Both halves are Stripe's Elements.** The address is an `AddressElement` in billing
//    mode, restricted to the US; the card is a `PaymentElement`. The legacy `CardElement`
//    collected a postal code by default, which is what made a reader type the same ZIP twice.
// 2. **The ZIP is collected once.** The Payment Element runs `fields.billingDetails: "never"`
//    because the Address Element above it already collected everything AVS would check.
// 3. **The address is not posted before the card.** It rides the SetupIntent at confirmation,
//    so `stripe.confirmSetup` is the confirm call and the billing-address route is written
//    only by the address-only form.
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

	it("mounts the Payment Element with billing details turned off", () => {
		expect(source, "the settings card lost its Stripe card element").toContain("<PaymentElement");
		// The address above already collected everything AVS would check; the docs' remedy
		// for the re-ask is `fields.billingDetails: "never"`. If this line is ever removed,
		// the reader is being asked for the same address twice on one screen.
		expect(source, "the card element re-asks for billing details").toContain(
			'fields: { billingDetails: "never" }',
		);
	});

	it("does not mount the legacy card field that asked for a second ZIP", () => {
		// `CardElement` collects a postal code by default (`hidePostalCode` defaults to
		// false). Reintroducing it puts the duplicate ZIP back, which is the defect.
		expect(source, "the legacy CardElement came back").not.toMatch(/\bCardElement\b/);
	});

	it("does not mount Anthers' own address form on this surface", () => {
		// The own form remains checkout's, where the Checkout-flavored Billing Address
		// Element cannot enforce the US boundary. Settings is not a purchase surface.
		expect(source, "the settings card remounted Anthers' address form").not.toContain(
			"<UsBillingAddressForm",
		);
	});

	it("confirms the SetupIntent with the elements group, not a card element", () => {
		expect(source, "the settings card stopped confirming through the Elements group").toContain(
			"stripe.confirmSetup(",
		);
		expect(source, "the settings card still confirms a bare card element").not.toContain(
			"confirmCardSetup",
		);
	});

	it("writes the billing-address route only from the address-only form", () => {
		// The card path lets the SetupIntent carry the address; a call inside `CardSetupForm`
		// is the pre-confirm POST this change removed. The address-only form and the
		// removal's clear are the route's remaining writers.
		const cardStart = source.indexOf("function CardSetupForm");
		const addressStart = source.indexOf("function AddressForm");
		expect(cardStart, "CardSetupForm is gone — update this guard").toBeGreaterThan(-1);
		expect(addressStart, "AddressForm is gone — update this guard").toBeGreaterThan(cardStart);
		expect(
			source.slice(cardStart, addressStart),
			"the card path posts the address before confirming",
		).not.toContain("/api/accounts/me/billing-address");
	});
});
