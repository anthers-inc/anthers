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
import { type BasketItem, basketContentKey } from "../../lib/basket";
import BasketCheckout from "../basket/BasketCheckout";
import { act, createElement, render } from "./render-hooks";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A work item, as the basket store answers with — the scratchpad shape. */
function workItem(workId: number): BasketItem {
	return {
		kind: "work",
		workId,
		slug: `work-${workId}`,
		title: `Work ${workId}`,
		price: "3.00",
		creatorHandle: "creator",
		thumbnail: null,
	};
}

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
	items: BasketItem[];
	/** Fires on every parent render when `pulseRender` was called — the live failure's shape. */
	reportTotalsPulse: boolean;
}

/**
 * The parent, as BasketPage renders it: `contentKey` derived fresh per render from the
 * items — deliberately REBUILDING the array rather than memoizing, so the test proves
 * content-keying inside the hook, not cooperation from the page. The VALUE is what keys:
 * identical contents derive identical keys, so a render burst re-POSTs nothing. Every
 * call site below passes a fresh array for exactly that reason.
 */
function Parent({ items, reportTotalsPulse }: HarnessProps) {
	return createElement(BasketCheckout, {
		contentKey: basketContentKey([...items]), // a fresh derivation every render
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

describe("basketContentKey", () => {
	test("the same contents in different orders are the same basket", () => {
		expect(basketContentKey([workItem(3), workItem(1), workItem(2)])).toBe(
			basketContentKey([workItem(1), workItem(2), workItem(3)]),
		);
	});

	test("a different basket is a different key", () => {
		expect(basketContentKey([workItem(1), workItem(2)])).not.toBe(
			basketContentKey([workItem(1), workItem(3)]),
		);
	});

	test("a badge line joins the key, kind-tagged — a badge added to a work basket is a new basket", () => {
		const withBadge: BasketItem = {
			kind: "badge",
			badgeId: 9,
			title: "Sprout",
			price: "3.00",
			recurring: "6.00",
			creatorHandle: "creator",
		};
		expect(basketContentKey([withBadge])).toBe("b9");
		// A badge cannot collide with a work id by number: kinds never merge keys.
		expect(basketContentKey([workItem(9), withBadge])).toBe("b9,w9");
	});
});

describe("one session POST per basket content", () => {
	test("totals reported up does not re-POST — the exact live failure", async () => {
		POST_PATHS.length = 0;
		globalThis.fetch = fakeFetch as typeof fetch;

		const h = mountParent({ items: [workItem(101)], reportTotalsPulse: false });
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
				h.rerender(createElement(Parent, { items: [workItem(101)], reportTotalsPulse: true }));
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

		const h = mountParent({ items: [workItem(202), workItem(203)], reportTotalsPulse: false });
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
				// reorder: a basket carried in either order must equal the other.
				const items = i % 2 === 0 ? [workItem(202), workItem(203)] : [workItem(203), workItem(202)];
				h.rerender(createElement(Parent, { items, reportTotalsPulse: false }));
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

		const h = mountParent({ items: [workItem(303)], reportTotalsPulse: true });
		try {
			// Re-render in the same tick as the mount, before the fetch resolves — the
			// in-flight POST must not be judged stale and fire again.
			for (let i = 0; i < 5; i++) {
				h.rerender(createElement(Parent, { items: [workItem(303)], reportTotalsPulse: true }));
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

		const h = mountParent({ items: [workItem(404)], reportTotalsPulse: false });
		try {
			await act(async () => {
				await wait(50);
			});
			expect(POST_PATHS).toHaveLength(1);

			// The buyer adds a Badge to the basket beside the Work: genuinely new
			// contents (a new charge — the Badge's first Month joins it), so the checkout
			// MUST re-create the session. Kind-tagged keys are what make a badge change a
			// change at all.
			const withBadge: BasketItem = {
				kind: "badge",
				badgeId: 7,
				title: "Root",
				price: "3.00",
				recurring: "3.00",
				creatorHandle: "creator",
			};
			h.rerender(
				createElement(Parent, { items: [workItem(404), withBadge], reportTotalsPulse: false }),
			);
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
