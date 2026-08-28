// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The browser half of the Public Access meter — the pure parts.
//
// The hooks need a DOM and are covered by the e2e spec; what is testable here is the
// policy that decides *whether the meter speaks at all*.
//
// A second block covered an **anonymous tally** — a `localStorage` count of how long a
// logged-out visitor had watched, used to time a signup invitation. It went with the
// anonymous-viewing model on 2026-08-28: consuming a Work requires an account, so there is
// no anonymous playback left to count.
import { describe, expect, test } from "bun:test";
import { FREE_PUBLIC_ACCESS_SECONDS } from "@anthers/shared/public-access";
import {
	describeRemaining,
	LOW_BUDGET_SECONDS,
	type PublicAccessBudget,
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
