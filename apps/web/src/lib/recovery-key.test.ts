// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The recovery key's encoding, which is the half that fails silently.
 *
 * 🚨 **A wrong `did:key:` does not throw anywhere.** It is well-formed, it goes into a PLC
 * operation, the operation is accepted, and the identity ends up carrying a rotation key that
 * names nothing — discovered by the one person who needed it, on the day they needed it. So
 * the assertions here are about the exact bytes rather than about the shape of the string.
 *
 * ⚠️ **The vector is shared with `generate-recovery-key.sh` in the anthers-node bundle**, which
 * verifies its own encoder against the same pair before generating anything. Two
 * implementations pinned to one known answer is the point; if this vector is ever changed,
 * change it in both or they stop being a check on each other.
 */
import { describe, expect, it } from "bun:test";
import {
	didKeyFromCompressedPublicKey,
	generateRecoveryKey,
	KNOWN_ANSWER,
} from "./recovery-key.js";

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

describe("encoding a public key as a did:key", () => {
	it("reproduces the vector the node bundle's generator checks itself against", () => {
		expect(didKeyFromCompressedPublicKey(hexToBytes(KNOWN_ANSWER.compressedHex))).toBe(
			KNOWN_ANSWER.didKey,
		);
	});

	// ⚠️ The prefix is what makes a secp256k1 key say `zQ3s`. A key encoded with the wrong
	// multicodec — or none — still base58s into something that looks like a did:key.
	it("puts a secp256k1 key in the zQ3s space, which is how the curve is read back", () => {
		const did = didKeyFromCompressedPublicKey(hexToBytes(KNOWN_ANSWER.compressedHex));
		expect(did.startsWith("did:key:zQ3s")).toBe(true);
	});

	it("does not drop a leading zero byte, which base58 arithmetic alone would lose", () => {
		// Not a real key — this exercises the branch that exists only for leading zeros, which
		// no valid prefixed secp256k1 key reaches and which is silently wrong without it.
		const withZero = new Uint8Array([0, 0, 1]);
		const encoded = didKeyFromCompressedPublicKey(withZero);
		// Two zero bytes of the *input* are two "1"s, after the prefix's own contribution.
		expect(encoded.startsWith("did:key:z")).toBe(true);
		expect(didKeyFromCompressedPublicKey(new Uint8Array([1]))).not.toBe(encoded);
	});
});

describe("generating a keypair", () => {
	it("gives a 64-character hex private half, which is what the ecosystem's tools import", () => {
		const { privateHex } = generateRecoveryKey();
		expect(privateHex).toMatch(/^[0-9a-f]{64}$/);
	});

	it("gives a public half in the same space as the node bundle's generator", () => {
		const { didKey } = generateRecoveryKey();
		expect(didKey.startsWith("did:key:zQ3s")).toBe(true);
	});

	// 🚨 Two people asking on the same afternoon must not receive the same key, and a
	// generator that returned a constant would pass every other assertion here.
	it("gives a different key every time", () => {
		const keys = new Set(Array.from({ length: 5 }, () => generateRecoveryKey().privateHex));
		expect(keys.size).toBe(5);
	});

	it("derives the public half from the private half rather than inventing one", async () => {
		const { privateHex, didKey } = generateRecoveryKey();
		const { secp256k1 } = await import("@noble/curves/secp256k1.js");
		const rederived = didKeyFromCompressedPublicKey(
			secp256k1.getPublicKey(hexToBytes(privateHex), true),
		);
		expect(rederived).toBe(didKey);
	});
});
