// SPDX-License-Identifier: Apache-2.0
/**
 * The seal on a stored credential.
 *
 * 🚨 **The test that matters is the one that fails to open, not the one that opens.** A
 * round-trip test passes for `aes-256-cbc` too, and CBC would let whoever can write the column
 * choose what the plaintext decrypts to — which for a stored password means choosing a
 * password. The authentication tag is the whole point, so tampering is what gets the coverage.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const before = process.env.HOSTED_ACCOUNT_KEY;

beforeAll(() => {
	process.env.HOSTED_ACCOUNT_KEY = KEY_A;
});

// `bun test` runs every file in one process, so a key left set here is a key the rest of the
// suite runs under. See `hosted-accounts.test.ts` for the hazard that closes.
afterAll(() => {
	if (before === undefined) delete process.env.HOSTED_ACCOUNT_KEY;
	else process.env.HOSTED_ACCOUNT_KEY = before;
});

const { open, seal, secretBoxConfigured } = await import("../services/secret-box.js");

describe("secret-box", () => {
	it("opens what it sealed", () => {
		expect(open(seal("hunter2"))).toBe("hunter2");
	});

	// Two seals of the same value must not look alike, or the column tells you which accounts
	// share a password.
	it("seals the same value differently every time", () => {
		expect(seal("same")).not.toBe(seal("same"));
	});

	it("refuses a value whose ciphertext was changed", () => {
		const sealed = seal("hunter2");
		const [v, iv, tag, body] = sealed.split(".");
		const flipped = Buffer.from(body, "base64url");
		flipped[0] ^= 0xff;
		expect(() => open([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
	});

	it("refuses a value whose tag was changed", () => {
		const [v, iv, tag, body] = seal("hunter2").split(".");
		const flipped = Buffer.from(tag, "base64url");
		flipped[0] ^= 0xff;
		expect(() => open([v, flipped.toString("base64url"), tag, body].join("."))).toThrow();
	});

	it("refuses a value that is not in the expected form", () => {
		expect(() => open("not-sealed")).toThrow();
		expect(() => open("v2.a.b.c")).toThrow();
	});

	// ⭐ The property the whole arrangement is for: a copy of the database without the key is
	// a copy of nothing.
	it("cannot be opened with a different key", () => {
		const sealed = seal("hunter2");
		process.env.HOSTED_ACCOUNT_KEY = KEY_B;
		expect(() => open(sealed)).toThrow();
		process.env.HOSTED_ACCOUNT_KEY = KEY_A;
		expect(open(sealed)).toBe("hunter2");
	});

	it("reports a missing or wrong-length key rather than using one", () => {
		process.env.HOSTED_ACCOUNT_KEY = "";
		expect(secretBoxConfigured()).toBe(false);
		process.env.HOSTED_ACCOUNT_KEY = "abcd";
		expect(secretBoxConfigured()).toBe(false);
		process.env.HOSTED_ACCOUNT_KEY = KEY_A;
		expect(secretBoxConfigured()).toBe(true);
	});
});
