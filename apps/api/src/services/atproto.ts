// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ATProto identity as it touches Anthers accounts.
 *
 * The OAuth protocol machinery lives in `atproto-client.ts` and comes from the official
 * SDK. What remains here is the part that is genuinely ours: mapping a DID to an Anthers
 * account, and the rules about when that mapping may be created, changed or removed.
 *
 * This file used to be 605 lines, most of it a hand-rolled implementation of DPoP, PKCE,
 * PAR, handle resolution and DID resolution. All of that is now the SDK's.
 */
import { db } from "@anthers/db";
import { atprotoPendingSignups, atprotoSessions, users } from "@anthers/db/schema";
import { extractPdsUrl } from "@atproto/oauth-client";
import { eq, lt } from "drizzle-orm";
import { getAtprotoClient } from "./atproto-client.js";

export interface AtprotoIdentity {
	did: string;
	handle: string;
	pdsUrl: string;
}

/**
 * Resolve a DID (or handle) to the identity fields Anthers stores. Used after the OAuth
 * callback, which hands back only a DID.
 *
 * The handle is a *claim* the DID document makes and the SDK verifies bidirectionally
 * during resolution, so it is safe to store — but it changes over time, which is why the
 * DID and not the handle is the identity column.
 */
export async function resolveIdentity(didOrHandle: string): Promise<AtprotoIdentity> {
	const resolved = await getAtprotoClient().identityResolver.resolve(didOrHandle);
	return {
		did: resolved.did,
		// ⚠️ The resolver returns the literal `handle.invalid` when the handle does not
		// resolve back to the same DID — an unverified claim, not a handle. Storing it would
		// put a fake domain on the profile and in every `@mention` we ever render, so it is
		// treated as absent. The DID is unaffected and remains the identity.
		handle: resolved.handle === HANDLE_INVALID ? "" : resolved.handle,
		pdsUrl: pdsUrlOf(resolved.didDoc),
	};
}

/** The resolver's sentinel for a handle that failed bidirectional verification. */
const HANDLE_INVALID = "handle.invalid";

/**
 * ⚠️ `extractPdsUrl` THROWS on a document with no `#atproto_pds` service; it does not
 * return undefined. A DID that resolves but hosts no repository is a real state — a
 * deactivated or mid-migration account — and letting it throw would turn "this account has
 * no PDS right now" into a failed sign-in.
 */
function pdsUrlOf(didDoc: Parameters<typeof extractPdsUrl>[0]): string {
	try {
		return extractPdsUrl(didDoc).toString();
	} catch {
		return "";
	}
}

/** Fetch a user's Bluesky profile (public, no auth needed). Best-effort decoration only. */
export async function getBlueskyProfile(
	did: string,
): Promise<{ displayName?: string; avatar?: string }> {
	try {
		const res = await fetch(
			`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
		);
		if (res.ok) {
			const data = (await res.json()) as { displayName?: string; avatar?: string };
			return { displayName: data.displayName, avatar: data.avatar };
		}
	} catch {
		// Non-fatal: a missing profile must never fail a sign-in.
	}
	return {};
}

// ─── ATProto ↔ Anthers account mapping ───────────────────────────────────────

/**
 * The domain the old ATProto placeholder address sat on.
 *
 * `.invalid` is reserved by RFC 2606 precisely so that it can never resolve, which made
 * the placeholder honest: it was not a mailbox we failed to reach, it was a mailbox that
 * could not exist.
 *
 * ⚠️ **Nothing writes one any more** — the ceremony below never creates an account without
 * a real address. It is still read, because rows created before the ceremony existed are
 * still rows, and the unlink guard has to keep recognising them.
 */
const PLACEHOLDER_EMAIL_DOMAIN = "atproto.invalid";

/** Whether an account has an address a sign-in code could actually arrive at. */
export function hasReachableEmail(email: string | null | undefined): boolean {
	return !!email && !email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** Whether ATProto signup is open. Off unless explicitly and exactly enabled. */
export function atprotoSignupEnabled(): boolean {
	return process.env.ATPROTO_SIGNUP_ENABLED === "true";
}

/**
 * Create an Anthers account from an ATProto identity and a **confirmed** address.
 *
 * 🚨 **`username` is deliberately null, and that is the whole ceremony in one field.** An
 * account with no handle is `needsOnboarding`, which routes to `/welcome` — the only place
 * that presents the terms and takes the 13+ assertion. An earlier version of this function
 * generated a username from the Bluesky handle, which silently skipped onboarding and
 * therefore skipped the terms: the account looked complete and had agreed to nothing. The
 * emailed-code ceremony has always left `username` null for exactly this reason.
 *
 * 🚨 **The address is a parameter rather than something derived here, because there is no
 * honest way to derive one.** Callers get it from the PDS and only get this far when it is
 * both present and confirmed; every other case goes through `startPendingSignup` and the
 * ordinary emailed-code ceremony instead. Anthers never creates an account it cannot mail:
 * receipts, payout notices, tax documents, chargebacks, DMCA counter-notices and rights
 * requests all require reaching a person rather than authenticating one.
 */
export async function createAccountFromAtproto(args: {
	identity: AtprotoIdentity;
	email: string;
	displayName?: string;
}): Promise<{ user?: typeof users.$inferSelect; error?: string }> {
	if (!atprotoSignupEnabled()) {
		return { error: "signup_disabled" };
	}
	const [taken] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, args.email))
		.limit(1);
	// Callers check this before deciding to come here, so reaching it means two requests
	// raced. Refusing is right either way: the remedy is the emailed code, which proves the
	// address belongs to whoever is asking rather than to whoever the PDS says.
	if (taken) return { error: "email_has_account" };

	const [user] = await db
		.insert(users)
		.values({
			email: args.email,
			// The PDS confirmed this address, so a second confirmation asks somebody to prove
			// the same fact twice — which is how a flow teaches people to ignore it.
			emailVerified: true,
			atprotoDid: args.identity.did,
			atprotoHandle: args.identity.handle,
			atprotoPdsUrl: args.identity.pdsUrl,
			displayName: args.displayName ?? "",
		})
		.returning();
	return { user };
}

/** Find the Anthers account already bound to a DID, refreshing its handle and PDS. */
export async function findUserByAtprotoDid(
	identity: AtprotoIdentity,
	displayName?: string,
): Promise<typeof users.$inferSelect | undefined> {
	const [existing] = await db
		.select()
		.from(users)
		.where(eq(users.atprotoDid, identity.did))
		.limit(1);
	if (!existing) return undefined;

	// A handle can change under a stable DID, so reconcile rather than skip — the same
	// argument the dev-account bootstrap makes for reconciling instead of create-if-missing.
	const updates: Record<string, string> = {};
	if (existing.atprotoHandle !== identity.handle) updates.atprotoHandle = identity.handle;
	if (existing.atprotoPdsUrl !== identity.pdsUrl) updates.atprotoPdsUrl = identity.pdsUrl;
	if (displayName && !existing.displayName) updates.displayName = displayName;
	if (Object.keys(updates).length > 0) {
		await db.update(users).set(updates).where(eq(users.id, existing.id));
	}
	return { ...existing, ...updates };
}

// ─── Reading the address the PDS holds ───────────────────────────────────────

/** What the PDS says about this account's email, and whether it was willing to say. */
export interface PdsEmail {
	/** The address, if the scope was granted and the PDS holds one. */
	email?: string;
	/** Whether the **PDS** has verified it. Anthers only skips its own check when true. */
	confirmed: boolean;
	/** Whether `transition:email` was actually granted, as opposed to merely requested. */
	scopeGranted: boolean;
}

/**
 * Ask the PDS for the account's email address.
 *
 * ⭐ **The granted scope is read from the token rather than assumed from the request**, and
 * that is what makes the fallback real rather than theoretical. `getTokenInfo().scope`
 * carries what the authorization server actually issued, so an authorization screen that
 * lets someone decline `transition:email` — which nobody has yet confirmed bsky.social
 * does, one way or the other — produces a detectable refusal instead of a confusing 400.
 *
 * ⚠️ **This is a read at a moment, not a subscription.** An address changed at the PDS
 * afterwards never reaches us, so nothing may treat the stored copy as permanently
 * authoritative — it is a starting value that the account owns from then on.
 *
 * Every failure is soft. A PDS that is down, a scope that was refused and an account with
 * no address on file all mean the same thing to the caller: ask for an address the ordinary
 * way. There is no failure here worth turning into an error page.
 */
export async function readPdsEmail(session: {
	getTokenInfo: () => Promise<{ scope?: string }>;
	fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>;
}): Promise<PdsEmail> {
	try {
		const { scope } = await session.getTokenInfo();
		const scopeGranted = (scope ?? "").split(/\s+/).includes(EMAIL_SCOPE);
		if (!scopeGranted) return { confirmed: false, scopeGranted: false };

		const res = await session.fetchHandler("/xrpc/com.atproto.server.getSession");
		if (!res.ok) return { confirmed: false, scopeGranted: true };

		const body = (await res.json()) as { email?: string; emailConfirmed?: boolean };
		return {
			email: body.email?.trim() || undefined,
			confirmed: body.emailConfirmed === true,
			scopeGranted: true,
		};
	} catch {
		return { confirmed: false, scopeGranted: false };
	}
}

/** The narrow scope that grants read access to the account's address, and nothing else. */
export const EMAIL_SCOPE = "transition:email";

// ─── Signups waiting on an address ───────────────────────────────────────────

/** How long a proved identity waits for its address before it has to be proved again. */
export const PENDING_SIGNUP_TTL_MS = 30 * 60 * 1000;

/**
 * Park a proved ATProto identity until an address is confirmed for it.
 *
 * Returns the opaque token that binds the row to one browser; the caller puts it in an
 * httpOnly cookie. See the schema note for why this is a token in a table rather than a
 * signed cookie, and why the DID alone would not do.
 */
export async function startPendingSignup(
	identity: AtprotoIdentity,
	email?: string,
): Promise<string> {
	const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
	await db.insert(atprotoPendingSignups).values({
		token,
		did: identity.did,
		handle: identity.handle,
		pdsUrl: identity.pdsUrl,
		// Kept only to prefill the field. It is not proof of anything — the emailed code is,
		// and the person may type a different address, which is their right.
		email: email ?? null,
	});
	return token;
}

/** Read a parked identity without spending it. Expired rows read as absent. */
export async function readPendingSignup(
	token: string | undefined,
): Promise<typeof atprotoPendingSignups.$inferSelect | undefined> {
	if (!token) return undefined;
	const [row] = await db
		.select()
		.from(atprotoPendingSignups)
		.where(eq(atprotoPendingSignups.token, token))
		.limit(1);
	if (!row) return undefined;
	if (Date.now() - row.createdAt.getTime() > PENDING_SIGNUP_TTL_MS) return undefined;
	return row;
}

/**
 * Attach a parked identity to an account whose address has just been proved, and spend it.
 *
 * 🚨 **This is where the email-collision case resolves, and it resolves safely.** The
 * account may be one that already existed — someone whose Anthers address happens to match
 * what their PDS holds — and attaching to it is correct precisely *because* they have just
 * typed a code sent to that mailbox. The PDS's claim about an address is somebody else's
 * assertion; a code we sent and they read is ours.
 *
 * Refuses rather than steals: a DID some other account already holds is left alone.
 */
export async function attachPendingSignup(
	token: string | undefined,
	userId: number,
): Promise<{ attached: boolean }> {
	const row = await readPendingSignup(token);
	if (!row) return { attached: false };

	// Spend it either way. A token that has been looked at has done its job, and leaving a
	// spent one alive is how a replay becomes possible.
	await db.delete(atprotoPendingSignups).where(eq(atprotoPendingSignups.token, row.token));

	const result = await linkAtprotoToUser(userId, {
		did: row.did,
		handle: row.handle,
		pdsUrl: row.pdsUrl,
	});
	return { attached: !result.error };
}

/** Abandon a parked signup outright. Safe to call with no token, or a stale one. */
export async function clearPendingSignup(token: string | undefined): Promise<void> {
	if (!token) return;
	await db.delete(atprotoPendingSignups).where(eq(atprotoPendingSignups.token, token));
}

/** Drop parked signups nobody came back for. Same contract as the OAuth state sweep. */
export async function sweepExpiredPendingSignups(): Promise<void> {
	await db
		.delete(atprotoPendingSignups)
		.where(lt(atprotoPendingSignups.createdAt, new Date(Date.now() - PENDING_SIGNUP_TTL_MS)));
}

/**
 * Link an ATProto DID to an existing user account.
 *
 * ⚠️ **The refusal is a code rather than a sentence, and the two are not interchangeable
 * here.** This one is reached through the OAuth callback, so it travels back to the browser
 * as a query parameter and is turned into words by `ATProtoCallbackPage`. It read as a
 * sentence until 2026-08-22, which meant the page's `did_already_linked` message was dead
 * code that could never match — the raw sentence happened to be readable, so nothing ever
 * looked wrong. Errors that do *not* round-trip stay sentences; see `unlinkAtprotoFromUser`.
 */
export async function linkAtprotoToUser(
	userId: number,
	identity: AtprotoIdentity,
): Promise<{ error?: string }> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoDid, identity.did))
		.limit(1);

	if (existing && existing.id !== userId) {
		return { error: "did_already_linked" };
	}

	await db
		.update(users)
		.set({
			atprotoDid: identity.did,
			atprotoHandle: identity.handle,
			atprotoPdsUrl: identity.pdsUrl,
		})
		.where(eq(users.id, userId));

	return {};
}

/**
 * Unlink ATProto from a user. Refuses when doing so would leave no way back in.
 *
 * 🚨 **"No way back in" is not the same as "no password", and reading it that way locked
 * out accounts that were fine** (fixed 2026-08-22). A password has been optional since the
 * signup ceremony shipped: `/auth/signin/start` mails a six-character code to any address
 * that has an account, whatever it holds for a password. So the check that matters is
 * whether the account has a **reachable address**, and the only unreachable one Anthers
 * ever writes is the `@atproto.invalid` placeholder an ATProto-created account gets. The
 * old check refused every passwordless account, which is most of them now — a guard aimed
 * at the ATProto-only case that had quietly grown to cover the ordinary one.
 *
 * The refusal is a sentence rather than a code because it is answered as JSON to a page
 * that displays it; nothing about it survives a redirect. Contrast `linkAtprotoToUser`.
 */
export async function unlinkAtprotoFromUser(userId: number): Promise<{ error?: string }> {
	const [user] = await db
		.select({
			passwordHash: users.passwordHash,
			email: users.email,
			atprotoDid: users.atprotoDid,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		return { error: "Account not found" };
	}

	if (!user.passwordHash && !hasReachableEmail(user.email)) {
		return {
			error:
				"Unlinking would leave no way to sign in — this account has no password and no email address we can reach.",
		};
	}

	await db
		.update(users)
		.set({ atprotoDid: null, atprotoHandle: "", atprotoPdsUrl: "" })
		.where(eq(users.id, userId));

	// Revoke at the authorization server as well as locally. A row deleted without a
	// revocation leaves a live token we no longer track, which is the worse of the two.
	if (user.atprotoDid) {
		try {
			await getAtprotoClient().revoke(user.atprotoDid);
		} catch {
			// The server may already consider it gone; the local delete below is what matters.
		}
		await db.delete(atprotoSessions).where(eq(atprotoSessions.did, user.atprotoDid));
	}
	await db.delete(atprotoSessions).where(eq(atprotoSessions.userId, userId));

	return {};
}
