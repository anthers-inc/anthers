// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pins `isEmptySecret` — the predicate the 2026-08-15 secret clobber turned on.
 *
 * The blobs here are SYNTHESIZED rather than copied from the incident. They only have to be
 * the right *shape*, and production secret ciphertext does not belong in a repository that
 * is going public, however undecryptable it is without DigitalOcean's key. The lengths are
 * the ones actually measured that day: every clobbered secret rendered as 63 characters and
 * the shortest genuine one as 75.
 */

import { describe, expect, test } from "bun:test";
import { isEmptySecret, secretPlaintextLength } from "./do-spec";

/** `EV[1:<24-byte nonce>:<sealed box>]`, where the box is a 16-byte GCM tag + ciphertext. */
function ev(plaintextBytes: number): string {
	const nonce = Buffer.alloc(24, 7).toString("base64");
	const box = Buffer.alloc(16 + plaintextBytes, 9).toString("base64");
	return `EV[1:${nonce}:${box}]`;
}

describe("isEmptySecret", () => {
	test("a sealed box of exactly the tag length held no plaintext", () => {
		expect(isEmptySecret({ key: "STORAGE_KEY", type: "SECRET", value: ev(0) })).toBe(true);
	});

	test("one byte of plaintext is not empty", () => {
		expect(isEmptySecret({ key: "STORAGE_KEY", type: "SECRET", value: ev(1) })).toBe(false);
	});

	test("a realistic credential is not empty", () => {
		// R2's access key id is 32 chars; STRIPE_SECRET_KEY was the longest at ~107.
		for (const n of [32, 64, 107]) {
			expect(isEmptySecret({ key: "K", type: "SECRET", value: ev(n) })).toBe(false);
		}
	});

	test("the lengths measured during the incident", () => {
		// Not an assertion about our encoder — an assertion that the 63/75 split observed in
		// production falls either side of the boundary this predicate draws.
		expect(ev(0)).toHaveLength(63);
		expect(isEmptySecret({ key: "K", value: ev(0) })).toBe(true);
		expect(isEmptySecret({ key: "K", value: ev(9) })).toBe(false); // 75 chars, the shortest real one
		expect(ev(9)).toHaveLength(75);
	});

	test("a non-secret value is never reported empty", () => {
		expect(isEmptySecret({ key: "STORAGE_REGION", value: "auto" })).toBe(false);
		expect(isEmptySecret({ key: "STORAGE_REGION", value: "" })).toBe(false);
	});

	/**
	 * The committed spec's own shape. It is *supposed* to be valueless — that is the whole
	 * design — so it must not trip the check, or `spec-diff` would flag `.do/app.yaml` on
	 * every run and get switched off. Only the LIVE side is ever asked this question.
	 */
	test("a valueless committed SECRET declaration is not an empty live secret", () => {
		expect(isEmptySecret({ key: "STORAGE_KEY", type: "SECRET" })).toBe(false);
	});

	test("a malformed blob is not guessed at", () => {
		expect(isEmptySecret({ key: "K", value: "EV[1:only-two-fields]" })).toBe(false);
		expect(isEmptySecret({ key: "K", value: "EV[" })).toBe(false);
	});
});

describe("secretPlaintextLength", () => {
	test("recovers the plaintext length without the key", () => {
		for (const n of [0, 1, 9, 32, 64, 107]) {
			expect(secretPlaintextLength({ key: "K", value: ev(n) })).toBe(n);
		}
	});

	test("null when there is nothing to measure", () => {
		expect(secretPlaintextLength({ key: "K", value: "auto" })).toBeNull();
		expect(secretPlaintextLength({ key: "K", type: "SECRET" })).toBeNull();
		expect(secretPlaintextLength({})).toBeNull();
	});

	/**
	 * The case `spec-apply --from-env` exists to catch: a vault entry that has drifted from
	 * what production holds. This is the whole reason the length is worth computing — it
	 * turns "I hope Bitwarden matches prod" into a check that runs before the apply.
	 */
	test("a differing length flags a value that would change production", () => {
		const live = { key: "RESEND_API_KEY", value: ev(36) };
		expect(secretPlaintextLength(live)).not.toBe(Buffer.byteLength("x".repeat(35)));
		expect(secretPlaintextLength(live)).toBe(Buffer.byteLength("x".repeat(36)));
	});

	/** And the limit of the technique, stated as a test so nobody over-reads the signal. */
	test("equal length does NOT mean equal value", () => {
		expect(secretPlaintextLength({ key: "K", value: ev(11) })).toBe(
			Buffer.byteLength("open-sesame"),
		);
		expect(secretPlaintextLength({ key: "K", value: ev(11) })).toBe(
			Buffer.byteLength("hunter2xxxx"),
		);
	});
});
