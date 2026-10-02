// SPDX-License-Identifier: Apache-2.0
/**
 * The proof-of-work puzzles standing in front of signup — issuing one, and spending it.
 *
 * 🚨 **This module is the only writer of `signup_challenges`**, on the same
 * one-writer-of-its-records discipline as `services/pending-signups.ts`: the rules about
 * what makes a proof valid (single-use, short-lived, difficulty honored) are the whole of
 * the protection here, and they do not survive being restated at every call site.
 *
 * The scheme is hashcash, per Anubis's design. The browser grinds SHA-256 of
 * `challenge + nonce` (nonce = 0, 1, 2, …) until the digest carries `difficulty` leading
 * hex zeros; the server re-hashes ONCE with the client's nonce and compares. The cost
 * asymmetry is the point: at difficulty 4 the browser burns ~65k expected hashes (about a
 * second on a phone) while the server spends exactly one SHA-256, so a script that wants
 * to reserve handles at scale has to pay the grind every single time.
 *
 * **What this proves is that the caller is willing to spend CPU, not that they are a
 * person** — and that is enough, because the door it guards (`POST /auth/signup/begin`,
 * which reserves a handle and writes a pending signup) is the one whose abuse is cheap.
 * No vendor, no third party in the funnel, and no IP binding: a puzzle that died with the
 * address it was issued on would lock out real people whose network changed mid-ceremony
 * while stopping nobody who can hold a connection.
 *
 * The hardening is all here rather than at the route, so that the rules are testable
 * without a browser and cannot be half-applied by a second caller:
 *
 *   • **Short life** — five minutes, `SIGNUP_CHALLENGE_TTL_MS`.
 *   • **Single-use, atomically.** The spend is a conditional UPDATE on `consumedAt IS
 *     NULL`, so two requests racing on one puzzle produce exactly one winner and one
 *     `already_spent` refusal — replay prevention is ours to implement, and this is it.
 *   • **Difficulty stored per row**, so turning the knob cannot retroactively void
 *     puzzles already sitting in people's browsers.
 */

import { db } from "@anthers/db/client";
import { signupChallenges } from "@anthers/db/schema";
import { meetsDifficulty, sha256Hex } from "@anthers/shared/signup-pow";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

/** How long an issued challenge stays good. Short, because the solve itself is seconds. */
export const SIGNUP_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * The difficulty a challenge demands, read at call time so a redeploy picks up an edited
 * value and a test can set it.
 *
 * 🚨 **Unset means 4, never 0 — the protected direction is the default.** A missing value
 * must never remove a protection (see `packages/db/src/dev-only.ts`'s docblock for the
 * rule, and the empty-`SITE_PASSWORD` incident that wrote it down). Difficulty 0 — any
 * hash passes, the first nonce wins — exists only so test and browser sessions solve
 * instantly, and it is an explicit opt-in via `SIGNUP_POW_DIFFICULTY=0` in the
 * environment a session hands the API.
 *
 * 4 is ~65k expected hashes, about a second on a phone; each increment is ×16.
 */
export function signupPowDifficulty(): number {
	const parsed = Number.parseInt(process.env.SIGNUP_POW_DIFFICULTY ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
}

/** A challenge, issued and waiting to be solved. */
export interface IssuedChallenge {
	/** Identifies the row when the solved proof comes back. */
	id: number;
	/** The string the browser grinds `challenge + nonce` over. */
	challenge: string;
	/** Leading hex zeros the digest must carry. */
	difficulty: number;
}

/**
 * Whether a digest carries the required leading hex zeros — `@anthers/shared/signup-pow`'s
 * `meetsDifficulty`, imported so the server's check and the browser's grind are one line
 * of code rather than two copies that could drift.
 */

/** Why a proof was refused, when it was. Refusals are distinguishable: this door is not enumeration-sensitive. */
export type PowFailure =
	| "no_challenge"
	| "expired"
	| "already_spent"
	| "wrong_difficulty"
	| "wrong_nonce";

export type PowCheck = { ok: true } | { ok: false; reason: PowFailure };

/**
 * Issue a fresh puzzle.
 *
 * The difficulty is read at issue time and stored on the row, so the knob cannot
 * retroactively change what a puzzle already in somebody's browser demands.
 */
export async function issueSignupChallenge(now = new Date()): Promise<IssuedChallenge> {
	const { generateToken } = await import("./auth.js");
	const difficulty = signupPowDifficulty();
	const [row] = await db
		.insert(signupChallenges)
		.values({
			challenge: generateToken(),
			difficulty,
			issuedAt: now,
			expiresAt: new Date(now.getTime() + SIGNUP_CHALLENGE_TTL_MS),
		})
		.returning({ id: signupChallenges.id, challenge: signupChallenges.challenge });
	return { id: row.id, challenge: row.challenge, difficulty };
}

/**
 * Verify a solved proof, and spend the puzzle it names.
 *
 * The order of the checks is security-relevant, so it is fixed: the row must be live and
 * unconsumed BEFORE the hash is computed, and the spend is the atomic conditional UPDATE
 * below — never a read-then-write. Two requests presenting one puzzle race and exactly
 * one wins; the loser reads `already_spent`, which is a replay by definition.
 *
 * 🚨 **The row is consumed even when the nonce is wrong.** A wrong nonce proved nothing
 * about the caller, but it did prove the challenge string reached somebody willing to
 * guess rather than grind — and leaving the row alive would make the grind skippable by
 * brute-forcing the verify endpoint itself, at one hash per try, which is exactly the
 * cost asymmetry this scheme exists to create. The client gets a fresh challenge.
 */
export async function spendSignupChallenge(
	id: number,
	nonce: number,
	now = new Date(),
): Promise<PowCheck> {
	const [row] = await db
		.select({
			id: signupChallenges.id,
			challenge: signupChallenges.challenge,
			difficulty: signupChallenges.difficulty,
			consumedAt: signupChallenges.consumedAt,
			expiresAt: signupChallenges.expiresAt,
		})
		.from(signupChallenges)
		.where(eq(signupChallenges.id, id))
		.limit(1);
	if (!row) return { ok: false, reason: "no_challenge" };
	if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
	if (row.consumedAt !== null) return { ok: false, reason: "already_spent" };

	// The atomic spend. The WHERE clause is the replay prevention: a second claimant
	// updates zero rows, and the row count is what decides who won.
	const spent = await db
		.update(signupChallenges)
		.set({ consumedAt: now })
		.where(and(eq(signupChallenges.id, id), isNull(signupChallenges.consumedAt)))
		.returning({ id: signupChallenges.id });
	if (spent.length === 0) return { ok: false, reason: "already_spent" };

	const digest = await sha256Hex(`${row.challenge}${nonce}`);
	if (!meetsDifficulty(digest, row.difficulty)) return { ok: false, reason: "wrong_nonce" };

	return { ok: true };
}

/**
 * Drop consumed and expired challenges. Returns how many rows went.
 *
 * Both kinds are pure garbage: a challenge string is public the moment it is issued and
 * carries nothing personal, so the sweep is housekeeping rather than privacy work.
 * Scheduled with the other expiring credential tables under `QUEUES.PRUNE_CREDENTIALS`;
 * the count is returned rather than logged so a test can assert on rows removed, on the
 * same reasoning as `deleteExpiredSignupCodes` (a consumed row already refuses replay,
 * so asserting through reads proves nothing).
 */
export async function sweepSignupChallenges(now = new Date()): Promise<number> {
	const gone = await db
		.delete(signupChallenges)
		.where(
			// Consumed rows are swept on a grace window rather than instantly, so a replay
			// arriving during a request already in flight still reads as a replay rather
			// than as a puzzle that never existed.
			or(
				and(isNotNull(signupChallenges.consumedAt), lt(signupChallenges.consumedAt, now)),
				lt(signupChallenges.expiresAt, now),
			),
		)
		.returning({ id: signupChallenges.id });
	return gone.length;
}
