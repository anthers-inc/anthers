// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generating the recovery key somebody takes for an identity Anthers hosts.
 *
 * 🚨 **This runs in the browser and that is the whole point.** The key exists to let somebody
 * move their identity elsewhere without Anthers' cooperation and against its wishes if it came
 * to that — so a key Anthers generated, held for a moment, and posted back would be a key that
 * had been in Anthers' hands, which defeats the thing it is for. Nothing here touches the
 * network: the private half is shown once and never leaves this tab, and only the `did:key:`
 * public half is sent anywhere.
 *
 * ⚠️ **The format matches `generate-recovery-key.sh` in the anthers-node bundle exactly**, and
 * that is worth more than the bundle bytes it costs. The protocol would also accept a P-256
 * key, which a browser can make with WebCrypto and no library at all — but then somebody
 * holding an Anthers key would have a *different* kind of key from the one Anthers' own tooling
 * prints and documents, and every instruction about what to do with it would have to fork.
 * secp256k1, a 64-character hex private half, and a `did:key:zQ3s…` public half: one format,
 * one set of instructions, and what `@atproto/crypto` imports.
 *
 * ⚠️ **`@noble/curves` is a deliberate dependency**, and it is the same library `@atproto/crypto`
 * itself is built on rather than a third opinion about elliptic curves.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

/** The base58btc alphabet. Bitcoin's ordering, which is what multibase `z` means. */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * The multicodec prefix for a secp256k1 public key, varint-encoded.
 *
 * ⚠️ This is what makes the string start `zQ3s`, and getting it wrong produces a `did:key:`
 * that is well-formed, looks entirely correct, and resolves to nothing.
 */
const SECP256K1_PUB_PREFIX = Uint8Array.from([0xe7, 0x01]);

function base58btc(bytes: Uint8Array): string {
	let n = 0n;
	for (const byte of bytes) n = (n << 8n) | BigInt(byte);
	let out = "";
	while (n > 0n) {
		const rem = Number(n % 58n);
		n /= 58n;
		out = BASE58[rem] + out;
	}
	// Leading zero bytes are not encoded by the arithmetic above and are significant, so each
	// one becomes a literal "1". A prefixed key never has one; the loop is here because a
	// base58 encoder that quietly drops them is wrong in a way nothing downstream would catch.
	for (const byte of bytes) {
		if (byte !== 0) break;
		out = `1${out}`;
	}
	return out;
}

/** Turn a compressed secp256k1 public key into the `did:key:` that names it. */
export function didKeyFromCompressedPublicKey(compressed: Uint8Array): string {
	const prefixed = new Uint8Array(SECP256K1_PUB_PREFIX.length + compressed.length);
	prefixed.set(SECP256K1_PUB_PREFIX, 0);
	prefixed.set(compressed, SECP256K1_PUB_PREFIX.length);
	return `did:key:z${base58btc(prefixed)}`;
}

/**
 * A keypair whose public half is already encoded the way the protocol names it.
 *
 * ⚠️ **The private half is hex rather than anything cleverer** because that is what the node
 * bundle's own generator prints and what `@atproto/crypto`'s `Secp256k1Keypair.import` takes.
 * Somebody who keeps this should be able to use it with the ecosystem's tools without being
 * told about an Anthers-specific encoding first.
 */
export interface RecoveryKeypair {
	/** 64 hex characters — the raw 32-byte scalar. Shown once, never sent anywhere. */
	privateHex: string;
	/** `did:key:zQ3s…`. The only half that leaves this tab. */
	didKey: string;
}

/**
 * The known answer the encoder proves itself against before it is trusted with a real key.
 *
 * 🚨 **Copied from `generate-recovery-key.sh`, deliberately, so the two implementations are
 * pinned to the same vector.** The public half belongs to a throwaway keypair whose private
 * half was discarded; it is not a credential and encodes nothing secret.
 */
export const KNOWN_ANSWER = {
	compressedHex: "03530c4fa8214dc3fc07f011a3b9310d06bbd55dd9b00ff17e121e495c23863c54",
	didKey: "did:key:zQ3shkEHrW2UqqapTySPVtXC3HpndFZjWWYL3xTHzRBwA2923",
} as const;

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate the keypair, refusing if the encoder cannot reproduce a known answer first.
 *
 * 🚨 **The self-check is not ceremony, and it is the reason this function can throw.** A
 * `did:key:` that is subtly wrong does not fail — it is well-formed, it is accepted by
 * everything that looks at it, and it is discovered on the day somebody needs the key and
 * finds it signs for nothing. The cost of checking is one encode; the cost of not checking is
 * paid by the one person who most needed this to work. `generate-recovery-key.sh` makes the
 * same check for the same reason.
 */
export function generateRecoveryKey(): RecoveryKeypair {
	const check = didKeyFromCompressedPublicKey(hexToBytes(KNOWN_ANSWER.compressedHex));
	if (check !== KNOWN_ANSWER.didKey) {
		throw new Error(
			"The did:key encoder failed its own known-answer check, so no key was generated.",
		);
	}

	const secretKey = secp256k1.utils.randomSecretKey();
	const compressed = secp256k1.getPublicKey(secretKey, true);
	return {
		privateHex: bytesToHex(secretKey),
		didKey: didKeyFromCompressedPublicKey(compressed),
	};
}
