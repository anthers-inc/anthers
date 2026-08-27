// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pending account — a signup somebody has asked for and not yet finished.
 *
 * 🚨 **This module is the only writer of `pending_signups`.** Both signup doors go through
 * it, and so does every way of coming back to one, because the rules about what may be
 * carried across from an unfinished signup are the whole of the security here and they do
 * not survive being restated at three call sites.
 *
 * **What a pending signup is for.** `/subscribe` is where a visitor makes their choices;
 * pressing *Create My Account* writes them here and takes the person off that page to one
 * whose only job is finishing. Two things follow from writing the row at that moment rather
 * than at the end. The next thing asked of somebody is the only thing in front of them,
 * rather than a modal over a page still inviting them to add and remove picks. And a signup
 * that is written down is **resumable**: press the button, walk away, come back, and the
 * choices are still there.
 *
 * 🚨 **The pre-account state lives here rather than on `users`, and the hazard decides
 * that.** `users.email` is `NOT NULL UNIQUE`, so a pending row on `users` would claim an
 * address before anybody had proved they could read it — type a stranger's address into
 * `/subscribe` and its real owner cannot sign up until the row expires. That is a new
 * hazard rather than an existing one, since today's pre-account claim lives in
 * `signup_codes`, a row that expires on its own and mints nothing. This table is the same
 * shape, for the same reason.
 *
 * # The three ways back to a pending signup, and what each one proves
 *
 * **The cookie**, which is the ordinary case: the same browser, holding the opaque token
 * this module minted. It proves nothing about a person and everything about continuity —
 * it is the same browser that started the signup, so whatever that browser was told is
 * still true.
 *
 * **The emailed code**, which is how a signup resumes in a *different* browser. Completing
 * a code sent to the address on the row proves control of that mailbox, and control of the
 * mailbox is the same evidence the finished account will rest on. ⚠️ Being able to *name*
 * an address proves nothing at all, which is why `emailProvedAt` is stamped in exactly one
 * place — after a code has actually been spent.
 *
 * **A second OAuth round trip**, which is how a Bluesky signup resumes anywhere. Proving
 * the DID again is at least as strong as proving it the first time.
 *
 * 🚨 **An address-resumed row may not carry its ATProto identity across, and that is the
 * sharp edge of this whole design.** The takeover it prevents: somebody completes a real
 * OAuth round trip with their own Bluesky account, types *your* address into the finishing
 * page, and walks away. You sign up later in a browser with no cookie, complete a code sent
 * to your own mailbox, and — if the row handed its DID over — your account would come into
 * existence with a stranger's Bluesky identity linked to it, which they could then sign in
 * with. So `resumeByProvedAddress` **clears the identity** rather than trusting it, and the
 * finishing page offers to connect Bluesky again. That is the same argument the table's own
 * note makes about being keyed by a token instead of by a DID, applied to the address.
 */

import { db } from "@anthers/db/client";
import { atprotoSessions, pendingSignups } from "@anthers/db/schema";
import { sanitizeNextPath } from "@anthers/shared/next-path";
import { normalizePicks, type SignupPicks } from "@anthers/shared/signup";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { AtprotoIdentity } from "./atproto.js";
import { attachSessionToUser, getAtprotoClient } from "./atproto-client.js";

/**
 * How long an unfinished signup waits before it has to be started again.
 *
 * ⚠️ **Seven days rather than the thirty minutes the parked ATProto identity used to
 * get**, because the point of the row changed. Thirty minutes was the life of a proved
 * OAuth token nobody had claimed; this is the life of *a decision somebody made*, and
 * "press the button, read the mail tomorrow" is the ordinary case rather than an edge one.
 *
 * It is still short, because an abandoned pending signup is personal data belonging to
 * somebody who never became a user — see 51.05 — and the sweep below is what honours that.
 */
export const PENDING_SIGNUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingSignup = typeof pendingSignups.$inferSelect;

/** Lowercased and trimmed, matching `normalizeEmail` in `services/signup-codes.ts`. */
function normalize(email: string | null | undefined): string | null {
	const value = email?.trim().toLowerCase();
	return value ? value : null;
}

/** An opaque, unguessable token. Two UUIDs' worth, as the parked identity used. */
function mintToken(): string {
	return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function expiry(now = Date.now()): Date {
	return new Date(now + PENDING_SIGNUP_TTL_MS);
}

/**
 * Write down a signup somebody has just asked for, and return the token that binds it to
 * their browser.
 *
 * ⚠️ **The caller's previous row is dropped first**, so one browser holds one pending
 * signup. Pressing the button twice is a person changing their mind, not two signups, and
 * leaving the first alive would mean a later resume could find the wrong one.
 */
export async function startPendingSignup(input: {
	previousToken?: string;
	email?: string | null;
	picks?: unknown;
	next?: string | null;
	identity?: AtprotoIdentity;
}): Promise<string> {
	if (input.previousToken) await clearPendingSignup(input.previousToken);

	const token = mintToken();
	await db.insert(pendingSignups).values({
		token,
		email: normalize(input.email),
		picks: normalizePicks(input.picks),
		next: sanitizeNextPath(input.next ?? undefined) ?? "",
		atprotoDid: input.identity?.did ?? null,
		atprotoHandle: input.identity?.handle ?? "",
		atprotoPdsUrl: input.identity?.pdsUrl ?? "",
		expiresAt: expiry(),
	});
	return token;
}

/** Read a pending signup without spending it. An expired row reads as absent. */
export async function readPendingSignup(
	token: string | undefined | null,
): Promise<PendingSignup | undefined> {
	if (!token) return undefined;
	const [row] = await db
		.select()
		.from(pendingSignups)
		.where(eq(pendingSignups.token, token))
		.limit(1);
	// Absent to a reader the moment it expires; the sweep is housekeeping, never the gate.
	if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
	return row;
}

/** The picks on a row, in the shape everything else reads them in. */
export function picksOf(row: PendingSignup): SignupPicks {
	return normalizePicks(row.picks);
}

/**
 * Attach a proved ATProto identity to the signup this browser is in the middle of, or start
 * one if there is none.
 *
 * Starting one covers the case where the OAuth round trip outlived the cookie — a long
 * detour, or a browser that dropped it. There is nothing to recover in that case but the
 * identity itself, which is the part that was just proved.
 *
 * ⚠️ **The address the PDS gave us lands here as a prefill and never as proof.** It is
 * written only when the row has none of its own: a person who typed an address at
 * `/subscribe` and then connected Bluesky meant the one they typed.
 */
export async function bindIdentityToPending(
	token: string | undefined,
	identity: AtprotoIdentity,
	prefillEmail?: string,
): Promise<string> {
	const row = await readPendingSignup(token);
	if (!row) return startPendingSignup({ identity, email: prefillEmail });

	await db
		.update(pendingSignups)
		.set({
			atprotoDid: identity.did,
			atprotoHandle: identity.handle,
			atprotoPdsUrl: identity.pdsUrl,
			...(row.email ? {} : { email: normalize(prefillEmail) }),
		})
		.where(eq(pendingSignups.token, row.token));
	return row.token;
}

/**
 * Find an unfinished signup by an identity somebody has just re-proved.
 *
 * ⭐ This is what makes *"come back and sign in with the same handle"* work without weakening
 * anything: a second completed OAuth round trip is the same evidence as the first, so the
 * row may be handed back whole, identity included.
 */
export async function findPendingByDid(did: string): Promise<PendingSignup | undefined> {
	const [row] = await db
		.select()
		.from(pendingSignups)
		.where(eq(pendingSignups.atprotoDid, did))
		.limit(1);
	if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
	return row;
}

/**
 * Hand back an unfinished signup to somebody who has just proved the address on it, and
 * bind it to *this* browser.
 *
 * 🚨 **The ATProto identity is cleared rather than carried across.** The caller has proved
 * a mailbox, not an identity, and the row's DID was written by whoever completed an OAuth
 * round trip — which is not necessarily the same person, because the address on the row was
 * only ever typed. See the module note for the takeover this closes. The finishing page
 * offers to connect Bluesky again, which is a route back that costs one round trip and
 * proves the thing that actually needs proving.
 *
 * Returns the row's token, so the caller can rebind the cookie, or undefined when there is
 * no unfinished signup for that address.
 */
export async function resumeByProvedAddress(email: string): Promise<PendingSignup | undefined> {
	const address = normalize(email);
	if (!address) return undefined;

	const [row] = await db
		.select()
		.from(pendingSignups)
		.where(eq(pendingSignups.email, address))
		.limit(1);
	if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;

	// A new token, because the old one may still be in somebody else's browser — dropping a
	// signup's binding to the browser that started it is the point of this path, not a
	// side effect of it.
	const token = mintToken();
	const [rebound] = await db
		.update(pendingSignups)
		.set({
			token,
			emailProvedAt: new Date(),
			atprotoDid: null,
			atprotoHandle: "",
			atprotoPdsUrl: "",
			// The clock restarts: they are here and finishing, not abandoning.
			expiresAt: expiry(),
		})
		.where(eq(pendingSignups.token, row.token))
		.returning();

	if (row.atprotoDid) await dropOrphanAtprotoSession(row.atprotoDid);
	return rebound;
}

/**
 * Record the address a signup is now waiting on — typed at the finishing page.
 *
 * 🚨 **Both stamps are cleared, because they were about a different address.** A code sent
 * to the address somebody just corrected is not a code sent to this one, and a mailbox proved
 * earlier proves nothing about the new one.
 */
export async function setPendingEmail(token: string, email: string): Promise<void> {
	await db
		.update(pendingSignups)
		.set({ email: normalize(email), codeSentAt: null, emailProvedAt: null })
		.where(eq(pendingSignups.token, token));
}

/**
 * Put a code in the post for the address on this row, and record that we did.
 *
 * 🚨 **The Bluesky door needs this and `POST /auth/signup/begin` cannot do it**, which is the
 * whole reason it exists. That route runs *before* the round trip, when there is no address to
 * send to; the PDS supplies one at the OAuth callback, which is after the only place that sends
 * a first code. Without this the person lands on the finishing page holding an address nobody
 * has mailed — and Parker's reading of that, twice, was that Anthers had *"failed to use the
 * email associated with my Bluesky account"*. Asking somebody to press a button about an
 * address we just went and fetched is most of the step we fetched it to save.
 *
 * ⚠️ **Nothing is lost by sending straight away**, which is what makes this safe rather than
 * presumptuous: the code box carries *"Use a different address"*, so somebody who would rather
 * we used another still can, and the code we sent to the first one simply goes unspent. The
 * address was never proof — the code is — so mailing it early proves nothing early.
 *
 * ⚠️ **Which message goes out is decided here rather than at the route**, bending the rule
 * `issueSignupCode` states (that the *shape* of the message is a copy decision the route should
 * own). Two callers now need identical behavior, and one description of it beats two that agree
 * until they don't.
 *
 * Every failure is soft, and deliberately silent. A mail outage, a throttled repeat and an
 * address that already has an account must all look the same from outside, exactly as they do
 * at `/auth/signup/start`.
 */
export async function issueCodeForPending(token: string | undefined): Promise<void> {
	const row = await readPendingSignup(token);
	if (!row?.email || row.codeSentAt) return;

	try {
		const { issueSignupCode } = await import("./signup-codes.js");
		const { sendSignInCodeEmail, sendSignupCodeEmail } = await import("./email.js");
		const issued = await issueSignupCode(row.email);
		if (issued.code) {
			await (issued.existingAccount
				? sendSignInCodeEmail(row.email, issued.code)
				: sendSignupCodeEmail(row.email, issued.code));
		}
		// Stamped even when throttled: a code went out a moment ago, which is the state the
		// finishing page should show.
		await markCodeSent(row.token);
	} catch (err) {
		console.error("[pending-signups] failed to issue a code:", err);
	}
}

/**
 * Record that a code has actually gone out to the address on this row.
 *
 * ⚠️ **Called only where mail is genuinely sent**, never where an address is merely learned.
 * That distinction is the whole point of the column: the OAuth callback discovers an address
 * from the PDS and sends nothing, and a page that could not tell the two apart told people to
 * check an inbox nothing had been posted to.
 */
export async function markCodeSent(token: string | undefined): Promise<void> {
	if (!token) return;
	await db
		.update(pendingSignups)
		.set({ codeSentAt: new Date() })
		.where(eq(pendingSignups.token, token));
}

/**
 * Spend a pending signup against the account it has just become, and return what it was
 * carrying so the caller can act on the choices.
 *
 * 🚨 **The row is deleted whatever happens.** A pending signup that has been looked at has
 * done its job, and leaving a spent one alive is how a replay becomes possible — the same
 * rule the parked identity carried before this table generalized it.
 *
 * The identity is attached through `linkAtprotoToUser`, which refuses rather than steals a
 * DID some other account already holds. A refusal is deliberately not fatal: the right
 * outcome is a signed-in account with no link, which the person can sort out from settings.
 */
export async function consumePendingSignup(
	token: string | undefined,
	userId: number,
): Promise<{ picks: SignupPicks; next: string; atprotoLinked: boolean } | null> {
	const row = await readPendingSignup(token);
	if (!row) return null;

	await db.delete(pendingSignups).where(eq(pendingSignups.token, row.token));

	let atprotoLinked = false;
	if (row.atprotoDid) {
		// Imported lazily to keep the identity rules in one module without a cycle at load.
		const { linkAtprotoToUser } = await import("./atproto.js");
		const result = await linkAtprotoToUser(userId, {
			did: row.atprotoDid,
			handle: row.atprotoHandle,
			pdsUrl: row.atprotoPdsUrl,
		});
		atprotoLinked = !result.error;
		// ⚠️ **Claim the OAuth session for the account too.** The callback writes it keyed by
		// DID, before there is an account to own it, so `userId` is null until something
		// reconciles it — and a row left null is one the sweep is entitled to treat as an
		// orphan. It would be recreated on the next sign-in either way, but a signup that
		// finished should not leave its own credentials looking abandoned.
		if (atprotoLinked) await attachSessionToUser(row.atprotoDid, userId);
	}

	return { picks: picksOf(row), next: row.next, atprotoLinked };
}

/** Abandon a pending signup outright. Safe to call with no token, or a stale one. */
export async function clearPendingSignup(token: string | undefined | null): Promise<void> {
	if (!token) return;
	const [row] = await db
		.delete(pendingSignups)
		.where(eq(pendingSignups.token, token))
		.returning({ did: pendingSignups.atprotoDid });
	if (row?.did) await dropOrphanAtprotoSession(row.did);
}

/**
 * Drop signups nobody came back for.
 *
 * ⚠️ **It takes the ATProto session with it, which the parked-identity sweep never did.**
 * The OAuth callback writes an `atproto_sessions` row keyed by DID — live tokens for
 * somebody else's repository — and an abandoned signup left one behind with a null
 * `userId`, forever. Only null-`userId` rows are touched: a row that has since been claimed
 * by an account belongs to that account.
 */
export async function sweepExpiredPendingSignups(): Promise<number> {
	const gone = await db
		.delete(pendingSignups)
		.where(lt(pendingSignups.expiresAt, new Date()))
		.returning({ did: pendingSignups.atprotoDid });

	for (const row of gone) {
		if (row.did) await dropOrphanAtprotoSession(row.did);
	}
	return gone.length;
}

/**
 * Forget an OAuth session nobody ever attached to an account, revoking it at the
 * authorization server first.
 *
 * A row deleted without a revocation leaves a live token we no longer track, which is the
 * worse of the two — the same argument `unlinkAtprotoFromUser` makes.
 */
async function dropOrphanAtprotoSession(did: string): Promise<void> {
	const [orphan] = await db
		.select({ did: atprotoSessions.did })
		.from(atprotoSessions)
		.where(and(eq(atprotoSessions.did, did), isNull(atprotoSessions.userId)))
		.limit(1);
	if (!orphan) return;

	try {
		await getAtprotoClient().revoke(did);
	} catch {
		// The server may already consider it gone; the local delete is what matters.
	}
	await db
		.delete(atprotoSessions)
		.where(and(eq(atprotoSessions.did, did), isNull(atprotoSessions.userId)));
}
