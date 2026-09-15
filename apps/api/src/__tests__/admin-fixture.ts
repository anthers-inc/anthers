// SPDX-License-Identifier: Apache-2.0
/**
 * An admin account, and a cookie that signs a request in as it, for a suite that exercises the admin
 * routes or a service an operator acts through.
 *
 * The account is made through `services/admin-accounts.ts` and the session through the same
 * `createAdminSession` sign-in uses, so a suite tests the real gate rather than a stand-in for it.
 * Signing in by emailed code is `admin-auth.test.ts`'s subject; everything else starts signed in.
 *
 * 🚨 **A suite that calls this must call `purgeAdminAccountsCreatedHere()` at its top level**, the
 * same rule `purgeAccountsCreatedHere()` enforces for Anthers accounts, and `fixture-hygiene.test.ts`
 * refuses a suite that does not.
 *
 * ⚠️ **The cookie works only on a request the admin routes accept**: to a host `isAdminHost` allows
 * (any host, in a test run with no `ADMIN_URL`), from an origin `isAdminOrigin` allows when it
 * changes something (`http://localhost:3000` passes there), and with no `Authorization` header.
 */
import { createAdminAccount, createAdminSession } from "../services/admin-accounts.js";

export interface AdminFixture {
	id: number;
	email: string;
	displayName: string;
	/** A `Cookie` header value signing a request in as this account. */
	cookie: string;
}

export async function createAdminFixture(
	label: string,
	opts: { isSuperAdmin?: boolean } = {},
): Promise<AdminFixture> {
	const suffix = crypto.randomUUID().slice(0, 8);
	const account = await createAdminAccount(
		{
			email: `${label}-${suffix}@example.invalid`,
			displayName: `${label} ${suffix}`,
			isSuperAdmin: opts.isSuperAdmin ?? false,
		},
		null,
	);
	const token = await createAdminSession(account.id);
	return {
		id: account.id,
		email: account.email,
		displayName: account.displayName,
		cookie: `__Host-admin_session=${token}`,
	};
}
