// SPDX-License-Identifier: Apache-2.0
/**
 * A real React DOM for hook tests, in Bun, with no test-framework dependencies beyond
 * `happy-dom` (a devDependency of the web app).
 *
 * 🚨 Why this exists: the auto-tax and session-stability tests must observe a *mounted
 * React tree* — effects running, debounce timers armed by effects, input state held
 * across re-renders — because the defects they guard (the checkout session remount, the
 * debounced resolve) are effects-and-identity bugs that pure-function tests cannot see.
 * Bun's `bun:test` ships no DOM renderer, so this module registers happy-dom as the
 * global window and drives React 19's `createRoot` directly, wrapping every flush in
 * `act`. There is deliberately no testing-library: a probe component capturing a hook's
 * return value is the entire interface the tests need.
 *
 * ⚠️ **One Bun process runs every test file in the repo**, so registering a DOM here is
 * a visible change to every suite that runs after this file. Two properties make it
 * safe, and both are load-bearing:
 * 1. Registration happens lazily on the FIRST render-test import, and the network
 *    globals happy-dom would clobber (`fetch`, `Response`, `Request`, `Headers`,
 *    `crypto`, `performance`, …) are snapshotted BEFORE registration and re-pinned
 *    right after — the API suites' recording fetch fakes and webhook HMAC run on Bun's
 *    own implementations and never see happy-dom's.
 * 2. `IS_REACT_ACT_ENVIRONMENT` is set here rather than in each test, because `act`
 *    warns (or worse, doesn't flush) without it outside a testing-framework harness.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The globals happy-dom's window would shadow and the rest of the suite needs to be
 * Bun's own. Re-pinned immediately after registration, before any test body runs.
 *
 * 🚨 Snapshotted as **property descriptors, not values**. Several of these are
 * getter-only properties on Bun's globalThis (`localStorage`, among others are
 * writable; `fetch` is own-writable), and a value-only repin through `Object.assign`
 * would THROW on a getter-only key — while a repin that only carried values would
 * strip custom getters other suites rely on. `Object.defineProperty` with the saved
 * descriptor restores each one to exactly what Bun had.
 */
const BUN_GLOBALS = [
	"fetch",
	"Response",
	"Request",
	"Headers",
	"FormData",
	"AbortController",
	"URL",
	"URLSearchParams",
	"crypto",
	"performance",
	"TextEncoder",
	"TextDecoder",
	"ReadableStream",
	"WritableStream",
	// Storage: the volume test (`transport/volume.test.ts`) stubs `globalThis.localStorage`
	// directly, which happy-dom's window makes a read-only accessor — restored here.
	"localStorage",
	"sessionStorage",
] as const;

let registered = false;

function ensureDom(): void {
	if (registered) return;
	const descriptors = Object.fromEntries(
		BUN_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const hadKey = Object.fromEntries(BUN_GLOBALS.map((key) => [key, key in globalThis]));
	GlobalRegistrator.register();
	for (const key of BUN_GLOBALS) {
		const d = descriptors[key] as PropertyDescriptor | undefined;
		// Absent on Bun before registration: delete whatever happy-dom left, so a test
		// probing `key in globalThis` sees the same answer it would have pre-DOM.
		if (!hadKey[key]) {
			delete (globalThis as Record<string, unknown>)[key];
		} else if (d) {
			Object.defineProperty(globalThis, key, d);
		}
	}
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	registered = true;
}

/** The React plumbing the tests import, re-exported so call sites read uniformly. */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Render an element into a detached container under the registered document, inside
 * `act`, and return the controls a re-render test needs: an `unmount` and a `rerender`
 * that flushes synchronously (the way a parent re-render commits).
 */
export function render(element: ReactNode): {
	unmount: () => void;
	rerender: (el: ReactNode) => void;
} {
	ensureDom();
	let root: Root | null = null;
	let current = element;
	const container = document.createElement("div");
	document.body.appendChild(container);

	act(() => {
		root = createRoot(container);
		root.render(current);
	});

	return {
		unmount: () => {
			const r = root;
			root = null;
			container.remove();
			if (r) act(() => r.unmount());
		},
		rerender: (el: ReactNode) => {
			current = el;
			act(() => root?.render(current));
		},
	};
}

/**
 * Flush pending effects and timers: advances nothing by itself — debounce tests pass a
 * `wait` promise in, exactly like a caller would — but guarantees React has processed
 * state updates made outside `act` before an assertion reads them.
 */
export function flushEffects(): void {
	act(() => {});
}

export { act, createElement };
