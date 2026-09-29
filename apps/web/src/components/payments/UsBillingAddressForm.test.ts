// SPDX-License-Identifier: Apache-2.0
//
// What Anthers' own billing address form can and cannot produce.
//
// 🚨 **This is the guard on the whole fix.** The Checkout-flavored Billing Address Element
// offers no country allow-list, so a buyer could pick any country it offers and only the
// server-side completion path would refuse the charge — after the money moved. The
// replacement is US by construction: there is no country field to set and the state comes
// from Anthers' own list, so the property these tests pin is that a non-US address cannot
// be built from the form's output at all, not merely that it usually isn't.
import { describe, expect, test } from "bun:test";
import {
	EMPTY_ADDRESS,
	isAddressComplete,
	toCheckoutContact,
	US_STATES,
} from "./UsBillingAddressForm";

const complete = {
	name: "Parker Davis",
	line1: "123 Main St",
	line2: "",
	city: "Denver",
	state: "CO",
	postalCode: "80202",
};

describe("isAddressComplete", () => {
	test("accepts a full US address", () => {
		expect(isAddressComplete(complete)).toBe(true);
	});

	test("accepts an apartment line as absent — line2 is optional", () => {
		expect(isAddressComplete({ ...complete, line2: "Suite 4" })).toBe(true);
	});

	test("refuses each missing required field", () => {
		expect(isAddressComplete({ ...complete, name: "" })).toBe(false);
		expect(isAddressComplete({ ...complete, name: "  " })).toBe(false);
		expect(isAddressComplete({ ...complete, line1: "" })).toBe(false);
		expect(isAddressComplete({ ...complete, city: "" })).toBe(false);
		expect(isAddressComplete({ ...complete, state: "" })).toBe(false);
		expect(isAddressComplete({ ...complete, postalCode: "" })).toBe(false);
	});

	test("refuses a ZIP that is not a US ZIP", () => {
		// The typos a buyer can actually make: a short one, letters, a Canadian shape.
		expect(isAddressComplete({ ...complete, postalCode: "802" })).toBe(false);
		expect(isAddressComplete({ ...complete, postalCode: "SW1A 1AA" })).toBe(false);
		expect(isAddressComplete({ ...complete, postalCode: "8020X" })).toBe(false);
		// ZIP+4 is a US ZIP too.
		expect(isAddressComplete({ ...complete, postalCode: "80202-1234" })).toBe(true);
	});

	test("refuses a state outside the form's own list — a tampered form, not a typo", () => {
		expect(isAddressComplete({ ...complete, state: "XX" })).toBe(false);
		expect(isAddressComplete({ ...complete, state: "Ontario" })).toBe(false);
	});

	test("the empty address is not complete — confirm stays gated on a blank form", () => {
		expect(isAddressComplete(EMPTY_ADDRESS)).toBe(false);
	});
});

describe("toCheckoutContact", () => {
	test("pins country to US — the form has no other country to produce", () => {
		expect(toCheckoutContact(complete).address.country).toBe("US");
	});

	// ⚠️ The one thing this file exists for, stated as a property: whatever the buyer
	// does within the form, the contact that reaches `updateBillingAddress` is US. The
	// form state carries no country field at all, so there is no input to this function
	// that could yield a different country — and this pair is what notices if one is
	// added: a country field appearing on the form's state is the sabotage's first
	// step, and the pin above is what catches its second.
	test("cannot produce a non-US country — the form has no country field to produce one", () => {
		expect(Object.keys(EMPTY_ADDRESS), "the form's state grew a country field").not.toContain(
			"country",
		);
		const contact = toCheckoutContact(complete);
		expect(contact.address.country).toBe("US");
	});

	test("carries every field the session's tax resolution reads", () => {
		const contact = toCheckoutContact({ ...complete, line2: "Suite 4" });
		expect(contact.name).toBe("Parker Davis");
		expect(contact.address).toEqual({
			country: "US",
			line1: "123 Main St",
			line2: "Suite 4",
			city: "Denver",
			state: "CO",
			postal_code: "80202",
		});
	});

	test("trims what the buyer typed and drops an empty apartment line to null", () => {
		const contact = toCheckoutContact({ ...complete, line1: "  123 Main St  " });
		expect(contact.address.line1).toBe("123 Main St");
		expect(contact.address.line2).toBeNull();
	});
});

describe("the state list", () => {
	test("is fifty states plus DC, every code two uppercase letters", () => {
		expect(US_STATES).toHaveLength(51);
		for (const s of US_STATES) {
			expect(s.code).toMatch(/^[A-Z]{2}$/);
			expect(s.name).not.toBe("");
		}
	});

	test("holds no duplicates a select could collapse", () => {
		expect(new Set(US_STATES.map((s) => s.code)).size).toBe(US_STATES.length);
		expect(new Set(US_STATES.map((s) => s.name)).size).toBe(US_STATES.length);
	});
});
