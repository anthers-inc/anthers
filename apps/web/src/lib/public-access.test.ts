// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The browser half of the Public Access meter — the pure parts.
//
// The hooks need a DOM and are covered by the e2e spec; what is testable here is the
// policy that decides *whether the meter speaks at all*, plus the anonymous tally, which
// is the piece most likely to be mistaken for a budget by someone reading it later.
import { beforeEach, describe, expect, test } from "bun:test";
import { FREE_PUBLIC_ACCESS_SECONDS } from "@anthers/shared/public-access";
import {
	ANON_PROMPT_SECONDS,
	clearAnonymousSeconds,
	describeRemaining,
	LOW_BUDGET_SECONDS,
	type PublicAccessBudget,
	readAnonymousSeconds,
	recordAnonymousSeconds,
	shouldWarn,
} from "./public-access";

const HOUR = 3600;

/** A limited viewer with `remaining` seconds left. */
function limited(remaining: number): PublicAccessBudget {
	return {
		unlimited: false,
		usedSeconds: FREE_PUBLIC_ACCESS_SECONDS - remaining,
		limitSeconds: FREE_PUBLIC_ACCESS_SECONDS,
		remainingSeconds: remaining,
		allowed: remaining > 0,
	};
}

const UNLIMITED: PublicAccessBudget = {
	unlimited: true,
	usedSeconds: 500 * HOUR,
	limitSeconds: null,
	remainingSeconds: null,
	allowed: true,
};

describe("when the meter speaks", () => {
	test("says nothing for most of the month", () => {
		// The point of "free forever" is that it should not feel counted. A meter on
		// screen all month turns a generous allowance into a running tally.
		expect(shouldWarn(limited(9 * HOUR))).toBe(false);
		expect(shouldWarn(limited(LOW_BUDGET_SECONDS + 1))).toBe(false);
	});

	test("speaks inside the last hour", () => {
		expect(shouldWarn(limited(LOW_BUDGET_SECONDS))).toBe(true);
		expect(shouldWarn(limited(5 * 60))).toBe(true);
		expect(shouldWarn(limited(0))).toBe(true);
	});

	test("never speaks to someone who has unlimited access", () => {
		// 🚨 The central claim of the model: the Public Access price removes the limit, and
		// nothing above it buys more. A countdown shown to such a viewer would be stating a
		// limit that does not exist.
		expect(shouldWarn(UNLIMITED)).toBe(false);
	});

	test("treats `unlimited` as authoritative even if a remainder comes with it", () => {
		/*
		 * 🚨 This test exists because sabotage found the one above proving nothing.
		 *
		 * The server's unlimited budget carries `remainingSeconds: null`, so the null
		 * check alone already suppresses the warning — meaning the `unlimited` guard
		 * could be deleted and every other assertion here would still pass. That is a
		 * guard nobody is holding.
		 *
		 * This shape is one the API does not currently produce, and that is the point: it
		 * is what the guard is *for*. Anything that later returns a countdown alongside
		 * `unlimited` — a caching layer, a future partial allowance — must not start
		 * telling Seed-holders they are running out.
		 */
		expect(shouldWarn({ ...UNLIMITED, remainingSeconds: 60 })).toBe(false);
	});

	test("never speaks before the budget is known", () => {
		// Null is "not loaded yet" as well as "not applicable". Warning on either would
		// flash a limit at someone who may not have one.
		expect(shouldWarn(null)).toBe(false);
	});
});

describe("describeRemaining", () => {
	test("reads the way a person would say it", () => {
		expect(describeRemaining(2 * HOUR)).toBe("2 hours");
		expect(describeRemaining(HOUR)).toBe("1 hour");
		expect(describeRemaining(90 * 60)).toBe("1 hr 30 min");
		expect(describeRemaining(5 * 60)).toBe("5 minutes");
		expect(describeRemaining(60)).toBe("1 minute");
	});

	test("never reports a negative remainder", () => {
		// Overspend is real — a batch can land while the last of the budget is in flight
		// — and "-3 minutes left" is a worse thing to render than zero.
		expect(describeRemaining(-500)).toBe("0 minutes");
	});

	test("floors rather than rounds up", () => {
		// Telling someone they have a minute left when they have eleven seconds is the
		// direction that gets the player cut off mid-sentence.
		expect(describeRemaining(119)).toBe("1 minute");
	});
});

describe("the anonymous tally", () => {
	/**
	 * Bun's test runtime has no DOM, so `localStorage` is genuinely absent here — which
	 * is the same condition as a browser with storage disabled. Stubbing it makes the
	 * ordinary path testable; the un-stubbed case is asserted on its own below, because
	 * "storage is off" is a real state a reader can be in and the tally has to survive it.
	 */
	beforeEach(() => {
		const store = new Map<string, string>();
		(globalThis as any).localStorage = {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
		};
		clearAnonymousSeconds();
	});

	test("accumulates and survives a read", () => {
		recordAnonymousSeconds(60);
		recordAnonymousSeconds(30);
		expect(readAnonymousSeconds()).toBe(90);
	});

	test("ignores non-positive ticks", () => {
		recordAnonymousSeconds(10);
		recordAnonymousSeconds(0);
		recordAnonymousSeconds(-5);
		expect(readAnonymousSeconds()).toBe(10);
	});

	test("clears completely", () => {
		recordAnonymousSeconds(600);
		clearAnonymousSeconds();
		expect(readAnonymousSeconds()).toBe(0);
	});

	/**
	 * 🚨 The distinction this whole file exists to keep straight.
	 *
	 * The tally is **not a budget**. A logged-out viewer is not metered at all — the
	 * server hands them the full allowance every time, deliberately, because anonymous
	 * streaming of the commons is the shop window. This number only decides when to
	 * mention that accounts exist, and it is trivially resettable, which is fine because
	 * nothing is enforced with it.
	 */
	test("crosses the prompt mark well short of the free allowance", () => {
		expect(ANON_PROMPT_SECONDS).toBeLessThan(FREE_PUBLIC_ACCESS_SECONDS);
		// Half an hour of watching is an invitation; ten hours would be a limit, and an
		// anonymous viewer has none.
		expect(ANON_PROMPT_SECONDS).toBe(30 * 60);
	});

	test("degrades to silence when storage is unavailable, rather than throwing", () => {
		// A browser with storage disabled must still play video. The prompt simply never
		// fires, which is the safe direction to fail in — an un-prompted viewer loses
		// nothing, while an exception here would take the player down with it.
		(globalThis as any).localStorage = undefined;
		expect(() => recordAnonymousSeconds(60)).not.toThrow();
		expect(() => clearAnonymousSeconds()).not.toThrow();
		expect(readAnonymousSeconds()).toBe(0);
	});
});
