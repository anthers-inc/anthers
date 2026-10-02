// SPDX-License-Identifier: Apache-2.0
//
// The signup proof-of-work solver, tested as the pure function it is — the same module
// the SignupPage and the e2e harness use, so what is pinned here is the arithmetic the
// server re-checks, not a copy of it.
import { describe, expect, test } from "bun:test";
import { meetsDifficulty, sha256Hex, solve } from "./signup-pow.js";

describe("difficulty check", () => {
	test("demands exactly the leading zeros asked for, no fewer", () => {
		expect(meetsDifficulty("0abc", 1)).toBe(true);
		expect(meetsDifficulty("0abc", 2)).toBe(false);
		// The classic off-by-one that halves a script's cost: 3 zeros must not satisfy 4.
		expect(meetsDifficulty("000abc", 4)).toBe(false);
		expect(meetsDifficulty("0000abc", 4)).toBe(true);
	});

	test("passes everything at difficulty 0, which is the test-only setting", () => {
		expect(meetsDifficulty("ffffffff", 0)).toBe(true);
	});
});

describe("the solver", () => {
	test("returns a nonce whose digest carries the required zeros", async () => {
		const challenge = "e2e-challenge-token";
		const nonce = await solve(challenge, 3);
		expect(Number.isInteger(Number(nonce))).toBe(true);
		const digest = await sha256Hex(`${challenge}${nonce}`);
		expect(meetsDifficulty(digest, 3)).toBe(true);
	});

	test("solves difficulty 0 on the first hash, without grinding", async () => {
		// The shape test and browser sessions rely on: instant, one await.
		expect(await solve("anything", 0)).toBe("0");
	});

	test("is deterministic — the same challenge and difficulty find the same nonce", async () => {
		const challenge = "determinism-check";
		expect(await solve(challenge, 3)).toBe(await solve(challenge, 3));
	});
});
