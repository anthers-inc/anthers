// SPDX-License-Identifier: Apache-2.0
/**
 * The cart's delivery-address hook — the physical-only half of checkout.
 *
 * The behavior that matters: "same as billing" pushes the accepted billing address to the
 * session, unchecking it starts a separate address from that billing value, and only a
 * complete settled address reaches `updateShippingAddress`. The cart's confirm gate reads
 * `accepted`, so a half-typed delivery address can never pay.
 */
import { describe, expect, test } from "bun:test";
import type { StripeUseCheckoutElementsResult } from "@stripe/react-stripe-js/checkout";
import type { StripeCheckoutContact, StripeCheckoutSession } from "@stripe/stripe-js";
import { act, createElement, render } from "./render-hooks";
import { EMPTY_ADDRESS, type UsAddressInput } from "./UsBillingAddressForm";
import type { SessionBillingAddress } from "./useSessionBillingAddress";
import { useSessionShippingAddress } from "./useSessionShippingAddress";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const AFTER_DEBOUNCE = 900;

const COMPLETE: UsAddressInput = {
	name: "Parker Davis",
	line1: "123 Main St",
	line2: "",
	city: "Denver",
	state: "CO",
	postalCode: "80202",
};

function fakeSession() {
	const calls: StripeCheckoutContact[] = [];
	const session = {
		updateShippingAddress: async (contact: StripeCheckoutContact) => {
			calls.push(contact);
			return { type: "success", session };
		},
	} as unknown as StripeCheckoutSession;
	return { calls, session };
}

function billing(overrides?: Partial<SessionBillingAddress>): SessionBillingAddress {
	return {
		address: COMPLETE,
		setAddress: () => undefined,
		acceptedAddress: COMPLETE,
		accepted: true,
		error: null,
		updating: false,
		...overrides,
	};
}

function mount(options?: { billing?: SessionBillingAddress; enabled?: boolean }) {
	const fake = fakeSession();
	const checkoutState = {
		type: "success",
		checkout: fake.session,
	} as unknown as StripeUseCheckoutElementsResult;
	const exposed = { current: null as ReturnType<typeof useSessionShippingAddress> | null };
	function Probe() {
		exposed.current = useSessionShippingAddress({
			checkoutState,
			billing: options?.billing ?? billing(),
			enabled: options?.enabled ?? true,
		});
		return null;
	}
	const handle = render(createElement(Probe));
	return { calls: fake.calls, exposed, handle };
}

describe("the cart's delivery address", () => {
	test("same-as-billing pushes the accepted billing address to the session", async () => {
		const h = mount();
		await act(async () => {
			await wait(AFTER_DEBOUNCE);
		});
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.address).toMatchObject({
			line1: COMPLETE.line1,
			city: COMPLETE.city,
			state: COMPLETE.state,
			postal_code: COMPLETE.postalCode,
			country: "US",
		});
		expect(h.exposed.current?.accepted).toBe(true);
		h.handle.unmount();
	});

	test("unchecking starts from billing and sends only a complete separate address", async () => {
		const h = mount({ billing: billing({ accepted: false, acceptedAddress: null }) });
		act(() => h.exposed.current!.setSameAsBilling(false));
		act(() => h.exposed.current!.setAddress(EMPTY_ADDRESS));
		await act(async () => {
			await wait(200);
		});
		expect(h.calls).toHaveLength(0);

		act(() => h.exposed.current!.setAddress(COMPLETE));
		await act(async () => {
			await wait(AFTER_DEBOUNCE);
		});
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.name).toBe(COMPLETE.name);
		h.handle.unmount();
	});

	test("a non-physical cart never writes a shipping address and is always accepted", async () => {
		const h = mount({
			enabled: false,
			billing: billing({ accepted: false, acceptedAddress: null }),
		});
		await act(async () => {
			await wait(200);
		});
		expect(h.calls).toHaveLength(0);
		expect(h.exposed.current?.accepted).toBe(true);
		h.handle.unmount();
	});
});
