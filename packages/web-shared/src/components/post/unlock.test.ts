// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `presentsAsLocked` — the difference between a Work that is gated and a Work that is
 * merely undeliverable to the person looking at it right now.
 *
 * 🚨 **The two stopped being the same question on 2026-08-28.** Consuming a Work requires
 * an account, so a signed-out visitor is refused the bytes of *free* work too. Every
 * surface that reads `!canAccess` as "locked" would then put a padlock and "members-only
 * work from this creator" on the entire Public Access commons — shown to precisely the
 * visitor the public page exists for. This is a pure function so that regression is
 * testable without rendering anything.
 */
import { describe, expect, test } from "bun:test";
import type { AccessResult } from "../../lib/types";
import { presentsAsLocked } from "./unlock";

function access(over: Partial<AccessResult>): AccessResult {
	return {
		canAccess: false,
		reason: "gated",
		isFree: false,
		requiresPurchase: false,
		price: null,
		isEntitled: false,
		streamEnabled: true,
		downloadEnabled: false,
		...over,
	} as AccessResult;
}

describe("presentsAsLocked", () => {
	test("a Work the viewer can open is never locked", () => {
		expect(presentsAsLocked(access({ canAccess: true, reason: "free", isFree: true }))).toBe(false);
		expect(presentsAsLocked(access({ canAccess: true, reason: "purchased" }))).toBe(false);
		expect(presentsAsLocked(access({ canAccess: true, reason: "owner" }))).toBe(false);
	});

	test("a creator gate is locked", () => {
		expect(presentsAsLocked(access({ reason: "gated" }))).toBe(true);
	});

	test("a price is locked", () => {
		expect(presentsAsLocked(access({ reason: "payment_required", requiresPurchase: true }))).toBe(
			true,
		);
	});

	test("🚨 free work refused only for want of an account is NOT locked", () => {
		// The whole point. The Work is free to everyone and stays free to everyone; what is
		// missing is an account for the time to be attributed to. `isFree` surviving the
		// refusal in `resolveAccessSync` is what makes this distinguishable at all.
		expect(presentsAsLocked(access({ reason: "login_required", isFree: true }))).toBe(false);
	});

	test("gated work a signed-out visitor met IS locked", () => {
		// Same reason code, opposite answer, and `isFree` is the only thing separating them.
		// A signed-out visitor meeting a creator's gate is looking at a real lock.
		expect(presentsAsLocked(access({ reason: "login_required", isFree: false }))).toBe(true);
	});

	test("no verdict yet is not a lock", () => {
		// A card whose access has not loaded must not flash a padlock at everybody.
		expect(presentsAsLocked(null)).toBe(false);
		expect(presentsAsLocked(undefined)).toBe(false);
	});

	test("a takedown, a quarantine and an adult gate are all locked", () => {
		// Everything that is not the account requirement stays on the locked branch — the
		// exception is narrow on purpose, and reads two fields rather than one.
		for (const reason of ["takedown", "quarantined", "adult_gated"] as const) {
			expect(presentsAsLocked(access({ reason })), reason).toBe(true);
		}
	});
});
