// SPDX-License-Identifier: Apache-2.0
//
// Which first-run state a new account lands in.
//
// 🚨 The consequential one is `supporting`: greeting somebody who has just paid with the
// free-tier message is the single worst outcome this page can produce, and it is exactly
// what a server-truth implementation would do — the amount is applied by a Stripe
// webhook, so an account that has just paid still reads `anthersSupport: 0` for a moment.
// Branching on what they *chose* is what avoids it, and these assertions are what stop
// somebody "fixing" it back to the server later.
import { beforeEach, describe, expect, test } from "bun:test";
import { readArrival } from "./FirstRun";

const PICKS_KEY = "anthers_signup_picks";

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
	(globalThis as { sessionStorage?: unknown }).sessionStorage = shim(session);
	(globalThis as { localStorage?: unknown }).localStorage = shim(local);
});

describe("someone who backed a creator or holds a paid Badge", () => {
	test("is `supporting` when they hold a paid Anthers Badge", () => {
		setPicks({ badge: "root", follow: [], badges: [] });
		expect(readArrival()).toEqual({ kind: "supporting", anthers: true, creators: 0 });
	});

	test("is `supporting` when they backed creators without an Anthers Badge", () => {
		setPicks({ badge: null, follow: ["a", "b"], badges: ["a", "b"] });
		expect(readArrival()).toEqual({ kind: "supporting", anthers: false, creators: 2 });
	});

	test("is `supporting` on either half, never demoted by the other being absent", () => {
		// The failure this guards: an `&&` where an `||` belongs would greet a creator-only
		// backer as a free account, moments after they paid.
		setPicks({ badge: "blossom", follow: [], badges: ["x"] });
		expect(readArrival().kind).toBe("supporting");
		setPicks({ badge: null, follow: [], badges: ["x"] });
		expect(readArrival().kind).toBe("supporting");
	});
});

describe("someone who took the free account", () => {
	test("is `free`, not `cold` — Free is a chosen rung, not an unanswered question", () => {
		// The distinction that matters: `cold` says "here's what supporting is", which to
		// somebody who declined ninety seconds ago is the second ask in two minutes.
		// Under the Badge model Free is the rung at $0 that they picked on the ladder.
		setPicks({ badge: "free", follow: [], badges: [] });
		expect(readArrival()).toEqual({ kind: "free", follows: 0 });
	});

	test("carries their follows, so the page can send them to a feed with something in it", () => {
		setPicks({ badge: "free", follow: ["a", "b", "c"], badges: [] });
		expect(readArrival()).toEqual({ kind: "free", follows: 3 });
	});

	test("an absent Badge is still not a paid one", () => {
		// A picks object written before the Badge pick existed carries no `badge` field, and
		// it must not round up into supporting.
		setPicks({ follow: [], badges: [] });
		expect(readArrival()).toEqual({ kind: "free", follows: 0 });
	});

	test("an unrecognized Badge name still means they picked a paid rung", () => {
		// The picks crossed a jsonb column; anything non-empty that is not "free" is a
		// chosen rung as far as the account that wrote it was concerned, and greeting a
		// payer as free is the exact failure `readArrival` exists to prevent.
		setPicks({ badge: "mystery", follow: [], badges: [] });
		expect(readArrival()).toEqual({ kind: "supporting", anthers: true, creators: 0 });
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
		(globalThis as { sessionStorage?: unknown }).sessionStorage = undefined;
		expect(readArrival()).toEqual({ kind: "cold" });
	});

	test("tolerates a picks object missing its arrays", () => {
		// Shape drift in sessionStorage must not throw on a page whose whole job is to be
		// the first thing a new account sees.
		setPicks({ badge: "free" });
		expect(readArrival()).toEqual({ kind: "free", follows: 0 });
	});
});
