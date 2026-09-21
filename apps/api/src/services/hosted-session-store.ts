// SPDX-License-Identifier: Apache-2.0
/**
 * Remembering a hosted account's session so the writer does not log in again for every write.
 *
 * ⭐ **Why this module exists.** The reference PDS limits `com.atproto.server.createSession`
 * to thirty in five minutes and three hundred a day per account, and a busy reader's pooled
 * writes (votes, comments, follows, posts) each opened a fresh login before this column
 * existed — a reader could exhaust their OWN login budget doing nothing unusual. The writes
 * themselves carry an access token and are not the limited call, so the fix is to keep the
 * first session's `accessJwt`/`refreshJwt` and renew it with
 * `com.atproto.server.refreshSession`, which is likewise unlimited. A fresh `createSession`
 * now happens only when there is no session on file or the node has refused the refresh.
 *
 * 🚨 **This module is the ONLY writer of `hosted_accounts.sealed_session`.** The one-writer
 * rule (`hosted-accounts.ts` owns the rest of the row) is what keeps a second opinion about
 * the column from drifting — and it is a *store*, not a protocol client: it talks to the node
 * through `nodeCall` exactly like every other node conversation, so the failure shapes the
 * writer already maps (`node_unreachable` & friends) are the ones this hands back.
 *
 * ⚠️ **The refresh pair is ROTATED on every refresh — the stored refresh token is replaced by
 * the one the answer carries, never kept.** The node typically invalidates the refresh token
 * it just consumed, so persisting the old pair would leave the next open refreshing with a
 * token that is already dead.
 */
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { nodeCall } from "./hosted-accounts.js";
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

export type HostedSessionResult = { token: string } | { token: null; error: string };

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
 * Order of preference: the stored access token while it has life left (zero calls to the
 * node), then a refresh (zero logins), then one `createSession`. A refresh the node REFUSED —
 * its considered 4xx — falls through to the login, because the stored pair is dead and a
 * fresh session is the only door left. A refresh that could not be ANSWERED (retryable: the
 * node is down) is reported as a failure rather than silently logged in around, because
 * around it is the budget this exists to protect.
 */
export async function sessionForHostedAccount(
	did: string,
	password: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<HostedSessionResult> {
	const running = opensInFlight.get(did);
	if (running) return running;
	const opening = obtainSession(did, password, opts.fetchImpl ?? fetch);
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

/** The body of one open; runs under the per-DID mutex above. */
async function obtainSession(
	did: string,
	password: string,
	doFetch: typeof fetch,
): Promise<HostedSessionResult> {
	const stored = await readStored(did);

	// 1. A live access token costs nothing at all.
	if (stored?.accessJwt && stored.expiresAt - Date.now() > REUSE_MARGIN_MS) {
		return { token: stored.accessJwt };
	}

	// 2. An expired (or expiring) access token with a refresh token: renew without a login.
	if (stored?.refreshJwt) {
		const refreshed = await nodeCall(
			"/xrpc/com.atproto.server.refreshSession",
			{ method: "POST", token: stored.refreshJwt, body: "{}" },
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

	// 3. No session on file, or a dead one: the single login this design exists to spend.
	const session = await nodeCall(
		"/xrpc/com.atproto.server.createSession",
		{ method: "POST", body: JSON.stringify({ identifier: did, password }) },
		doFetch,
	);
	if (!session.ok) return { token: null, error: `createSession: ${session.error}` };
	const persisted = await persist(did, session.body);
	if (persisted) return persisted;
	return { token: null, error: "createSession answered with no access token" };
}

/** Read and open the stored session. Anything that will not open reads as no session. */
async function readStored(did: string): Promise<StoredSession | null> {
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
		// Sealed under another key, or a value this module never wrote — treat as absent. The
		// login below replaces it, so one bad value costs exactly one login.
		return null;
	}
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
	const session: StoredSession = {
		accessJwt,
		refreshJwt,
		expiresAt: expiryOf(accessJwt) ?? Date.now() + DEFAULT_LIFETIME_MS,
	};
	await db
		.update(hostedAccounts)
		.set({ sealedSession: seal(JSON.stringify(session)) })
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
