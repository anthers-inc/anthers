// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which first-run state a new account lands in.
//
// 🚨 The consequential one is `supporting`: greeting somebody who has just paid with the
// free-tier message is the single worst outcome this page can produce, and it is exactly
// what a server-truth implementation would do — the Seed count is applied by a Stripe
// webhook, so an account that has just paid still reads `anthersSeeds: 0` for a moment.
// Branching on what they *chose* is what avoids it, and these assertions are what stop
// somebody "fixing" it back to the server later.
import { beforeEach, describe, expect, test } from "bun:test";
import { readArrival } from "./FirstRun";

const PICKS_KEY = "anthers_subscribe_picks";

function setPicks(picks: unknown) {
	localStorage.setItem("_", "_"); // touch, so a broken stub fails loudly rather than silently
	sessionStorage.setItem(PICKS_KEY, JSON.stringify(picks));
}

beforeEach(() => {
	const session = new Map<string, string>();
	const local = new Map<string, string>();
	const shim = (store: Map<string, string>) => ({
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
	});
	(globalThis as any).sessionStorage = shim(session);
	(globalThis as any).localStorage = shim(local);
});

describe("someone who gave Seeds", () => {
	test("is `supporting` when they gave Anthers a Seed", () => {
		setPicks({ anthers: true, follow: [], seed: [] });
		expect(readArrival()).toEqual({ kind: "supporting", anthers: true, creators: 0 });
	});

	test("is `supporting` when they backed creators without an Anthers Seed", () => {
		setPicks({ anthers: false, follow: ["a", "b"], seed: ["a", "b"] });
		expect(readArrival()).toEqual({ kind: "supporting", anthers: false, creators: 2 });
	});

	test("is `supporting` on either half, never demoted by the other being absent", () => {
		// The failure this guards: an `&&` where an `||` belongs would greet a creator-only
		// supporter as a free account, moments after they paid.
		setPicks({ anthers: true, follow: [], seed: ["x"] });
		expect(readArrival().kind).toBe("supporting");
		setPicks({ anthers: null, follow: [], seed: ["x"] });
		expect(readArrival().kind).toBe("supporting");
	});
});

describe("someone who took the free account", () => {
	test("is `free`, not `cold` — they were asked and said no", () => {
		// The distinction that matters: `cold` says "here's what a Seed is", which to
		// somebody who declined ninety seconds ago is the second ask in two minutes.
		setPicks({ anthers: false, follow: [], seed: [] });
		expect(readArrival()).toEqual({ kind: "free", follows: 0 });
	});

	test("carries their follows, so the page can send them to a feed with something in it", () => {
		setPicks({ anthers: false, follow: ["a", "b", "c"], seed: [] });
		expect(readArrival()).toEqual({ kind: "free", follows: 3 });
	});

	test("an unanswered Anthers question is still not a yes", () => {
		// `anthers: null` means "never answered" — distinct from `false`, and it must not
		// round up into supporting.
		setPicks({ anthers: null, follow: [], seed: [] });
		expect(readArrival().kind).toBe("free");
	});
});

describe("someone who came in cold", () => {
	test("is `cold` when there are no picks at all", () => {
		expect(readArrival()).toEqual({ kind: "cold" });
	});

	test("falls back to `cold` on unreadable picks rather than guessing", () => {
		sessionStorage.setItem(PICKS_KEY, "{not json");
		expect(readArrival()).toEqual({ kind: "cold" });
	});

	test("falls back to `cold` when storage is unavailable", () => {
		// A browser with storage disabled, and the classic signup page, both land here.
		(globalThis as any).sessionStorage = undefined;
		expect(readArrival()).toEqual({ kind: "cold" });
	});

	test("tolerates a picks object missing its arrays", () => {
		// Shape drift in sessionStorage must not throw on a page whose whole job is to be
		// the first thing a new account sees.
		setPicks({ anthers: false });
		expect(readArrival()).toEqual({ kind: "free", follows: 0 });
	});
});
