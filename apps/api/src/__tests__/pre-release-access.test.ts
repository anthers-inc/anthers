// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-release state in the one resolver every delivery door reads.
 *
 * The page being public is `workReachability`'s side; this pins that the WORK stays closed:
 * a pre-release Work resolves to `canAccess: false, reason: "pre_release"` for everyone but
 * its creator, whatever the eventual access is. The eventual verdict (`isFree`, `price`)
 * survives on the answer because the coming-soon card states it.
 */
import { describe, expect, it } from "bun:test";
import { NO_PARENTAL_CONTROLS } from "@anthers/shared/parental-controls";
import { type AccessContext, resolveAccessSync } from "../services/access.js";

const DAY = 24 * 60 * 60 * 1000;

const PRE_RELEASE_WORK = {
	id: 1,
	creatorId: 42,
	type: "game",
	title: "Coming soon",
	visibility: "private",
	releasedAt: null,
	preReleaseAt: new Date(Date.now() - DAY),
	takedownStatus: "active",
	quarantineStatus: "none",
	maturity: "general",
	streamEnabled: true,
	downloadEnabled: true,
	access: [{ threshold: 0, allow: true, price: "0" }],
} as never;

function context(overrides: Partial<AccessContext> = {}): AccessContext {
	return {
		userId: 99,
		supportByCreator: new Map(),
		purchasedWorkIds: new Set(),
		adultAccess: true,
		sharedBy: null,
		parental: NO_PARENTAL_CONTROLS,
		...overrides,
	};
}

describe("a pre-release Work", () => {
	it("closes delivery for a visitor while keeping the eventual verdict", () => {
		const result = resolveAccessSync(PRE_RELEASE_WORK, context());
		expect(result.canAccess).toBe(false);
		expect(result.reason).toBe("pre_release");
		// The page's card can still say the Work will be free.
		expect(result.isFree).toBe(true);
	});

	it("keeps the creator's own access, exactly as every other state does", () => {
		const result = resolveAccessSync(PRE_RELEASE_WORK, context({ userId: 42 }));
		expect(result.canAccess).toBe(true);
		expect(result.reason).toBe("owner");
	});

	it("does not open before its date", () => {
		const future = {
			...(PRE_RELEASE_WORK as Record<string, unknown>),
			preReleaseAt: new Date(Date.now() + DAY),
		} as never;
		expect(resolveAccessSync(future, context()).reason).toBe("free");
	});

	it("does not hide a hard denial behind the coming-soon reason", () => {
		const quarantined = {
			...(PRE_RELEASE_WORK as Record<string, unknown>),
			quarantineStatus: "quarantined",
		} as never;
		expect(resolveAccessSync(quarantined, context()).reason).toBe("quarantined");
	});

	it("reports the eventual access to the listing even while pre-release", () => {
		const result = resolveAccessSync(PRE_RELEASE_WORK, context({ ignorePreRelease: true }));
		expect(result.canAccess).toBe(true);
		expect(result.reason).toBe("free");
	});
});
