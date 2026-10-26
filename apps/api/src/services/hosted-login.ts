// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in to an identity Anthers hosts, with the password its holder chose.
 *
 * ⭐ **This is the first-party shape, and it is deliberately the one Bluesky's own client uses.**
 * The app is the PDS operator's client: the person types their password here, it goes to the
 * node's `createSession` in one request, and the session that answers is what the app keeps. There
 * is no second host and no consent screen for a relationship that is already first-party. The
 * password is never written down; the session is the client's credential, exactly as the official
 * app holds one.
 *
 * ⚠️ **An identity on somebody else's server does not come through here.** Anthers is a
 * third-party client of that server, so it uses OAuth (`routes/atproto.ts`) rather than asking for
 * a password it has no business holding. The split is the hosting relationship, not the shape of
 * the handle.
 *
 * 🚨 **The row keeps the session, and the session is the point.** A login replaces the sealed
 * session on `hosted_accounts`, which is what every writer and the recovery-key flow use. The
 * password itself is in this request and nowhere else.
 */
import { db } from "@anthers/db";
import { hostedAccounts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { nodeCall, pdsUrl } from "./hosted-node.js";
import { sealedSessionValue } from "./hosted-session-store.js";

export type HostedLoginResult =
	| { status: "ok"; user: typeof users.$inferSelect }
	/**
	 * `two-factor` is the node asking for the emailed confirmation code. It is not a failure: the
	 * password was right, and the caller shows a code field and sends it back as `authFactorToken`.
	 */
	| { status: "two-factor" }
	| {
			status: "refused";
			reason: "credentials" | "no_account" | "suspended" | "unreachable";
			message: string;
			suspendedUntil?: Date | null;
	  };

/**
 * Open a session on the node for this identifier and password, and keep it for the account.
 *
 * `identifier` is whatever the person typed: a handle or the address on the account. The node is
 * the authority on both, which is why no lookup happens here first — a lookup would answer whether
 * an account exists before a password was offered, and this keeps the answer behind the attempt.
 */
export async function loginHostedAccount(
	identifier: string,
	password: string,
	opts: { authFactorToken?: string; fetchImpl?: typeof fetch } = {},
): Promise<HostedLoginResult> {
	const answered = await nodeCall(
		"/xrpc/com.atproto.server.createSession",
		{
			method: "POST",
			body: JSON.stringify({
				identifier,
				password,
				...(opts.authFactorToken ? { authFactorToken: opts.authFactorToken } : {}),
			}),
		},
		opts.fetchImpl ?? fetch,
	);

	if (!answered.ok) {
		if (answered.error === "AuthFactorTokenRequired") return { status: "two-factor" };
		if (answered.retryable) {
			return {
				status: "refused",
				reason: "unreachable",
				message: "Anthers couldn't reach the identity server. Try again in a little while.",
			};
		}
		// 🚨 **One answer for a wrong password, an unknown identifier and a deactivated account**,
		// the same silence the node keeps. Telling them apart would turn this form into a directory
		// of who has an account.
		return {
			status: "refused",
			reason: "credentials",
			message: "That handle or password didn't work.",
		};
	}

	const did = typeof answered.body.did === "string" ? answered.body.did : "";
	const accessJwt = typeof answered.body.accessJwt === "string" ? answered.body.accessJwt : "";
	const refreshJwt = typeof answered.body.refreshJwt === "string" ? answered.body.refreshJwt : "";
	if (!did || !accessJwt || !refreshJwt) {
		return {
			status: "refused",
			reason: "unreachable",
			message: "The identity server answered without a session. Try again in a little while.",
		};
	}

	const [user] = await db.select().from(users).where(eq(users.atprotoDid, did)).limit(1);
	if (!user) {
		// The identity is real and the password was right, but no Anthers account is attached to
		// it. The person can sign up with it; there is nothing here to sign in to.
		return {
			status: "refused",
			reason: "no_account",
			message: "That identity doesn't have an Anthers account yet.",
		};
	}
	if (user.suspendedAt) {
		return {
			status: "refused",
			reason: "suspended",
			message: "This account is suspended.",
			suspendedUntil: user.suspendedUntil,
		};
	}

	const handle =
		typeof answered.body.handle === "string" ? answered.body.handle : user.atprotoHandle;
	const node = pdsUrl();

	// ⭐ **The row is upserted, not merely updated.** A moved-in identity can be on the node with
	// no `hosted_accounts` row, and its holder signing in is the truest proof that the row belongs
	// to them. Without this, their first login would work for the app and leave every writer
	// unable to open a session.
	await db
		.insert(hostedAccounts)
		.values({
			did,
			userId: user.id,
			handle,
			sealedPassword: "",
			sealedSession: sealedSessionValue({ accessJwt, refreshJwt }),
		})
		.onConflictDoUpdate({
			target: hostedAccounts.did,
			set: {
				userId: user.id,
				handle,
				sealedPassword: "",
				sealedSession: sealedSessionValue({ accessJwt, refreshJwt }),
			},
		});

	// The node's answer is the current truth about the handle and the host, and a login is a
	// natural moment to correct a row that has moved since it was written.
	const [fresh] = await db
		.update(users)
		.set({ atprotoHandle: handle, ...(node ? { atprotoPdsUrl: node } : {}) })
		.where(eq(users.id, user.id))
		.returning();

	return { status: "ok", user: fresh ?? user };
}
