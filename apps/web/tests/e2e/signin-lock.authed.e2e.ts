// SPDX-License-Identifier: Apache-2.0
/**
 * The sign-in lock holds when two spec files sign in as the same account at once.
 *
 * Not a unit probe of the file lock (that is `src/signin-lock.test.ts`) but the failure
 * shape it exists to stop: two workers, one address, and the API's one-live-code rule in
 * the middle. Each file signs in back-to-back several times, which under the old harness
 * was enough for one worker's `start` to replace the code the other was still spending.
 * With the lock, both pass — and this failing again is the flake coming back, not a new bug.
 *
 * Runs in the `authed` project against the same session everything else uses.
 */

import { expect, signInAsMediaFixture, test } from "./fixtures";

test("back-to-back sign-ins A", async ({ context }) => {
	for (let i = 0; i < 5; i++) {
		const token = await signInAsMediaFixture(context);
		expect(token).toBeTruthy();
	}
});
