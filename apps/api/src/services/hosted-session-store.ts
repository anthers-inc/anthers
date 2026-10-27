// SPDX-License-Identifier: Apache-2.0
/**
 * Remembering a hosted account's session, so the writer never needs a password to write.
 *
 * ⭐ **Why this module exists.** The reference PDS limits `com.atproto.server.createSession` to
 * thirty in five minutes and three hundred a day per account, and a busy user's pooled writes
 * (votes, comments, follows, posts) each opened a fresh login before this column existed — a user
 * could exhaust their OWN login budget doing nothing unusual. The writes themselves carry an
 * access token and are not the limited call, so the fix is to keep the session's
 * `accessJwt`/`refreshJwt` and renew it with `com.atproto.server.refreshSession`, which is
 * likewise unlimited.
 *
 * 🚨 **There is no login here any more, and that is the point of the design.** A hosted identity
 * gets its session when it is created and gets a new one when its holder signs in through the
 * identity server — so the store only ever reads, renews or clears what somebody else obtained.
 * When a refresh is refused there is nothing behind it, and the answer is `authorization_lost`:
 * the person signs in again. Nothing in the write path can open a session with a password, because
 * no password is stored.
 *
 * 🚨 **This module owns every value `hosted_accounts.sealed_session` holds after creation.** The
 * one write that does not pass through the store's own persist path is the insert in
 * `recordHostedIdentity`, which seals the session `createAccount` already answered with — and even
 * that uses `sealedSessionValue` here, so the value has one definition. The one-writer rule
 * (`hosted-accounts.ts` owns the rest of the row) is what keeps a second opinion about the column
 * from drifting — and this is a *store*, not a protocol client: it talks to the node through
 * `nodeCall` exactly like every other node conversation, so the failure shapes the writer already
 * maps (`node_unreachable` & friends) are the ones this hands back.
 *
 * ⚠️ **The refresh pair is ROTATED on every refresh — the stored refresh token is replaced by
 * the one the answer carries, never kept.** The node typically invalidates the refresh token
 * it just consumed, so persisting the old pair would leave the next open refreshing with a
 * token that is already dead.
 */
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { nodeCall } from "./hosted-node.js";
import { open, seal } from "./secret-box.js";

/**
 * A hosted account is handed an hour-scale access token, and a token too close to the wire is
 * worth less than a login: require this much life left before reusing one.
 */
const REUSE_MARGIN_MS = 60_000;
/** Fallback lifetime when an access token's `exp` cannot be read — short enough to be safe. */
const DEFAULT_LIFETIME_MS = 5 * 60_000;

/** The sealed value on `hosted_accounts.sealed_session`. */
interface StoredSession {
	accessJwt: string;
	refreshJwt: string;
	/** ms epoch at which the ACCESS token expires, decoded from the JWT itself. */
	expiresAt: number;
}

/** The pair a node answers with when it opens a session, or creates an account. */
export interface HostedSessionPair {
	accessJwt: string;
	refreshJwt: string;
}

/**
 * Seal a session pair for `hosted_accounts.sealed_session`.
 *
 * ⭐ **Exported so account creation can write the first value without a second round trip.**
 * `com.atproto.server.createAccount` answers with the session it just made, so the row can be
 * inserted holding it — no login, no password, and no window in which the identity exists with
 * no credential. The shape of the sealed value still lives here, which is what keeps the store
 * the authority on how the column is read.
 */
export function sealedSessionValue(pair: HostedSessionPair): string {
	const session: StoredSession = {
		accessJwt: pair.accessJwt,
		refreshJwt: pair.refreshJwt,
		expiresAt: expiryOf(pair.accessJwt) ?? Date.now() + DEFAULT_LIFETIME_MS,
	};
	return seal(JSON.stringify(session));
}

export type HostedSessionResult =
	| { token: string }
	/**
	 * `authorizationLost` is the difference between "the node is down" and "the node said this
	 * account cannot be reached with what we have". The second happens when the owner resets
	 * their password (which revokes every password-derived refresh token) or deactivates the
	 * account, and when there is no session on file at all. A caller must report it as an
	 * authorization problem rather than as an outage, or the failure reads as a retry that never
	 * succeeds.
	 *
	 * ⚠️ **A sealed value this deployment's key cannot open reports the same thing**, because
	 * there is nothing else it could be told apart from once the password fallback is gone: the
	 * row may no longer be opened and a person has to act. The identity card is where they do.
	 */
	| { token: null; error: string; authorizationLost?: true };

/**
 * The opens currently in flight, by DID, so concurrent callers share one login.
 *
 * Same shape as `learnedHandleDomains` in `hosted-accounts.ts`: the work is the promise, a
 * concurrent caller awaits the same one rather than starting its own, and the entry goes when
 * it settles. This is an in-process lock on purpose — the write worker's `localConcurrency`
 * is the only source of concurrency, and a cross-process lock is a DB problem this budget
 * does not have.
 */
const opensInFlight = new Map<string, Promise<HostedSessionResult>>();

/**
 * A usable access token for a hosted identity, spending no login unless one is owed.
 *
 * ⭐ **This is the only place in the hub that opens a hosted account's stored credential, and it
 * never hands one back.** A caller asks for a token and gets one or a reason; the sealed session
 * stays inside this module.
 *
 * Order of preference: the stored access token while it has life left (zero calls to the node),
 * then a refresh (zero logins). A refresh the node REFUSED — its considered 4xx — means the pair
 * is dead, and there is nothing behind it: the account was reset or deactivated at its server, or
 * the hub's authorization was withdrawn, and the person has to sign in again for the hub to hold
 * a session. A refresh that could not be ANSWERED (retryable: the node is down) is reported as a
 * failure rather than treated as a dead credential.
 */
export async function sessionForHostedAccount(
	did: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<HostedSessionResult> {
	const running = opensInFlight.get(did);
	if (running) return running;
	const opening = obtainSession(did, opts.fetchImpl ?? fetch);
	opensInFlight.set(did, opening);
	try {
		return await opening;
	} finally {
		opensInFlight.delete(did);
	}
}

/** Forget the session on file, so the next open logs in once rather than reusing a dead token. */
export async function clearHostedSession(did: string): Promise<void> {
	await db.update(hostedAccounts).set({ sealedSession: null }).where(eq(hostedAccounts.did, did));
}

/**
 * Read the row's session and open what is sealed in it.
 *
 * ⚠️ **A value this deployment's key cannot open reads as absent**, and that is deliberate: it is
 * the same state as a session the node revoked, the next write cannot tell them apart, and the
 * repair for both is the same — the person signs in again and the hub holds a fresh one. What
 * would be worse is a value that opens into something this module did not write, which the
 * parser below refuses by shape.
 */
async function readSession(did: string): Promise<StoredSession | null> {
	const [row] = await db
		.select({ sealedSession: hostedAccounts.sealedSession })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.did, did))
		.limit(1);
	if (!row?.sealedSession) return null;
	try {
		const parsed = JSON.parse(open(row.sealedSession)) as Partial<StoredSession>;
		if (typeof parsed.accessJwt !== "string") return null;
		return {
			accessJwt: parsed.accessJwt,
			refreshJwt: typeof parsed.refreshJwt === "string" ? parsed.refreshJwt : "",
			expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
		};
	} catch {
		return null;
	}
}

/** The body of one open; runs under the per-DID mutex above. */
async function obtainSession(did: string, doFetch: typeof fetch): Promise<HostedSessionResult> {
	const stored = await readSession(did);

	// 1. A live access token costs nothing at all.
	if (stored?.accessJwt && stored.expiresAt - Date.now() > REUSE_MARGIN_MS) {
		return { token: stored.accessJwt };
	}

	// 2. An expired (or expiring) access token with a refresh token: renew without a login.
	if (stored?.refreshJwt) {
		const refreshed = await nodeCall(
			"/xrpc/com.atproto.server.refreshSession",
			// 🚨 **No body: `refreshSession` is a procedure with no input, and the node refuses a
			// request that carries one** ("A request body was provided when none was expected"),
			// as a 4xx — which the code below would read as a revoked session. That made every
			// refresh look like a dead session and every write spend a login.
			{ method: "POST", token: stored.refreshJwt },
			doFetch,
		);
		if (refreshed.ok) {
			const persisted = await persist(did, refreshed.body);
			if (persisted) return persisted;
		} else if (refreshed.retryable) {
			// The node could not answer; it did NOT refuse. Logging in now would spend the
			// limited call to route around an outage — report the outage instead.
			return { token: null, error: `refreshSession: ${refreshed.error}` };
		}
		// A refused refresh (its considered 4xx) means the stored session is revoked. Drop it
		// and fall through to the one login a dead pair still owes.
		await clearHostedSession(did).catch(() => {});
	}

	// 3. Nothing was on file, or the node refused the pair: there is no second credential to
	// present. The session is the whole of what the hub holds, so this is the state a reset or a
	// deactivation at the server creates, and the state a person ends by signing in again.
	return { token: null, error: "authorization_lost", authorizationLost: true };
}

/**
 * Write down the session the node just answered with, returned as the token to use.
 *
 * `null` means the answer held no access token, which the caller reports as a failure rather
 * than reusing nothing. The sealed JSON persists the ROTATED pair: whatever access and
 * refresh tokens THIS answer carries, together.
 */
async function persist(
	did: string,
	body: Record<string, unknown>,
): Promise<{ token: string } | null> {
	const accessJwt = typeof body.accessJwt === "string" ? body.accessJwt : null;
	if (!accessJwt) return null;
	const refreshJwt = typeof body.refreshJwt === "string" ? body.refreshJwt : "";
	await db
		.update(hostedAccounts)
		.set({ sealedSession: sealedSessionValue({ accessJwt, refreshJwt }) })
		.where(eq(hostedAccounts.did, did));
	return { token: accessJwt };
}

/**
 * The access token's expiry, in ms epoch, decoded from the JWT payload's `exp` claim.
 *
 * `null` when the token is not a parseable JWT — the caller then stores it under the short
 * default lifetime rather than trusting a token it cannot read the clock on.
 */
function expiryOf(jwt: string): number | null {
	const parts = jwt.split(".");
	if (parts.length !== 3) return null;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
			exp?: unknown;
		};
		return typeof payload.exp === "number" ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}
