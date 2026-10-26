// SPDX-License-Identifier: Apache-2.0
/**
 * Setting the password on an identity Anthers hosts, for an account that predates the password
 * being the person's.
 *
 * 🚨 **This module exists because of a migration, not because a password is Anthers' to manage.**
 * Every hosted account created before this change was handed a password nobody could type, so the
 * person could not use their identity anywhere but here — and the hub kept a copy to compensate.
 * The way out is the node's own emailed reset: the person proves control of the address on the
 * account, chooses a password, and from then on holds the credential themselves. Anthers keeps the
 * session that reset lets it open, never the password.
 *
 * ⚠️ **The address the reset goes to is the one Anthers knows.** For an identity Anthers created,
 * that is exactly the address the node was given at creation. For an identity moved onto the node,
 * the move used the address the person supplied, and their Anthers account normally carries the
 * same one; if it does not, the code goes to the wrong inbox and the person can reset at the
 * server's own account page instead. That is a limitation of not holding the credential, which is
 * the whole point of this module.
 *
 * ⚠️ **`resetPassword` revokes every password-derived refresh token for the account**, including
 * the hub's. The session is opened again with the password the person just chose, in the same
 * request, so the row never holds a dead one for long — and if the node will not answer twice, the
 * row is emptied rather than left claiming a session it does not have.
 */
import { db } from "@anthers/db";
import { hostedAccounts, users } from "@anthers/db/schema";
import { passwordProblem } from "@anthers/shared/passwords";
import { eq } from "drizzle-orm";
import { nodeCall } from "./hosted-node.js";
import { sealedSessionValue } from "./hosted-session-store.js";

export type PasswordRequestResult =
	| { status: "sent" }
	| { status: "refused"; fault: "account" | "operational"; message: string };

export type PasswordSetResult =
	| { status: "set"; sessionOpened: boolean }
	| { status: "refused"; fault: "account" | "token" | "password" | "operational"; message: string };

/** The hosted row and the address the reset should be mailed to, or a refusal. */
async function accountFor(
	userId: number,
): Promise<
	| { did: string; handle: string; email: string }
	| { status: "refused"; fault: "account"; message: string }
> {
	const [row] = await db
		.select({
			did: hostedAccounts.did,
			handle: hostedAccounts.handle,
			email: users.email,
		})
		.from(hostedAccounts)
		.innerJoin(users, eq(hostedAccounts.userId, users.id))
		.where(eq(hostedAccounts.userId, userId))
		.limit(1);
	if (!row?.email) {
		return {
			status: "refused",
			fault: "account",
			message:
				"This identity isn't hosted by Anthers. Set its password at the server that holds it.",
		};
	}
	return row;
}

/**
 * Ask the node to mail the account holder a reset token.
 *
 * ⚠️ **The node answers the same whether or not the address is on an account**, deliberately, so
 * this cannot tell the person their address is wrong — and it must not try. What it can say is
 * that the request was made, which is all the route needs to open the token field.
 */
export async function requestHostedPasswordReset(
	userId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<PasswordRequestResult> {
	const account = await accountFor(userId);
	if ("status" in account) return account;

	const asked = await nodeCall(
		"/xrpc/com.atproto.server.requestPasswordReset",
		{ method: "POST", body: JSON.stringify({ email: account.email }) },
		opts.fetchImpl ?? fetch,
	);
	if (!asked.ok) {
		return {
			status: "refused",
			fault: asked.retryable ? "operational" : "account",
			message: asked.retryable
				? "Anthers couldn't reach the identity server. Try again in a little while."
				: "The identity server wouldn't send a code for this account.",
		};
	}
	return { status: "sent" };
}

/**
 * Spend the mailed token and set the person's password.
 *
 * 🚨 **The password is validated here before the node sees it**, with the same shared rule the
 * signup form uses, so a value the node would accept but the product would not is still refused
 * before anything changes.
 */
export async function setHostedPassword(
	userId: number,
	input: { token: string; password: string },
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<PasswordSetResult> {
	const account = await accountFor(userId);
	if ("status" in account) return account;

	const problem = passwordProblem(input.password, {
		handle: account.handle,
		email: account.email,
	});
	if (problem) return { status: "refused", fault: "password", message: problem };

	const doFetch = opts.fetchImpl ?? fetch;
	const reset = await nodeCall(
		"/xrpc/com.atproto.server.resetPassword",
		{ method: "POST", body: JSON.stringify({ token: input.token, password: input.password }) },
		doFetch,
	);
	if (!reset.ok) {
		if (reset.retryable) {
			return {
				status: "refused",
				fault: "operational",
				message: "Anthers couldn't reach the identity server. Try again in a little while.",
			};
		}
		// The node's two named errors are the ordinary case: a code that expired between the mail
		// and the typing, or one that was never ours. Either way the answer is a new code.
		if (reset.error === "ExpiredToken" || reset.error === "InvalidToken") {
			return {
				status: "refused",
				fault: "token",
				message: "That code has expired or isn't the one we sent. Ask for a new one.",
			};
		}
		return {
			status: "refused",
			fault: "operational",
			message: reset.message || "The identity server wouldn't set that password.",
		};
	}

	// `resetPassword` revoked the old refresh tokens, so the stored session is dead a moment
	// before the replacement exists. Empty it first: a row claiming a session it no longer has
	// produces a retry that never succeeds, where an empty row produces a login.
	await db
		.update(hostedAccounts)
		.set({ sealedPassword: "", sealedSession: null })
		.where(eq(hostedAccounts.did, account.did));

	// Open the session the hub writes with. The person's password is in this request only; the
	// row keeps the rotating pair it answers with.
	const opened = await nodeCall(
		"/xrpc/com.atproto.server.createSession",
		{
			method: "POST",
			body: JSON.stringify({ identifier: account.did, password: input.password }),
		},
		doFetch,
	);
	const accessJwt = opened.ok ? (opened.body.accessJwt as string | undefined) : undefined;
	const refreshJwt = opened.ok ? (opened.body.refreshJwt as string | undefined) : undefined;
	if (!accessJwt || !refreshJwt) {
		// The password IS set — the person holds it and can sign in — so this is not a failure to
		// report as one. It is the hub's own access that is missing, and the next write says so.
		console.error(
			`[hosted-password] ${account.did}: password set, but no session could be opened ` +
				`(${opened.ok ? "the answer carried no tokens" : opened.error})`,
		);
		return { status: "set", sessionOpened: false };
	}
	await db
		.update(hostedAccounts)
		.set({ sealedSession: sealedSessionValue({ accessJwt, refreshJwt }) })
		.where(eq(hostedAccounts.did, account.did));
	return { status: "set", sessionOpened: true };
}
