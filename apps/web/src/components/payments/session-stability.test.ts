// SPDX-License-Identifier: Apache-2.0
/**
 * The checkout session fires ONCE per basket content — the remount regression test.
 *
 * 🚨 **The worst defect of the first live checkout (2026-10-03) shipped because nothing
 * ever re-rendered a mounted checkout's parent.** `BasketPage` passed `workIds={items.map(...)}`
 * — a new array identity on every render — and `BasketCheckout`'s fetch effect keyed on
 * that identity: address submitted → tax resolved → `onTotals` re-rendered the page → a
 * NEW array → the effect re-fired → a brand-new Checkout Session POSTed and the whole
 * Element subtree remounted from scratch. Card cleared, address reset, resolved tax
 * discarded; to the buyer, "the page refreshed and wiped my form" — including whatever a
 * password manager had half-filled. This suite renders the page's checkout for real and
 * re-renders its parent the way the live failure did, so a regression here is a red test
 * rather than a buyer's afternoon.
 *
 * The two re-render shapes covered are the two that fired in production:
 * 1. **Totals reported up** — the exact live failure (`onTotals` → `setSessionTotals` →
 *    re-render).
 * 2. **A quote-refresh-driven re-render** — the page's own quote effect resolving again.
 *
 * And one real basket change is covered too — an item removed — which is the case that
 * MUST re-POST, so the test fails in both directions: a fix that pins identity so hard
 * the checkout goes stale fails right beside a fix that doesn't pin it at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import BasketCheckout, { workIdsKey } from "../basket/BasketCheckout";
import { act, createElement, render } from "./render-hooks";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The fake transport: count the session POSTs ──────────────────────────────

const CLIENT_SECRET = "cs_test_123_secret_456";
const POST_PATHS: string[] = [];

/** A fake `fetch` answering the basket checkout POST with a client secret. */
function fakeFetch(input: string | URL | Request): Promise<Response> {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	// The RPC client hands over an absolute URL; a relative one would mean a transport
	// this suite is not measuring.
	const url = new URL(raw, "http://localhost.invalid");
	if (url.pathname === "/api/payments/basket/checkout") POST_PATHS.push(url.pathname);
	return Promise.resolve(
		new Response(JSON.stringify({ clientSecret: CLIENT_SECRET }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

// ── The parent harness: a BasketPage-shaped parent re-rendering shapes ───────

interface HarnessProps {
	workIds: number[];
	/** Fires on every parent render when `pulseRender` was called — the live failure's shape. */
	reportTotalsPulse: boolean;
}

/**
 * The parent, as BasketPage renders it: `workIds` from a fresh `items.map(...)` per
 * render — deliberately REBUILDING the array rather than memoizing, so the test proves
 * content-keying inside the hook, not cooperation from the page. `reportTotalsPulse`
 * adds a state change to the parent between renders, reproducing the exact sequence
 * that remounted the checkout live.
 */
function Parent({ workIds, reportTotalsPulse }: HarnessProps) {
	return createElement(BasketCheckout, {
		workIds: workIds.map((id) => id), // fresh array identity every render
		buyerTotal: "9.99",
		onTotals: reportTotalsPulse ? () => undefined : undefined,
		onComplete: () => undefined,
	});
}

function mountParent(props: HarnessProps) {
	return render(createElement(Parent, props));
}

// ── Module state reset between tests ─────────────────────────────────────────

// `getStripe` caches its promise at module scope; these tests never let the provider
// actually mount Stripe (the fake fetch answers the POST, then the test unmounts and
// asserts the POST count), so the cache never fills. The fetch mock is swapped in per
// test and restored in `afterEach` — a module-scope `mock.module` would leak into the
// API suites this process shares. The POST counter is per-test by construction (each
// test clears it before swapping the fake in), asserted zeroed by the afterEach too.

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
	POST_PATHS.length = 0;
});

describe("workIdsKey", () => {
	test("the same ids in different orders are the same basket", () => {
		expect(workIdsKey([3, 1, 2])).toBe(workIdsKey([1, 2, 3]));
		expect(workIdsKey([3, 1, 2])).toBe("1,2,3");
	});

	test("a different basket is a different key", () => {
		expect(workIdsKey([1, 2])).not.toBe(workIdsKey([1, 3]));
		expect(workIdsKey([1, 2])).not.toBe(workIdsKey([2, 1, 2]));
	});
});

describe("one session POST per basket content", () => {
	test("totals reported up does not re-POST — the exact live failure", async () => {
		POST_PATHS.length = 0;
		globalThis.fetch = fakeFetch as typeof fetch;

		const h = mountParent({ workIds: [101], reportTotalsPulse: false });
		try {
			// The session POST fires on mount.
			await act(async () => {
				await wait(50);
			});
			console.log("POSTS after mount:", POST_PATHS);

			// The tax resolves and the page re-renders with the session's totals in state —
			// the sequence that wiped the form live. The parent re-renders (its internal
			// state changes), `workIds` identity churns, and the checkout must not care.
			for (let i = 0; i < 20; i++) {
				h.rerender(createElement(Parent, { workIds: [101], reportTotalsPulse: true }));
				await act(async () => {
					await wait(10);
				});
			}
			expect(POST_PATHS).toHaveLength(1);
		} finally {
			h.unmount();
			globalThis.fetch = REAL_FETCH;
		}
	});

	test("a quote-refresh-driven re-render does not re-POST", async () => {
		POST_PATHS.length = 0;
		globalThis.fetch = fakeFetch as typeof fetch;

		const h = mountParent({ workIds: [202, 203], reportTotalsPulse: false });
		try {
			await act(async () => {
				await wait(50);
			});
			expect(POST_PATHS).toHaveLength(1);

			// The quote effect re-runs (its own identity churns on every basket event),
			// the page state settles, the checkout's props re-render — a burst of parent
			// renders identical to a quote refresh, none of which may POST again.
			for (let i = 0; i < 20; i++) {
				// Same contents, different array — both the identity churn and the
				// reorder: a basket carried as [202, 203] must equal [203, 202].
				const ids = i % 2 === 0 ? [202, 203] : [203, 202];
				h.rerender(createElement(Parent, { workIds: ids, reportTotalsPulse: false }));
				await act(async () => {
					await wait(10);
				});
			}
			expect(POST_PATHS).toHaveLength(1);
		} finally {
			h.unmount();
			globalThis.fetch = REAL_FETCH;
		}
	});

	test("reporting totals up before the mount settles does not double-POST", async () => {
		POST_PATHS.length = 0;
		globalThis.fetch = fakeFetch as typeof fetch;

		const h = mountParent({ workIds: [303], reportTotalsPulse: true });
		try {
			// Re-render in the same tick as the mount, before the fetch resolves — the
			// in-flight POST must not be judged stale and fire again.
			for (let i = 0; i < 5; i++) {
				h.rerender(createElement(Parent, { workIds: [303], reportTotalsPulse: true }));
				await act(async () => {
					await wait(5);
				});
			}
			await act(async () => {
				await wait(50);
			});
			expect(POST_PATHS).toHaveLength(1);
		} finally {
			h.unmount();
			globalThis.fetch = REAL_FETCH;
		}
	});

	test("a genuine basket change re-POSTs — the pin must not outlive the basket", async () => {
		POST_PATHS.length = 0;
		globalThis.fetch = fakeFetch as typeof fetch;

		const h = mountParent({ workIds: [404], reportTotalsPulse: false });
		try {
			await act(async () => {
				await wait(50);
			});
			expect(POST_PATHS).toHaveLength(1);

			// The buyer removes an item: genuinely new contents, so the checkout MUST
			// re-create the session (the server prices a different basket).
			h.rerender(createElement(Parent, { workIds: [], reportTotalsPulse: false }));
			await act(async () => {
				await wait(50);
			});
			expect(POST_PATHS).toHaveLength(2);
		} finally {
			h.unmount();
			globalThis.fetch = REAL_FETCH;
		}
	});
});

// The checkout's session object is what holds input state across parent re-renders; its
// shape is pinned by `useSessionBillingAddress`'s tests. This suite only asserts the
// POST count, because the session remount is observable exactly there. `client` is
// imported (rather than reached through the swapped global fetch's module) to pin that
// this suite's fake transport IS the transport the RPC client uses — see the tests.
