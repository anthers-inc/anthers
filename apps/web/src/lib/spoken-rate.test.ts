// SPDX-License-Identifier: Apache-2.0
//
// The remembered spoken rate: what a first-time listener starts at, what a stored one
// honors, and the change event that keeps the two surfaces in step.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readSpokenRate, SPOKEN_RATE_KEY, stepSpokenRate, writeSpokenRate } from "./spoken-rate";

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

describe("readSpokenRate", () => {
	test("nothing stored means normal speed, not a guess", () => {
		expect(readSpokenRate()).toBe(1);
	});

	test("a stored rate in the list is honored", () => {
		writeSpokenRate(1.5);
		expect(readSpokenRate()).toBe(1.5);
	});

	test("a stored rate outside the list falls back to normal", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => "3.5",
				setItem: () => {},
			},
		});
		expect(readSpokenRate()).toBe(1);
	});

	test("a store that throws reads as normal speed", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => {
					throw new Error("denied");
				},
			},
		});
		expect(readSpokenRate()).toBe(1);
	});
});

describe("writeSpokenRate", () => {
	test("still persists when the change-event window is absent (the test runner)", () => {
		writeSpokenRate(2);
		expect(readSpokenRate()).toBe(2);
	});

	test("still persists when the store refuses the write — the preference just isn't kept", () => {
		Object.assign(globalThis, {
			localStorage: {
				getItem: () => null,
				setItem: () => {
					throw new Error("QuotaExceededError");
				},
			},
		});
		expect(() => writeSpokenRate(0.75)).not.toThrow();
	});
});

describe("stepSpokenRate", () => {
	test("steps through the list and clamps at both ends", () => {
		expect(stepSpokenRate(1, 1)).toBe(1.25);
		expect(stepSpokenRate(1, -1)).toBe(0.75);
		expect(stepSpokenRate(0.5, -1)).toBe(0.5);
		expect(stepSpokenRate(2, 1)).toBe(2);
	});

	test("an unknown rate steps from normal rather than from wherever it landed", () => {
		expect(stepSpokenRate(1.1, 1)).toBe(1.25);
	});
});

test("the storage key is the documented one", () => {
	expect(SPOKEN_RATE_KEY).toBe("anthers_spoken_rate");
});
