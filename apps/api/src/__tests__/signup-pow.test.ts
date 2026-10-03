// SPDX-License-Identifier: Apache-2.0
/**
 * The proof-of-work gate on `POST /auth/signup/begin` — the puzzle, and what a script
 * cannot do without solving it.
 *
 * 🚨 **The refusal order is the whole point of the gate and the first thing this file
 * pins: a refused proof leaves no pending signup and holds no handle.** The check runs
 * before anything the route reserves or writes, so a script that will not burn the CPU
 * cannot even learn whether a handle is free. That is the exact property the task
 * (Parker, 2026-09-30) asked for, and it is asserted here rather than trusted.
 *
 * Every refusal is a distinguishable 400 carrying `reason: "pow_required"` — this door
 * is deliberately NOT enumeration-sensitive, unlike the address doors below it, so
 * honest errors are correct here.
 *
 * The suite solves real puzzles through the shared solver (`@anthers/shared/signup-pow`)
 * at the difficulty the environment's knob names — `scripts/session.ts` hands test
 * sessions `SIGNUP_POW_DIFFICULTY=0`, so most of these solve instantly, and the
 * difficulty-sensitive tests set and restore the knob in `afterEach`.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { pendingSignups, signupChallenges } from "@anthers/db/schema";
import { solve } from "@anthers/shared/signup-pow";
import { eq, lt } from "drizzle-orm";
import app from "../index.js";
import {
	issueSignupChallenge,
	SIGNUP_CHALLENGE_TTL_MS,
	signupPowDifficulty,
	spendSignupChallenge,
	sweepSignupChallenges,
} from "../services/signup-challenges.js";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const JSON_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:3000" };

/** The knob a test touched, restored so the next test sees the session's value. */
let heldKnob: string | undefined;
let touchedKnob = false;

afterEach(() => {
	if (touchedKnob) {
		if (heldKnob === undefined) delete process.env.SIGNUP_POW_DIFFICULTY;
		else process.env.SIGNUP_POW_DIFFICULTY = heldKnob;
		touchedKnob = false;
	}
});

afterAll(async () => {
	// Everything this suite writes is garbage by construction (expired or spent rows);
	// the sweep test's leftovers go too.
	await db.delete(signupChallenges).where(lt(signupChallenges.expiresAt, new Date()));
});

/** Issue a challenge through the route, and return it with a solved nonce. */
async function solvedChallenge(): Promise<{ id: number; nonce: number; challenge: string }> {
	const res = await app.request("/api/auth/signup/challenge");
	expect(res.status).toBe(200);
	const { id, challenge, difficulty } = (await res.json()) as {
		id: number;
		challenge: string;
		difficulty: number;
	};
	const nonce = Number(await solve(challenge, difficulty));
	return { id, nonce, challenge };
}

/** A body the begin route accepts, for the tests that get past the gate. */
const picks = { badge: null, follow: [], badges: [] };

describe("the difficulty knob", () => {
	it("defaults to 4 when the environment is silent — the protected direction", () => {
		const held = process.env.SIGNUP_POW_DIFFICULTY;
		delete process.env.SIGNUP_POW_DIFFICULTY;
		// 🚨 A missing value must mean difficulty 4, never 0 — a knob that unsets itself
		// into "off" removes the protection it exists to tune.
		expect(signupPowDifficulty()).toBe(4);
		process.env.SIGNUP_POW_DIFFICULTY = held;
	});

	it("is read at call time, so a redeploy picks up an edited value", () => {
		heldKnob = process.env.SIGNUP_POW_DIFFICULTY;
		touchedKnob = true;
		process.env.SIGNUP_POW_DIFFICULTY = "2";
		expect(signupPowDifficulty()).toBe(2);
	});
});

describe("issuing", () => {
	it("answers a puzzle the browser can grind, with the difficulty the knob names", async () => {
		const res = await app.request("/api/auth/signup/challenge");
		expect(res.status).toBe(200);
		const { id, challenge, difficulty } = (await res.json()) as {
			id: number;
			challenge: string;
			difficulty: number;
		};
		expect(id).toBeGreaterThan(0);
		// Difficulty 0 from the session's knob — the shape is what matters: a challenge
		// string long enough to be unguessable, and a difficulty the row carries.
		expect(challenge).toMatch(/^[0-9a-f]{32,}$/);
		expect(difficulty).toBe(0);
	});

	it("stores the difficulty on the row rather than reading it at verify time", async () => {
		heldKnob = process.env.SIGNUP_POW_DIFFICULTY;
		touchedKnob = true;
		const res = await app.request("/api/auth/signup/challenge");
		const { id } = (await res.json()) as { id: number };
		process.env.SIGNUP_POW_DIFFICULTY = "9";
		// A knob turned between issue and solve cannot retroactively void a puzzle
		// already in somebody's browser — the row still carries its own difficulty.
		const [row] = await db
			.select({ difficulty: signupChallenges.difficulty })
			.from(signupChallenges)
			.where(eq(signupChallenges.id, id));
		expect(row?.difficulty).toBe(0);
	});
});

describe("the gate on POST /signup/begin", () => {
	it("refuses without a proof, and the refusal is a distinguishable 400", async () => {
		const res = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			// No pow field at all, as a script that never fetched a challenge would post.
			body: JSON.stringify({ picks }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { reason?: string };
		expect(body.reason).toBe("pow_required");
	});

	it("refuses a replayed proof — a challenge is single-use", async () => {
		const { id, nonce } = await solvedChallenge();
		const first = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce }, picks }),
		});
		expect(first.status).toBe(200);

		// The same proof again: a script replaying one solve to press the button twice.
		const second = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce }, picks }),
		});
		expect(second.status).toBe(400);
		expect(((await second.json()) as { reason?: string }).reason).toBe("pow_required");
	});

	it("refuses a wrong nonce — re-hashing once is the whole server-side cost", async () => {
		// 🚨 Difficulty 0 accepts EVERY nonce by definition, so this test needs the knob
		// at 1 — 16 expected hashes, instant but real. The knob is set and restored.
		heldKnob = process.env.SIGNUP_POW_DIFFICULTY;
		touchedKnob = true;
		process.env.SIGNUP_POW_DIFFICULTY = "1";
		const { id, challenge } = await solvedChallenge();
		// A nonce whose digest does NOT start with 0 — the anti-solution.
		const { sha256Hex } = await import("@anthers/shared/signup-pow");
		let bad = 0;
		while ((await sha256Hex(`${challenge}${bad}`)).startsWith("0")) bad++;
		const res = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce: bad }, picks }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { reason?: string }).reason).toBe("pow_required");
	});

	it("refuses an expired challenge", async () => {
		const { id, nonce } = await solvedChallenge();
		await db
			.update(signupChallenges)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(signupChallenges.id, id));
		const res = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce }, picks }),
		});
		expect(res.status).toBe(400);
	});

	it("refuses a proof whose digest has too few zeros — difficulty is honored", async () => {
		// The honest way to test the wrong-difficulty refusal: issue at difficulty 0
		// (the session's knob), then plant difficulty 1 on the row by hand, and offer a
		// nonce whose digest does NOT start with 0 — the anti-solution. The server must
		// re-hash, count the zeros, and refuse.
		const { id, challenge } = await solvedChallenge();
		await db.update(signupChallenges).set({ difficulty: 1 }).where(eq(signupChallenges.id, id));
		// Find a nonce whose digest has no leading zero — half of them do.
		const { sha256Hex } = await import("@anthers/shared/signup-pow");
		let bad = 0;
		while (true) {
			if (!(await sha256Hex(`${challenge}${bad}`)).startsWith("0")) break;
			bad++;
		}
		const res = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce: bad }, picks }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { reason?: string }).reason).toBe("pow_required");
	});

	it("consumes the row even on a wrong nonce, so the grind cannot be skipped by guessing", async () => {
		// Difficulty 0 would accept any nonce, so the knob goes to 1 for the length of
		// this test — set and restored by the afterEach above.
		heldKnob = process.env.SIGNUP_POW_DIFFICULTY;
		touchedKnob = true;
		process.env.SIGNUP_POW_DIFFICULTY = "1";
		const { id, challenge } = await solvedChallenge();
		const { sha256Hex } = await import("@anthers/shared/signup-pow");
		let bad = 0;
		while ((await sha256Hex(`${challenge}${bad}`)).startsWith("0")) bad++;
		const check = await spendSignupChallenge(id, bad);
		expect(check).toEqual({ ok: false, reason: "wrong_nonce" });
		// The row is spent: a second attempt — even with the RIGHT nonce — reads as a
		// replay. A script cannot brute-force the verify endpoint one hash at a time.
		const good = Number(await solve(challenge, 1));
		const again = await spendSignupChallenge(id, good);
		expect(again).toEqual({ ok: false, reason: "already_spent" });
	});

	it("keeps the TTL at five minutes, so a puzzle is short-lived", () => {
		expect(SIGNUP_CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
	});
});

describe("the gate comes before the reservation", () => {
	it("a refused proof writes no pending signup", async () => {
		const { id, nonce } = await solvedChallenge();
		// Spend the proof out-of-band so the begin below replays it.
		await spendSignupChallenge(id, nonce);
		const before = await db.select({ token: pendingSignups.token }).from(pendingSignups);
		const res = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce }, picks }),
		});
		expect(res.status).toBe(400);
		const after = await db.select({ token: pendingSignups.token }).from(pendingSignups);
		expect(after.length).toBe(before.length);
	});
});

describe("difficulty 0 passes on the first hash", () => {
	it("solves instantly, which is the test-only setting and never the default", async () => {
		const { id, nonce } = await solvedChallenge();
		expect(nonce).toBe(0);
		const res = await app.request("/api/auth/signup/begin", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ pow: { id, nonce }, picks }),
		});
		expect(res.status).toBe(200);
	});
});

describe("the sweep", () => {
	it("removes consumed and expired rows, and only those", async () => {
		const spent = await issueSignupChallenge();
		await spendSignupChallenge(spent.id, 0);
		const fresh = await issueSignupChallenge();
		const stale = await issueSignupChallenge(new Date(Date.now() - 10 * 60 * 1000));

		const gone = await sweepSignupChallenges();
		expect(gone).toBeGreaterThanOrEqual(2);
		// The fresh, unconsumed row survives — the sweep is housekeeping, never the gate.
		const [row] = await db
			.select({ id: signupChallenges.id })
			.from(signupChallenges)
			.where(eq(signupChallenges.id, fresh.id));
		expect(row).toBeDefined();
		// The spent and stale ones are gone.
		for (const id of [spent.id, stale.id]) {
			const [goneRow] = await db
				.select({ id: signupChallenges.id })
				.from(signupChallenges)
				.where(eq(signupChallenges.id, id));
			expect(goneRow).toBeUndefined();
		}
	});
});
