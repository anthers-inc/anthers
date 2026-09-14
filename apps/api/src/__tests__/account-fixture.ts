// SPDX-License-Identifier: Apache-2.0
/**
 * A signed-in fixture account, made without the signup ceremony.
 *
 * Signing up is a ceremony with an emailed code, and no suite can read that email, so a suite
 * that needs somebody signed in writes the account and its session directly. This replaced a
 * password sign-up route that existed only for tests and that skipped the emailed code in
 * production as well.
 *
 * ⚠️ **What the ceremony does and this does not**: no address is proved, `email_verified`
 * stays false, no handle is claimed through `/welcome`, and no welcome email is sent. A suite
 * testing any of those drives the ceremony routes themselves rather than this.
 *
 * The account gets a password, so a suite can still exercise `POST /api/auth/sign-in`, and a
 * placeholder DID from `fixtureDid()`, because every account holds an identity and a fixture
 * has no real one to hold. Nothing may resolve or publish to it.
 */

import { db } from "@anthers/db/client";
import { fixtureDid } from "@anthers/db/fixture-did";
import { users } from "@anthers/db/schema";
import { createSession, hashPassword } from "../services/auth";

/** The password every fixture account is given unless a suite asks for another. */
export const FIXTURE_PASSWORD = "testpass123";

export interface FixtureAccount {
	/** `session=<token>`, ready for a `Cookie` header. */
	cookie: string;
	/** The session token alone, for a suite that sends it as a bearer token. */
	token: string;
	userId: number;
	username: string | null;
	email: string;
}

/**
 * Create an account with a live session.
 *
 * The email defaults to `<username>@example.com`, which is what the suites used when they
 * signed up through HTTP, so a suite that already deletes by that address keeps working.
 *
 * Pass `null` for an account that has not claimed a handle yet — the state the ceremony leaves
 * somebody in until `/welcome` — so a suite can drive the claim, and the terms acceptance that
 * rides on it, through the real route.
 */
export async function createAccount(
	username: string | null,
	opts: { email?: string; password?: string } = {},
): Promise<FixtureAccount> {
	const email =
		opts.email ?? `${username ?? `unclaimed_${crypto.randomUUID().slice(0, 8)}`}@example.com`;
	const passwordHash = await hashPassword(opts.password ?? FIXTURE_PASSWORD);
	const [user] = await db
		.insert(users)
		.values({ username, email, passwordHash, atprotoDid: fixtureDid() })
		.returning();
	const token = await createSession(user.id);
	return { cookie: `session=${token}`, token, userId: user.id, username, email };
}
