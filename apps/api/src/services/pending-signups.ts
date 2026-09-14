// SPDX-License-Identifier: Apache-2.0
/**
 * The pending account — a signup somebody has asked for and not yet finished.
 *
 * 🚨 **This module is the only writer of `pending_signups`.** Both signup doors go through it,
 * and so does every way of coming back to one, because the rules about what may be carried
 * across from an unfinished signup are the whole of the security here and they do not survive
 * being restated at every call site.
 *
 * 🚨 **Every account is an ATProto identity, so a pending signup is not finished until it holds
 * one.** The two doors are an identity somebody already has (Bluesky, proved by an OAuth round
 * trip) and one they are asking Anthers to issue (a handle on `anthers.social`). The address is
 * proved on both, by a code Anthers sends, but it is never the identity.
 *
 * **What a pending signup is for.** `/subscribe` is where a visitor makes their choices;
 * pressing the button writes them here and takes the person off that page to one whose only
 * job is finishing. Two things follow from writing the row at that moment rather than at the
 * end. The next thing asked of somebody is the only thing in front of them, rather than a
 * modal over a page still inviting them to add and remove picks. And a signup that is written
 * down is **resumable**: press the button, walk away for days, come back, and the choices are
 * still there.
 *
 * 🚨 **The row is also the reservation** (Parker, 2026-09-13). A requested handle is held from
 * the moment the button is pressed until the signup finishes, is abandoned or changed, or
 * expires — the unique index on `hosted_handle` enforces it, and the availability check reads
 * it. Waiting until the code is read to claim the name is what used to strand somebody at the
 * last step with a name taken out from under them. ⚠️ **Nothing is created on the node early**:
 * an identity created at the click would publish a DID to the PLC directory for a signup that
 * may never finish, and that cannot be taken back. The reservation is binding without it,
 * because Anthers is the only thing that creates accounts on its node.
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
 * 🚨 **Across browsers, choices travel and credentials are proved again, and that is the sharp
 * edge of this whole design.** A pending signup carries two kinds of thing. A requested handle
 * and the support picks are *choices*; a Bluesky DID is a *credential*. The takeover the
 * difference prevents: somebody completes a real OAuth round trip with their own Bluesky
 * account, types *your* address into the finishing page, and walks away. You later prove your
 * own mailbox in a browser with no cookie, and — if the row handed its DID over — your account
 * would come into existence with a stranger's identity attached, which they could then sign in
 * with. So `resumeByProvedAddress` **clears the DID** and keeps only its handle, as a hint the
 * finishing page shows beside *Continue with Bluesky*; a stranger's identity cannot be re-proved
 * by the person whose mailbox it is.
 *
 * ⚠️ **The requested handle does travel, because the harm there only works when it is silent.**
 * A stranger who types your address and asks for an ugly name would be naming you — which is
 * why the finishing page shows a resumed signup's handle and asks for it to be confirmed or
 * changed before anything is created, rather than creating it on arrival.
 */

import { db } from "@anthers/db/client";
import { atprotoSessions, pendingSignups, users } from "@anthers/db/schema";
import { sanitizeNextPath } from "@anthers/shared/next-path";
import { normalizePicks, type SignupPicks } from "@anthers/shared/signup";
import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import type { AtprotoIdentity } from "./atproto.js";
import { attachSessionToUser, revokeAtprotoGrant } from "./atproto-client.js";
import type { HostedAccount } from "./hosted-accounts.js";

/**
 * How long an unfinished signup waits before it has to be started again.
 *
 * ⚠️ **Seven days rather than the thirty minutes the parked ATProto identity used to
 * get**, because the point of the row changed. Thirty minutes was the life of a proved
 * OAuth token nobody had claimed; this is the life of *a decision somebody made*, and
 * "press the button, read the mail tomorrow" is the ordinary case rather than an edge one.
 *
 * It is still short, because an abandoned pending signup is personal data belonging to
 * somebody who never became a user — see the Privacy Policy — and the sweep below is what honors that.
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
 * A requested handle another unfinished signup is already holding.
 *
 * Thrown rather than returned because it can only be discovered by the write itself: two
 * signups asking for one name at the same moment both pass the availability check, and the
 * unique index is what decides between them.
 */
export class HandleReservedError extends Error {
	constructor() {
		super("That handle is being held for another signup.");
		this.name = "HandleReservedError";
	}
}

/** Whether a write failed on a unique index — postgres-js reports it, and Drizzle may wrap it. */
function isUniqueViolation(err: unknown): boolean {
	const code = (e: unknown) => (e as { code?: string } | null)?.code;
	return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * Free a handle held by a signup that has already expired.
 *
 * ⚠️ **The sweep is housekeeping and never the gate**, which is why this exists: an expired row
 * reads as absent everywhere else, but the unique index still sees it until the sweep runs, and
 * a name must not stay held past its expiry because a job has not come round yet.
 */
async function releaseExpiredReservation(handleName: string): Promise<void> {
	const gone = await db
		.delete(pendingSignups)
		.where(
			and(eq(pendingSignups.hostedHandle, handleName), lt(pendingSignups.expiresAt, new Date())),
		)
		.returning({ did: pendingSignups.atprotoDid });
	for (const row of gone) {
		if (row.did) await dropOrphanAtprotoSession(row.did);
	}
}

/**
 * Whether an unfinished signup other than this browser's is holding a handle.
 *
 * ⚠️ **This browser's own reservation does not count against it**, so somebody who pressed the
 * button, came back and is still looking at the name they asked for is told it is theirs rather
 * than that it is taken.
 */
export async function handleReservedElsewhere(
	handleName: string,
	ownToken: string | undefined,
): Promise<boolean> {
	const [row] = await db
		.select({ token: pendingSignups.token })
		.from(pendingSignups)
		.where(
			and(
				eq(pendingSignups.hostedHandle, handleName),
				gt(pendingSignups.expiresAt, new Date()),
				ownToken ? ne(pendingSignups.token, ownToken) : undefined,
			),
		)
		.limit(1);
	return !!row;
}

/**
 * Write down a signup somebody has just asked for, and return the token that binds it to
 * their browser.
 *
 * ⚠️ **The caller's previous row is dropped first**, so one browser holds one pending
 * signup. Pressing the button twice is a person changing their mind, not two signups, and
 * leaving the first alive would mean a later resume could find the wrong one.
 *
 * Throws {@link HandleReservedError} when the requested handle is held by another signup.
 */
export async function startPendingSignup(input: {
	previousToken?: string;
	email?: string | null;
	picks?: unknown;
	next?: string | null;
	identity?: AtprotoIdentity;
	/**
	 * The handle somebody asked Anthers to issue, reserved by this write.
	 *
	 * ⚠️ **Mutually exclusive with `identity`.** The doors are tabs: somebody either brings an
	 * identity or asks for one. Choosing one clears the other everywhere a row is changed, so a
	 * row never holds both.
	 */
	hostedHandle?: string | null;
}): Promise<string> {
	const hostedHandle = input.identity ? null : input.hostedHandle || null;
	if (hostedHandle) await releaseExpiredReservation(hostedHandle);
	if (input.previousToken) await clearPendingSignup(input.previousToken);

	const token = mintToken();
	try {
		await db.insert(pendingSignups).values({
			token,
			email: normalize(input.email),
			picks: normalizePicks(input.picks),
			next: sanitizeNextPath(input.next ?? undefined) ?? "",
			atprotoDid: input.identity?.did ?? null,
			atprotoHandle: input.identity?.handle ?? "",
			atprotoPdsUrl: input.identity?.pdsUrl ?? "",
			hostedHandle,
			expiresAt: expiry(),
		});
	} catch (err) {
		if (isUniqueViolation(err)) throw new HandleReservedError();
		throw err;
	}
	return token;
}

/**
 * Change the identity an unfinished signup is asking for to a handle Anthers issues.
 *
 * It reserves the new name, releases the one held before, and drops any Bluesky identity the
 * row carried — the doors are exclusive. Throws {@link HandleReservedError} when another signup
 * holds the name.
 */
export async function chooseHostedHandle(token: string, handleName: string): Promise<void> {
	const row = await readPendingSignup(token);
	if (!row) return;

	await releaseExpiredReservation(handleName);
	try {
		await db
			.update(pendingSignups)
			.set({ hostedHandle: handleName, atprotoDid: null, atprotoHandle: "", atprotoPdsUrl: "" })
			.where(eq(pendingSignups.token, token));
	} catch (err) {
		if (isUniqueViolation(err)) throw new HandleReservedError();
		throw err;
	}
	if (row.atprotoDid) await dropOrphanAtprotoSession(row.atprotoDid);
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
 * ⚠️ **Choosing Bluesky releases any handle the row was holding**, because the doors are
 * exclusive and a name reserved for a signup that no longer wants it is a name nobody else can
 * have for a week.
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
			hostedHandle: null,
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
 * 🚨 **The Bluesky DID is cleared rather than carried across.** The caller has proved a
 * mailbox, not an identity, and the row's DID was written by whoever completed an OAuth round
 * trip — which is not necessarily the same person, because the address on the row was only
 * ever typed. See the module note for the takeover this closes. Its handle stays behind as a
 * hint, so the finishing page can offer *Continue with Bluesky* for the identity somebody
 * started with, and the round trip there proves it again.
 *
 * ⭐ **The requested handle and the picks are kept**, still reserved, because they are choices
 * rather than credentials and the finishing page asks for them to be confirmed before anything
 * is created. Dropping them is what used to leave the real person with nothing to finish.
 *
 * Returns the row, rebound to a new token so the caller can set the cookie, or undefined when
 * there is no unfinished signup for that address.
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
			// The credential goes; its handle stays as the hint described above.
			atprotoDid: null,
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
	// A row whose address is already proved needs no code: it was resumed in this browser, and
	// the person is back from a Bluesky round trip to finish it.
	if (!row?.email || row.codeSentAt || row.emailProvedAt) return;

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
 * Record that the address on a signup has been proved, by a code just spent.
 *
 * ⚠️ **Stamped before the identity is created, so a failure there costs nothing.** If the node
 * is down at the last step, the person has still read the code; the stamp is what lets them
 * finish later — here or in another browser — without being asked to prove the same mailbox
 * twice. The proved address replaces whatever was typed, because the proof is what counts.
 */
export async function markAddressProved(token: string, email: string): Promise<void> {
	await db
		.update(pendingSignups)
		.set({ email: normalize(email), emailProvedAt: new Date() })
		.where(eq(pendingSignups.token, token));
}

/** The identity a new account is about to be created with. */
export type SignupIdentity =
	/** An identity somebody already holds, proved by an OAuth round trip in this browser. */
	| { kind: "brought"; did: string; handle: string; pdsUrl: string }
	/** An identity Anthers has just created on its own node. */
	| { kind: "hosted"; account: HostedAccount; pdsUrl: string };

/** Why a signup could not be finished yet. The message is shown to the person, so it is a sentence. */
export interface SignupRefusal {
	reason: "no_identity" | "identity_taken" | "handle_unavailable" | "identity_unavailable";
	message: string;
	/** A person can act on 409s; a 503 is Anthers' problem and says to try again. */
	status: 409 | 503;
}

/**
 * Settle the identity a signup will create its account with, before any account exists.
 *
 * 🚨 **This runs BEFORE the `users` row is written, and that order is the rule.** Every account
 * is an ATProto identity, so an account created first and given its identity second is an
 * account that exists without one whenever the second step fails. Here a failure leaves the
 * pending signup exactly where it was — address proved, handle still reserved — and the
 * finishing page says what to do.
 *
 * ⚠️ **A refusal about the identity changes the row so the finishing page can offer a choice.**
 * A Bluesky identity that already has an Anthers account is dropped (the answer is to sign in
 * with it), and a name the node will not issue releases its reservation (the answer is another
 * name). An operational failure changes nothing, because the same request will work later.
 *
 * Called only once the address has been proved, which is what makes creating an identity here
 * safe: an identity issued from a typed address would be bound to whoever typed it.
 */
export async function establishSignupIdentity(
	row: PendingSignup,
	email: string,
): Promise<{ identity: SignupIdentity } | { refusal: SignupRefusal }> {
	if (row.atprotoDid) {
		const [holder] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.atprotoDid, row.atprotoDid))
			.limit(1);
		if (holder) {
			await db
				.update(pendingSignups)
				.set({ atprotoDid: null, atprotoPdsUrl: "" })
				.where(eq(pendingSignups.token, row.token));
			return {
				refusal: {
					reason: "identity_taken",
					message: `@${row.atprotoHandle} already has an Anthers account. Sign in with Bluesky instead, or choose another identity.`,
					status: 409,
				},
			};
		}
		return {
			identity: {
				kind: "brought",
				did: row.atprotoDid,
				handle: row.atprotoHandle,
				pdsUrl: row.atprotoPdsUrl,
			},
		};
	}

	if (row.hostedHandle) {
		const { createHostedAccount, HostedAccountError, hostedIdentityOffered, hostedPdsUrl } =
			await import("./hosted-accounts.js");
		if (!(await hostedIdentityOffered())) {
			return {
				refusal: {
					reason: "identity_unavailable",
					message: "Anthers isn't issuing handles right now. Your handle is still held for you.",
					status: 503,
				},
			};
		}
		try {
			const account = await createHostedAccount({ handleName: row.hostedHandle, email });
			return { identity: { kind: "hosted", account, pdsUrl: hostedPdsUrl() } };
		} catch (err) {
			if (err instanceof HostedAccountError && err.fault === "name") {
				await db
					.update(pendingSignups)
					.set({ hostedHandle: null })
					.where(eq(pendingSignups.token, row.token));
				return { refusal: { reason: "handle_unavailable", message: err.message, status: 409 } };
			}
			// Nobody's fault and invisible from outside, so it is the one that has to be logged.
			console.error("[pending-signups] could not create the identity:", err);
			const message =
				err instanceof HostedAccountError ? err.message : "Couldn't create the handle.";
			return {
				refusal: {
					reason: "identity_unavailable",
					message: `${message} Your handle is still held for you — try again in a moment.`,
					status: 503,
				},
			};
		}
	}

	return {
		refusal: {
			reason: "no_identity",
			message: "Choose a handle, or sign up with Bluesky, to finish creating your account.",
			status: 409,
		},
	};
}

/**
 * Spend a pending signup against the account just created from it, and write down what its
 * identity needs.
 *
 * 🚨 **The row is deleted whatever happens.** A pending signup that has become an account has
 * done its job, and leaving a spent one alive is how a replay becomes possible.
 *
 * ⚠️ **A hosted identity's credential is written first**, because the password in it is the only
 * copy — see `recordHostedIdentity`. A brought identity's OAuth session is claimed for the
 * account, since the callback wrote it keyed by DID before there was an account to own it, and a
 * row left with a null `userId` is one the sweep is entitled to treat as an orphan.
 */
export async function completePendingSignup(
	token: string,
	userId: number,
	identity: SignupIdentity,
): Promise<{ picks: SignupPicks; next: string } | null> {
	const row = await readPendingSignup(token);
	await db.delete(pendingSignups).where(eq(pendingSignups.token, token));

	if (identity.kind === "hosted") {
		const { recordHostedIdentity } = await import("./hosted-accounts.js");
		await recordHostedIdentity(userId, identity.account);
	} else {
		await attachSessionToUser(identity.did, userId);
	}

	return row ? { picks: picksOf(row), next: row.next } : null;
}

/**
 * Create the account a proved address and its pending signup describe, holding its identity.
 *
 * 🚨 **This is the ONE place an account row comes into existence.** The signup routes call it once
 * the address is proved, and so does the test fixture that makes accounts, which is what keeps a
 * test account the same shape as a real one: the identity is settled first, the row is written
 * with its DID, and the pending signup is spent — see `establishSignupIdentity` for why that order
 * is the rule.
 *
 * A refusal leaves the signup where it was with its address marked proved, so finishing later
 * needs no second code. The caller decides what signing in means, since a route sets a cookie and
 * a fixture does not.
 *
 * A created account is `emailVerified: true` from the first instant: the code just typed IS the
 * verification. `username` stays null, which is what routes it to `/welcome` — the only place the
 * terms and the 13+ assertion are ever presented.
 */
export async function createAccountFromSignup(
	row: PendingSignup,
	email: string,
): Promise<
	| { refusal: SignupRefusal }
	| { user: typeof users.$inferSelect; spent: { picks: SignupPicks; next: string } | null }
> {
	await markAddressProved(row.token, email);
	const settled = await establishSignupIdentity(row, email);
	if ("refusal" in settled) return settled;

	const { identity } = settled;
	const fields =
		identity.kind === "hosted"
			? { did: identity.account.did, handle: identity.account.handle, pdsUrl: identity.pdsUrl }
			: { did: identity.did, handle: identity.handle, pdsUrl: identity.pdsUrl };

	let user: typeof users.$inferSelect;
	try {
		[user] = await db
			.insert(users)
			.values({
				email,
				emailVerified: true,
				atprotoDid: fields.did,
				atprotoHandle: fields.handle,
				atprotoPdsUrl: fields.pdsUrl,
			})
			.returning();
	} catch (err) {
		// ⚠️ **An identity the node has just created now belongs to nobody**, which is the one
		// outcome here nobody can repair from inside Anthers — so it is logged with the DID. The
		// realistic cause is two browsers finishing one signup at the same moment.
		if (identity.kind === "hosted") {
			console.error(
				`[signup] created ${fields.did} (${fields.handle}) on the node but could not create ` +
					"its account; the identity is unowned:",
				err,
			);
		}
		throw err;
	}

	const spent = await completePendingSignup(row.token, user.id, identity);
	return { user, spent };
}

/**
 * Spend a pending signup without creating anything — its address turned out to belong to an
 * account that already exists, and that person is simply signed in.
 *
 * ⚠️ **The identity it carried is not attached**, because the account already holds its own and
 * an account holds exactly one. The reservation is released and an unclaimed OAuth session is
 * revoked, the same as abandoning. The picks still come back, so somebody who chose to support a
 * creator on the way in is not asked twice.
 */
export async function spendPendingSignup(
	token: string,
): Promise<{ picks: SignupPicks; next: string } | null> {
	const row = await readPendingSignup(token);
	if (!row) return null;
	await clearPendingSignup(token);
	return { picks: picksOf(row), next: row.next };
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
 * worse of the two.
 */
async function dropOrphanAtprotoSession(did: string): Promise<void> {
	const [orphan] = await db
		.select({ did: atprotoSessions.did })
		.from(atprotoSessions)
		.where(and(eq(atprotoSessions.did, did), isNull(atprotoSessions.userId)))
		.limit(1);
	if (!orphan) return;

	await revokeAtprotoGrant(did);
	await db
		.delete(atprotoSessions)
		.where(and(eq(atprotoSessions.did, did), isNull(atprotoSessions.userId)));
}
