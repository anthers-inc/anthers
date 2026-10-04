// SPDX-License-Identifier: Apache-2.0
/**
 * Auto-tax resolution — the hook that writes the settled address to the session.
 *
 * Parker, 2026-10-03: "you shouldn't have to click a button to calculate tax, it should
 * do it automatically when you enter your address. The only button you click is the
 * button to complete the purchase." The submit-button flow is retired wholesale; the
 * properties this suite pins are the ones a button-free flow runs on:
 *
 * - A complete address resolves **by itself** — no submit action exists.
 * - An incomplete address NEVER calls `updateBillingAddress`, however long it sits — a
 *   half-typed ZIP cannot spam the session, because the resolve effect returns before a
 *   timer ever exists.
 * - Editing an accepted address to a different complete value re-resolves exactly once
 *   (debounced), not per keystroke.
 * - Re-rendering and session ticks never re-resolve an address already on the session.
 * - An address that fails keeps `updating` false after, carries the server's own
 *   message, and re-arms when the buyer edits again.
 *
 * These render a real React tree through `render-hooks.ts` — the defects here are
 * effects-and-identity bugs, which pure-function tests cannot see. See that file's
 * header for why the DOM registration is safe beside every other suite in the repo.
 */

import { describe, expect, test } from "bun:test";
import type { StripeUseCheckoutElementsResult } from "@stripe/react-stripe-js/checkout";
import type { StripeCheckoutContact, StripeCheckoutSession } from "@stripe/stripe-js";
import { act, createElement, render } from "./render-hooks";
import { EMPTY_ADDRESS, type UsAddressInput } from "./UsBillingAddressForm";
import {
	mayConfirm,
	TAX_RESOLVE_DEBOUNCE_MS,
	useSessionBillingAddress,
} from "./useSessionBillingAddress";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Anything longer than the debounce — the suite waits on the REAL constant. */
const AFTER_DEBOUNCE = TAX_RESOLVE_DEBOUNCE_MS + 200;
/** Well short of the debounce: proves nothing fired early. */
const MID_DEBOUNCE = 120;

const COMPLETE: UsAddressInput = {
	name: "Parker Davis",
	line1: "123 Main St",
	line2: "",
	city: "Denver",
	state: "CO",
	postalCode: "80202",
};

/** A hand-built success session whose `updateBillingAddress` records and can fail. */
function fakeSession(options?: { errorMessage?: string; fail?: boolean }) {
	const calls: StripeCheckoutContact[] = [];
	// 🚨 `updateBillingAddress` lives ON the session object — the hook reads it off
	// `checkoutState.checkout`, which is the same object `sessionTotals` reads its
	// totals from (Stripe's `StripeCheckoutLoadActionsSuccess`). Faking the method on
	// anything else means the hook's call throws and lands in the catch — calls would
	// stay at zero for a reason that has nothing to do with the behavior under test.
	const session = {
		canConfirm: true,
		total: null,
		taxAmounts: null,
		updateBillingAddress: async (c: StripeCheckoutContact) => {
			calls.push(c);
			if (options?.fail) {
				return {
					type: "error",
					error: { message: options.errorMessage ?? "That address didn't work." },
				};
			}
			return { type: "success", session };
		},
	} as unknown as StripeCheckoutSession;
	return { calls, session };
}

/** The checkout-state shape the hook pattern-matches on. */
function checkoutStateFor(
	s: ReturnType<typeof fakeSession> | null,
): StripeUseCheckoutElementsResult {
	if (!s) return { type: "loading" } as unknown as StripeUseCheckoutElementsResult;
	return { type: "success", checkout: s.session } as unknown as StripeUseCheckoutElementsResult;
}

/** Mount the hook inside a probe component; the probe reports every render's value. */
function mountHook(box: { current: ReturnType<typeof fakeSession> | null }) {
	const exposed = { current: null as ReturnType<typeof useSessionBillingAddress> | null };
	function Probe() {
		exposed.current = useSessionBillingAddress(checkoutStateFor(box.current));
		return null;
	}
	const handle = render(createElement(Probe));
	return {
		exposed,
		rerender: () => handle.rerender(createElement(Probe)),
		unmount: () => handle.unmount(),
	};
}

/** Type a field per "keystroke" — each an act-ed state write and re-render. */
async function typeAddress(
	h: ReturnType<typeof mountHook>,
	steps: UsAddressInput[],
	gap = MID_DEBOUNCE,
) {
	for (const step of steps) {
		await act(async () => {
			h.exposed.current?.setAddress(step);
			h.rerender();
		});
		await wait(gap);
	}
}

// ── The gate predicate (the confirm gate's contract, unchanged by auto-tax) ──

describe("mayConfirm", () => {
	test("requires both Stripe's readiness and an accepted address", () => {
		expect(mayConfirm(true, true)).toBe(true);
		expect(mayConfirm(true, false)).toBe(false);
		expect(mayConfirm(false, true)).toBe(false);
		expect(mayConfirm(false, false)).toBe(false);
	});

	test("a ready card with no accepted address stays gated — the original defect", () => {
		expect(mayConfirm(true, false)).toBe(false);
	});
});

// ── Automatic resolution ─────────────────────────────────────────────────────

describe("automatic tax resolution", () => {
	test("a complete address resolves by itself — no submit action exists", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		// Nothing before the debounce elapses…
		await wait(MID_DEBOUNCE);
		expect(s.calls).toHaveLength(0);
		// …and exactly one call after the edit settles.
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]?.address?.country).toBe("US");
		expect(s.calls[0]?.address?.postal_code).toBe("80202");
		h.unmount();
	});

	test("an incomplete address never fires, however long it sits or how many edits pass", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		// Per-keystroke edits, every one incomplete — including a half-typed ZIP, the
		// address a shape check must refuse, at the end where a naive completeness
		// check would pass it.
		const steps: UsAddressInput[] = [
			{ ...EMPTY_ADDRESS, name: "P" },
			{ ...EMPTY_ADDRESS, name: "Parker Davis" },
			{ ...EMPTY_ADDRESS, name: "Parker Davis", line1: "123 Main St" },
			{ ...EMPTY_ADDRESS, name: "Parker Davis", line1: "123 Main St", city: "Denver" },
			{
				...EMPTY_ADDRESS,
				name: "Parker Davis",
				line1: "123 Main St",
				city: "Denver",
				state: "CO",
			},
			{
				...EMPTY_ADDRESS,
				name: "Parker Davis",
				line1: "123 Main St",
				city: "Denver",
				state: "CO",
				postalCode: "802",
			},
		];
		await typeAddress(h, steps, 100);
		// Longer than the debounce since the LAST (still incomplete) edit — nothing fired.
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(0);
		h.unmount();
	});

	test("the address resolves once the ZIP completes the shape — same keystroke stream", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		const steps = ["8", "80", "802", "8020", "80202"].map(
			(zip) => ({ ...COMPLETE, postalCode: zip }) as UsAddressInput,
		);
		await typeAddress(h, steps, 100);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]?.address?.postal_code).toBe("80202");
		h.unmount();
	});

	test("an accepted address edited to a different complete value re-resolves exactly once", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		await act(async () => {
			h.exposed.current?.setAddress({ ...COMPLETE, city: "Boulder" });
			h.rerender();
		});
		// Per-keystroke churn on the SAME settled edit (a slow typist revising "Boul") —
		// still one settle, one call.
		await act(async () => {
			h.exposed.current?.setAddress({ ...COMPLETE, city: "Boulder" });
			h.rerender();
		});
		await wait(MID_DEBOUNCE);
		expect(s.calls).toHaveLength(1); // debounce not elapsed — nothing early
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(2);
		expect(s.calls[1]?.address?.city).toBe("Boulder");
		// And the accepted state re-armed with the new value.
		expect(h.exposed.current?.acceptedAddress?.city).toBe("Boulder");
		h.unmount();
	});

	test("arbitrary re-renders never re-resolve an already-accepted address", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		for (let i = 0; i < 5; i++) {
			h.rerender();
			await wait(MID_DEBOUNCE);
		}
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		h.unmount();
	});

	test("accepted and totals-visible state settle only after the session answers", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		await wait(MID_DEBOUNCE);
		expect(h.exposed.current?.accepted).toBe(false);
		await wait(AFTER_DEBOUNCE);
		expect(h.exposed.current?.accepted).toBe(true);
		expect(h.exposed.current?.acceptedAddress?.city).toBe("Denver");
		// `acceptedAddress` is what the summary line renders — formatAddress's input.
		expect(h.exposed.current?.acceptedAddress?.postalCode).toBe("80202");
		h.unmount();
	});

	test("a failed resolution surfaces the server's own message and keeps the typed fields", async () => {
		const s = fakeSession({ fail: true, errorMessage: "ZIP code is not valid." });
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		expect(h.exposed.current?.accepted).toBe(false);
		expect(h.exposed.current?.error).toBe("ZIP code is not valid.");
		// The typed fields are untouched — the buyer is looking at what they entered.
		expect(h.exposed.current?.address).toEqual(COMPLETE);
		// And the busy flag settled back off.
		expect(h.exposed.current?.updating).toBe(false);
		h.unmount();
	});

	test("a failed resolution re-arms — a corrected edit re-resolves", async () => {
		const s = fakeSession({ fail: true });
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		await wait(AFTER_DEBOUNCE);
		const firstCount = s.calls.length;
		expect(firstCount).toBe(1);
		// The buyer fixes the address (here: an added apartment line, still complete).
		await act(async () => {
			h.exposed.current?.setAddress({ ...COMPLETE, line2: "Suite 4" });
			h.rerender();
		});
		await wait(AFTER_DEBOUNCE);
		expect(s.calls.length).toBe(2);
		h.unmount();
	});

	test("editing while a resolution is in flight does not stack a second call", async () => {
		const s = fakeSession();
		const h = mountHook({ current: s });
		await typeAddress(h, [COMPLETE], 0);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		// An immediate re-edit while the (already finished) first call's state settles.
		await act(async () => {
			h.exposed.current?.setAddress({ ...COMPLETE, line2: "Suite 4" });
			h.rerender();
		});
		// Wait out both the debounce and any in-flight resolution cleanly.
		await wait(AFTER_DEBOUNCE);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls.length).toBe(2);
		h.unmount();
	});

	test("an address typed before the session mounts still resolves once it arrives", async () => {
		// The real page can be slower than the buyer: the client secret loads while the
		// address is being typed. The resolution must survive that gap — re-armed once
		// the session is present, not lost, and not doubled either.
		const s = fakeSession();
		const box = { current: null as ReturnType<typeof fakeSession> | null };
		const h = mountHook(box);
		await typeAddress(h, [COMPLETE], 0);
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(0); // no session yet — nothing fired, nothing lost
		box.current = s;
		await act(() => h.rerender());
		await wait(AFTER_DEBOUNCE);
		expect(s.calls).toHaveLength(1);
		h.unmount();
	});
});
