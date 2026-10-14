// SPDX-License-Identifier: Apache-2.0
//
// The signing script's suite. The format contract it defines has a second
// implementation on the desktop side (`resolve-web.ts`'s verifier); this suite
// exercises the owning side, and a fixed-fixture test in the desktop repository
// asserts the two agree — so this suite proves the format is what it says, and the
// one over there proves the format is still what it was.

import { describe, expect, it } from "bun:test";
import { decodeKeyBlock, generateKeyPair, signBuffer, verifyBuffer } from "./sign-web-dist.ts";

describe("sign-web-dist", () => {
	const { privateKeyPem, publicKeyB64 } = generateKeyPair();
	const keyBlock = `untrusted comment: anthers web-dist Ed25519 signing key\n${publicKeyB64}\n`;
	const message = Buffer.from("the built web app, exactly as it was packed");

	it("signs so the same bytes verify against the raw base64 public key", () => {
		const sigB64 = signBuffer(message, privateKeyPem);
		const sigBlock = `untrusted comment: anthers web-dist Ed25519 signature\n${sigB64}\n`;
		expect(verifyBuffer(message, sigBlock, keyBlock)).toBe(true);
	});

	it("refuses bytes that changed after signing", () => {
		const sigB64 = signBuffer(message, privateKeyPem);
		const sigBlock = `untrusted comment: anthers web-dist Ed25519 signature\n${sigB64}\n`;
		const tampered = Buffer.concat([message, Buffer.from(" and one extra byte")]);
		expect(verifyBuffer(tampered, sigBlock, keyBlock)).toBe(false);
	});

	it("refuses a corrupted signature of the right size", () => {
		const sigB64 = signBuffer(message, privateKeyPem);
		const flipped = Buffer.from(sigB64, "base64");
		flipped[0] ^= 0x01;
		const sigBlock = `untrusted comment: anthers web-dist Ed25519 signature\n${flipped.toString("base64")}\n`;
		expect(verifyBuffer(message, sigBlock, keyBlock)).toBe(false);
	});

	it("rejects a signature block of the wrong size outright", () => {
		const shortBlock = `untrusted comment: anthers web-dist Ed25519 signature\n${Buffer.alloc(32).toString("base64")}\n`;
		expect(() => decodeKeyBlock(shortBlock, 64, "signature")).toThrow(/expected 64 bytes/);
	});

	it("refuses a signature from a different key", () => {
		const other = generateKeyPair();
		const sigB64 = signBuffer(message, other.privateKeyPem);
		const sigBlock = `untrusted comment: anthers web-dist Ed25519 signature\n${sigB64}\n`;
		expect(verifyBuffer(message, sigBlock, keyBlock)).toBe(false);
	});
});
