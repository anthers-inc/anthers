// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The emailed six-character code — issuing it, and spending it.
 *
 * 🚨 **What this proves is control of an address, not identity of a person**, and that
 * distinction is the whole design. Everything else in `services/auth.ts` starts from a
 * `user_id` and asks "is this really them?"; this starts from an address nobody has
 * claimed yet and asks "can you read mail sent here?". The account is built *after* the
 * answer, which is why `signup_codes` is keyed on the address rather than on a user.
 *
 * **The same proof serves two outcomes**, and the caller is never told which one it got:
 *
 *   • The address has no account → one is **created**, `emailVerified: true`, and signed
 *     in. Verification has already happened; sending a "please verify" link afterwards
 *     would be asking twice for the same thing.
 *   • The address has an account → it is **signed in**.
 *
 * That second outcome is not a convenience bolted on. `/login` reaches it directly through
 * `issueSignInCode` below, which is the same proof narrowed to addresses that already have
 * an account. The signup ceremony makes a
 * password *optional*, and an account with no password and no emailed sign-in would be
 * one nobody could ever return to — the option would be a trap door rather than a
 * choice. It is also not a new grant of power: `POST /auth/request-password-reset` has
 * always let whoever reads the mailbox take the account over, and this is the same
 * authority with a shorter fuse and an attempt cap.
 *
 * The hardening is all here rather than at the route, so that the rules are testable
 * without a browser and cannot be half-applied by a second caller:
 *
 *   • **Short life** — ten minutes.
 *   • **Single live code per address**, replaced on re-request. Three codes in a mailbox
 *     means the newest works and the rest are dead, which is what a reader expects.
 *   • **Attempt cap** — five wrong guesses spend the row, so the code cannot be walked.
 *   • **Send throttle** — one code per address per interval, so "always return 200"
 *     cannot be turned into a mail-bomb aimed at anyone whose address is known.
 *   • **Hashed at rest**, with argon2id. See `codeHash` in the schema for why a cheap
 *     digest would be decoration at this length.
 */

import { db } from "@anthers/db/client";
import { pendingSignups, signupCodes, users } from "@anthers/db/schema";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "./auth.js";

/** How long an issued code stays good. */
export const SIGNUP_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses before the code is spent.
 *
 * Five rather than three: a six-box field invites a mistyped character, and the entropy
 * does the security work here — at ~887 million possibilities, the difference between
 * three guesses and five is not what stands between an attacker and an account. The cap
 * exists to stop a *walk*, not to punish fat fingers.
 */
export const SIGNUP_CODE_MAX_ATTEMPTS = 5;

/** Minimum gap between two codes to the same address. */
export const SIGNUP_CODE_RESEND_MS = 60 * 1000;

/**
 * The code's alphabet — 31 symbols, uppercase, with every confusable pair removed.
 *
 * No `O`/`0`, no `I`/`1`/`L`. Someone is reading this out of an email and typing it into
 * six boxes, and a code that is *correct* but unreadable fails exactly like a wrong one
 * while looking like a bug in the product. Dropping five symbols costs about 12% of the
 * keyspace and removes the entire class.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/**
 * A fresh code, from the CSPRNG.
 *
 * `crypto.getRandomValues` with rejection of the non-uniform tail — `% 31` over a byte
 * would make the first eight symbols meaningfully likelier than the rest. That bias is
 * small, but it is free to remove and awkward to explain later.
 */
export function generateSignupCode(): string {
	const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
	const out: string[] = [];
	const buf = new Uint8Array(CODE_LENGTH * 2);
	while (out.length < CODE_LENGTH) {
		crypto.getRandomValues(buf);
		for (const byte of buf) {
			if (out.length === CODE_LENGTH) break;
			if (byte >= max) continue;
			out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
		}
	}
	return out.join("");
}

/**
 * The one way an address is turned into a key.
 *
 * Lowercased and trimmed, so `A@B.com ` and `a@b.com` are the same row and the same
 * account. Without this a user who capitalizes their address on the second visit gets a
 * second account rather than their own, and the unique index would not stop them.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** What `issueSignupCode` did, for the route to log and for tests to assert on. */
export interface IssuedCode {
	/** The plaintext code, when one was actually minted. Null when throttled. */
	code: string | null;
	/** True when an existing row was still inside the resend window. */
	throttled: boolean;
	/** Whether this address already has an account — decides which email to send. */
	existingAccount: boolean;
}

/**
 * Mint a code for an address, or decline quietly because one was just sent.
 *
 * Returns what happened rather than sending the mail itself: the *shape* of the message
 * differs between a new address and a returning one, and that is a copy decision the
 * route can see and this service should not own.
 *
 * 🚨 **A throttled call is not an error, and must not become one.** The route answers
 * 200 either way — the whole point of that is that a caller cannot use timing or status
 * to learn whether an address is registered, and a distinct "slow down" response would
 * hand back exactly that.
 */
export async function issueSignupCode(rawEmail: string, now = new Date()): Promise<IssuedCode> {
	const email = normalizeEmail(rawEmail);

	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	const existingAccount = !!existing;

	const [live] = await db
		.select({ lastSentAt: signupCodes.lastSentAt })
		.from(signupCodes)
		.where(eq(signupCodes.email, email))
		.limit(1);

	if (live && now.getTime() - live.lastSentAt.getTime() < SIGNUP_CODE_RESEND_MS) {
		return { code: null, throttled: true, existingAccount };
	}

	const code = generateSignupCode();
	const codeHash = await hashPassword(code);
	const expiresAt = new Date(now.getTime() + SIGNUP_CODE_TTL_MS);

	// Upsert on the address: a re-request replaces the live code rather than adding a
	// second one, and resets `attempts` — the new code has not been guessed at.
	await db
		.insert(signupCodes)
		.values({ email, codeHash, expiresAt, lastSentAt: now, attempts: 0 })
		.onConflictDoUpdate({
			target: signupCodes.email,
			set: { codeHash, expiresAt, lastSentAt: now, attempts: 0 },
		});

	return { code, throttled: false, existingAccount };
}

/**
 * Mint a code **only for an address somebody has already asked us for** — the `/login` door.
 *
 * 🚨 **The difference from `issueSignupCode` is the whole reason this exists: it can never
 * lead to an account being created out of nothing.** `/subscribe` is the one signup door,
 * and a login page that mailed a code to a stranger's address would be a second one — the
 * code would be spendable, and whatever spent it would have to decide what to do with an
 * address nobody has an account for. Refusing to issue at all is what keeps that decision
 * from arising.
 *
 * ⭐ **"Already asked us for" is two things rather than one**, and the second is what makes a
 * signup resumable in a different browser: an address with an account, and an address with
 * an **unfinished signup** somebody started at `/subscribe`. Both are addresses Anthers is
 * already in a relationship with, so mailing a code to either tells an outsider nothing they
 * did not already have to know. What the second one may lead to is `POST /signup/complete`,
 * on the signup pair, where minting belongs — never a `users` row written from here.
 *
 * ⚠️ **A mistyped address at `/login` still cannot mint anything**, which is the property
 * this function exists to hold. There is no pending signup for an address nobody has typed
 * into `/subscribe`, so the miss branch below is exactly as unreachable as it ever was.
 *
 * Two consequences that are easy to get wrong, so they live here rather than at the route:
 *
 *   • **No row is written for an unknown address.** Issuing one and declining to send it
 *     would leave a live code in `signup_codes` that nobody received — and, worse, would
 *     start the resend throttle, so the same person walking on to `/subscribe` seconds
 *     later would be told to check an inbox nothing was ever sent to.
 *   • **The miss branch does the same argon2 work as the hit branch**, so the two cannot be
 *     told apart by how long the response takes. The body is identical by construction (the
 *     route answers `{success:true}` either way); without this the timing would answer the
 *     question the body refuses to. ⚠️ It is a *close* match, not a constant-time one —
 *     argon2id dominates both sides and the mail send is deliberately off the response path,
 *     but this is a mitigation rather than a proof. (`POST /auth/sign-in` and
 *     `/request-password-reset` both carry the same asymmetry, unmitigated; closing all
 *     three properly is its own piece of work.)
 */
export async function issueSignInCode(rawEmail: string, now = new Date()): Promise<IssuedCode> {
	const email = normalizeEmail(rawEmail);

	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	// An unfinished signup counts, and only an unexpired one does. Read here rather than
	// through `services/pending-signups.ts` to keep this module free of a cycle; it is a
	// membership test, not a write.
	const [unfinished] = existing
		? []
		: await db
				.select({ token: pendingSignups.token })
				.from(pendingSignups)
				.where(and(eq(pendingSignups.email, email), gt(pendingSignups.expiresAt, now)))
				.limit(1);

	if (!existing && !unfinished) {
		// Burned deliberately — see the timing note above. The value is discarded.
		await hashPassword(generateSignupCode());
		return { code: null, throttled: false, existingAccount: false };
	}

	return issueSignupCode(email, now);
}

/** Why a code was refused, when it was. */
export type CodeFailure = "no_code" | "expired" | "too_many_attempts" | "wrong_code";

export type CodeCheck = { ok: true; email: string } | { ok: false; reason: CodeFailure };

/**
 * Spend a code: check it, and burn it if it was right.
 *
 * The order matters and is the security-relevant part of this function. Expiry and the
 * attempt cap are checked **before** the hash comparison, so a spent or stale row costs
 * an attacker nothing to probe and gives them no oracle. A wrong guess increments first
 * and compares second, so a crash mid-verify cannot leave a free attempt behind.
 *
 * A correct code deletes the row rather than marking it consumed. There is nothing to
 * learn from a spent code afterwards, and a row that no longer exists cannot be replayed
 * by a bug in a later reader.
 */
export async function checkSignupCode(
	rawEmail: string,
	rawCode: string,
	now = new Date(),
): Promise<CodeCheck> {
	const email = normalizeEmail(rawEmail);
	const code = rawCode.trim().toUpperCase();

	const [row] = await db.select().from(signupCodes).where(eq(signupCodes.email, email)).limit(1);
	if (!row) return { ok: false, reason: "no_code" };

	if (row.expiresAt.getTime() <= now.getTime()) {
		await db.delete(signupCodes).where(eq(signupCodes.id, row.id));
		return { ok: false, reason: "expired" };
	}

	if (row.attempts >= SIGNUP_CODE_MAX_ATTEMPTS) {
		return { ok: false, reason: "too_many_attempts" };
	}

	// Count the attempt before testing it. If this throws, or the process dies between
	// here and the comparison, the guess is still spent — the failure mode of the other
	// order is an attacker who gets unlimited tries by killing the connection.
	await db
		.update(signupCodes)
		.set({ attempts: sql`${signupCodes.attempts} + 1` })
		.where(eq(signupCodes.id, row.id));

	const matches = await verifyPassword(code, row.codeHash);
	if (!matches) return { ok: false, reason: "wrong_code" };

	await db.delete(signupCodes).where(eq(signupCodes.id, row.id));
	return { ok: true, email };
}

/**
 * Drop expired codes. Returns how many rows went.
 *
 * Scheduled with the other two expiring credential tables under
 * `QUEUES.PRUNE_CREDENTIALS`. The count is returned rather than logged so a test can
 * assert on **rows removed** — asserting through a read would prove nothing, since
 * `checkSignupCode` already refuses anything this would delete, exactly as noted on
 * `deleteExpiredSessions`.
 */
export async function deleteExpiredSignupCodes(now = new Date()): Promise<number> {
	const gone = await db
		.delete(signupCodes)
		.where(lt(signupCodes.expiresAt, now))
		.returning({ id: signupCodes.id });
	return gone.length;
}
