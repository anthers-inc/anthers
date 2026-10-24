// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { verifiedCreator } from "./verified-creator";

/**
 * The truth table behind `verifiedCreator`. The database half — what "released" means — is
 * `apps/api/src/__tests__/verified-creator.test.ts`'s, because it needs real rows.
 */
describe("verifiedCreator", () => {
	it("is false for an account that never turned creator mode on, whatever it has released", () => {
		expect(verifiedCreator({ isCreator: false, releasedWorkCount: 0 })).toBe(false);
		expect(verifiedCreator({ isCreator: false, releasedWorkCount: 3 })).toBe(false);
		expect(verifiedCreator({ isCreator: null, releasedWorkCount: 3 })).toBe(false);
	});

	it("is false for a creator who has released nothing", () => {
		expect(verifiedCreator({ isCreator: true, releasedWorkCount: 0 })).toBe(false);
	});

	it("is true for a creator with one released Work", () => {
		expect(verifiedCreator({ isCreator: true, releasedWorkCount: 1 })).toBe(true);
	});

	it("is true for a creator with several released Works", () => {
		expect(verifiedCreator({ isCreator: true, releasedWorkCount: 7 })).toBe(true);
	});
});
