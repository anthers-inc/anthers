// SPDX-License-Identifier: Apache-2.0
/**
 * A `did:key:` read for the one thing this API has to do with one: check a signature.
 *
 * The service-auth JWT a space authority sends is signed by the `#atproto` verification
 * method in its DID document, which is published as a multibase-encoded public key. The
 * protocol's signing keys are secp256k1 (`ES256K`); a P-256 key (`ES256`) is valid too, and
 * the curve a key names is read off its multicodec prefix rather than guessed from the
 * algorithm header, because the two have to agree.
 *
 * `@noble/curves` is already a dependency for the same reason `recovery-key.ts` records: it
 * is the library `@atproto/crypto` is built on, rather than a third opinion about elliptic
 * curves. WebCrypto cannot verify an `ES256K` signature at all, which rules it out here.
 */
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58Decode, base58Encode } from "./base58.js";

export type DidKeyCurve = "secp256k1" | "p256";

/** A decoded `did:key:` public key, or why it is not one. */
export type DecodedDidKey =
	| { curve: DidKeyCurve; publicKey: Uint8Array }
	| { curve: null; reason: "not-a-did-key" | "bad-multibase" | "unknown-curve" | "bad-point" };

/** The multicodec prefixes, varint-encoded, for the two curves atproto signs with. */
const MULTICODEC = {
	secp256k1: Uint8Array.from([0xe7, 0x01]),
	p256: Uint8Array.from([0x80, 0x24]),
} as const;

/** The compressed public-key length both curves share. */
const COMPRESSED_LENGTH = 33;

/** Name a compressed public key the way the protocol does, for a test or a tool. */
export function didKeyFromPublicKey(curve: DidKeyCurve, publicKey: Uint8Array): string {
	if (publicKey.length !== COMPRESSED_LENGTH) {
		throw new Error("a did:key names a compressed public key");
	}
	const prefix = MULTICODEC[curve];
	const prefixed = new Uint8Array(prefix.length + publicKey.length);
	prefixed.set(prefix, 0);
	prefixed.set(publicKey, prefix.length);
	return `did:key:z${base58Encode(prefixed)}`;
}

/**
 * Read a DID document's verification method as a `did:key:`.
 *
 * Two encodings are in the wild and both are the protocol's. `Multikey` carries a
 * multicodec-prefixed multibase, which is the modern form; the older
 * `EcdsaSecp256k1VerificationKey2019` / `EcdsaSecp256r1VerificationKey2019` types carry a raw
 * base58btc key with the curve named by the type — a 65-byte uncompressed SEC1 point — and
 * that is what the dev network's PLC directory publishes today. Read both rather than
 * choosing one: an authority is not less authoritative because its directory is older.
 */
export function didKeyFromVerificationMethod(method: {
	type?: string;
	publicKeyMultibase?: string;
}): string | null {
	const multibase = method.publicKeyMultibase;
	if (!multibase) return null;
	if (method.type === "Multikey") return `did:key:${multibase}`;

	const curve: DidKeyCurve | null =
		method.type === "EcdsaSecp256k1VerificationKey2019"
			? "secp256k1"
			: method.type === "EcdsaSecp256r1VerificationKey2019"
				? "p256"
				: null;
	if (!curve || !multibase.startsWith("z")) return null;

	const bytes = base58Decode(multibase.slice(1));
	if (bytes?.length !== 65 || bytes[0] !== 0x04) return null;
	try {
		const point = (curve === "p256" ? p256 : secp256k1).Point.fromBytes(bytes);
		return didKeyFromPublicKey(curve, point.toBytes(true));
	} catch {
		return null;
	}
}

/**
 * Decode a `did:key:` into its curve and compressed public key.
 *
 * A malformed key is reported rather than thrown: it arrives over the network, and the
 * caller's job is to refuse the request, not to distinguish one bad key from another.
 */
export function decodeDidKey(didKey: string): DecodedDidKey {
	if (!didKey.startsWith("did:key:z")) return { curve: null, reason: "not-a-did-key" };
	const decoded = base58Decode(didKey.slice("did:key:z".length));
	if (!decoded) return { curve: null, reason: "bad-multibase" };

	for (const [curve, prefix] of Object.entries(MULTICODEC) as [DidKeyCurve, Uint8Array][]) {
		if (decoded.length !== prefix.length + COMPRESSED_LENGTH) continue;
		if (!prefix.every((byte, index) => decoded[index] === byte)) continue;
		const publicKey = decoded.slice(prefix.length);
		try {
			// Throws for a point that is not on the curve, which no prefix check can make.
			(curve === "p256" ? p256 : secp256k1).Point.fromBytes(publicKey);
		} catch {
			return { curve: null, reason: "bad-point" };
		}
		return { curve, publicKey };
	}
	return { curve: null, reason: "unknown-curve" };
}

/**
 * Verify an ECDSA signature over the raw bytes that were signed.
 *
 * `lowS: false` matches the protocol's own service-auth verifier (`allowMalleableSig: true`):
 * every curve implementation is allowed to emit the high-S half, and refusing it would turn
 * a valid authority into an unreachable one for a reason nobody could see. The hash is
 * SHA-256 in both schemes, which is what `prehash`'s default does.
 */
export function verifyDidKeySignature(
	didKey: string,
	message: Uint8Array,
	signature: Uint8Array,
): boolean {
	const decoded = decodeDidKey(didKey);
	if (decoded.curve === null) return false;
	// A compact ECDSA signature is r || s, 32 bytes each.
	if (signature.length !== 64) return false;
	const curve = decoded.curve === "p256" ? p256 : secp256k1;
	try {
		return curve.verify(signature, message, decoded.publicKey, {
			lowS: false,
			format: "compact",
		});
	} catch {
		return false;
	}
}
