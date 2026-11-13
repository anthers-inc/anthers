// SPDX-License-Identifier: Apache-2.0
//
// The alpha notice's remembered answer: a first visit shows it, closing it keeps it away,
// and a browser that refuses storage shows it rather than taking the page down. The
// direction of every failure is "the notice still shows", which is the honest reading of a
// browser with nowhere to remember a choice.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dismissAlphaNotice, readAlphaNoticeDismissed } from "./alpha-notice";

const realStorage = globalThis.localStorage;

beforeEach(() => {
	const store = new Map<string, string>();
	Object.assign(globalThis, {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
		},
	});
});

afterEach(() => {
	Object.assign(globalThis, { localStorage: realStorage });
});

describe("the alpha notice", () => {
	test("a browser with nothing remembered still shows it", () => {
		expect(readAlphaNoticeDismissed()).toBe(false);
	});

	test("closing it is remembered, and closing it twice changes nothing", () => {
		dismissAlphaNotice();
		expect(readAlphaNoticeDismissed()).toBe(true);
		dismissAlphaNotice();
		expect(readAlphaNoticeDismissed()).toBe(true);
	});

	test("a store that throws on read shows it", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => {
					throw new Error("Safari private mode");
				},
			},
		});
		expect(readAlphaNoticeDismissed()).toBe(false);
	});

	test("a store that throws on write does not throw out of the close", () => {
		Object.assign(globalThis, {
			localStorage: {
				setItem: () => {
					throw new Error("Safari private mode");
				},
			},
		});
		expect(() => dismissAlphaNotice()).not.toThrow();
	});

	test("a browser with no localStorage at all shows it", () => {
		Object.assign(globalThis, { localStorage: undefined });
		expect(readAlphaNoticeDismissed()).toBe(false);
	});
});
