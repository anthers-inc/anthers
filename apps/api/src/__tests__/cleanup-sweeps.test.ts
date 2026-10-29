// SPDX-License-Identifier: Apache-2.0
/**
 * What the shared sweeps take back, asserted on the rows rather than on the intent.
 *
 * 🚨 **These exist because the sweeps looked complete and were not.** A full unit run on
 * 2026-10-29 left 698 `hosted_accounts` and 716 `hosted_identities` rows behind — an order
 * of magnitude more than everything else combined — while `purgeAccountIds` read as though
 * it handled the account and all its works. It did; the identity is not reachable the way
 * the works are, because `hosted_accounts.user_id` is `set null` and `hosted_identities`
 * has no user column at all. The same shape hid the operator's records: a hold and a DMCA
 * notice name an `admin_accounts` id, and the sweep was holding user ids.
 *
 * ⭐ **Asserted against the database rather than by reading the source**, unlike
 * `fixture-hygiene.test.ts`'s scan: the question here is whether the deletes actually reach
 * the rows, which only running them answers. `fixture-hygiene` answers the other question —
 * whether a suite calls a sweep at all.
 *
 * The sweeps are called directly, by id, rather than through their `afterAll` registrars,
 * because an assertion inside a file cannot run after that file's own teardown.
 */
import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { hostedAccounts, hostedIdentities, legalHolds, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { createAccount } from "./account-fixture.js";
import { createAdminFixture } from "./admin-fixture.js";
import {
	purgeAccountIds,
	purgeAccountsCreatedHere,
	purgeAdminAccountIds,
	purgeAdminAccountsCreatedHere,
} from "./cleanup.js";

// The standing contract every suite that makes accounts keeps, so a failure partway through
// the assertions above still takes its fixtures back; the explicit calls below are the
// subject, not a replacement for it.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

describe("the shared sweeps", () => {
	it("takes the hosted identity rows an account purge would otherwise strand", async () => {
		const account = await createAccount("purged-identity");

		// The link is only there before the purge, which is the whole difficulty: the sweep
		// has to read the DID while `user_id` still names the account.
		const [held] = await db
			.select({ did: hostedAccounts.did })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.userId, account.userId));
		expect(held?.did).toBe(account.did);

		await purgeAccountIds([account.userId]);

		const heldAfter = await db
			.select({ did: hostedAccounts.did })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, account.did));
		const watchedAfter = await db
			.select({ did: hostedIdentities.did })
			.from(hostedIdentities)
			.where(eq(hostedIdentities.did, account.did));
		const accountAfter = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, account.userId));

		expect(heldAfter).toEqual([]);
		expect(watchedAfter).toEqual([]);
		expect(accountAfter).toEqual([]);
	});

	it("takes the legal hold an operator placed, which the user sweep cannot reach", async () => {
		const admin = await createAdminFixture("purge-holds");
		const [hold] = await db
			.insert(legalHolds)
			.values({
				subjectType: "user",
				subjectId: 999_999,
				reason: "a fixture hold, placed so the purge has something to take",
				placedBy: admin.id,
			})
			.returning({ id: legalHolds.id });

		await purgeAdminAccountIds([admin.id]);

		const remaining = await db
			.select({ id: legalHolds.id })
			.from(legalHolds)
			.where(eq(legalHolds.id, hold?.id ?? -1));
		expect(remaining).toEqual([]);
	});
});
