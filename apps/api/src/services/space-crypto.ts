// SPDX-License-Identifier: Apache-2.0
/**
 * The reader's half of a gated space read: the client attestation, the request signature, the
 * key share, and the MAC check.
 *
 * ⭐ **These are the protocol's wire formats, ported rather than guessed.** The branch's
 * `@atproto/space` package is where they live upstream, but it is not published — it depends on
 * an atproto branch whose PDS does not ship yet — and pulling it into the app would pin a draft.
 * What this module copies is the small, stable part: a client attestation is a `private_key_jwt`
 * with a fixed `typ`; a request covers exactly `authorization` and `atproto-space-audience`; and
 * a MAC is HMAC-SHA256 over a length-prefixed context plus the record's CID, keyed by a secret
 * derived with DHKEM(P-256, HKDF-SHA256). The lab's 05 and 11 are the regression set that says
 * whether the copies still match.
 *
 * 🚨 **The MAC is the read's proof, not a decoration.** A space record's bytes come from one
 * server, and the MAC is the only thing that ties them to the URI and CID the reader asked for.
 * A read that skips it is a read of whatever the connection answered.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { base58Decode } from "../lib/base58.js";
import { decodeDidKey, didKeyFromPublicKey } from "../lib/did-key.js";

/** The MAC a record read carries, and the header names it uses. */
export const RECORD_MAC_TYPE = "atproto-space-record";
export const WANT_MAC_HEADER = "atproto-space-want-mac";
export const MAC_HEADER = "atproto-space-mac";

/** The HTTP Message Signature label and tag the credential's use carries. */
const SIGNATURE_LABEL = "atproto-space-credential";
const SIGNATURE_TAG = "atproto-space-credential";

/** The attestation's JWT type, from the branch's `SPACE_TOKEN_TYPES`. */
export const CLIENT_ATTESTATION_TYP = "atproto-client-attestation+jwt";

/** A P-256 key as the credential needs it: the secret, its compressed public half, its did:key. */
export interface P256Key {
	secretKey: Uint8Array;
	publicKey: Uint8Array;
	didKey: string;
}

export function generateP256Key(): P256Key {
	const secretKey = p256.utils.randomSecretKey();
	const publicKey = p256.getPublicKey(secretKey, true);
	return { secretKey, publicKey, didKey: didKeyFromPublicKey("p256", publicKey) };
}

/** The audience a space token is addressed to: the authority's PDS, per the branch. */
export function spaceHostAud(spaceDid: string): string {
	return `${spaceDid}#atproto_pds`;
}

/**
 * Mint a client attestation for one space host.
 *
 * `iss` and `sub` are both the client id — the protocol requires them equal — and `aud` is the
 * creator's `#atproto_pds`, so an attestation minted for one authority cannot be replayed at
 * another. Sixty seconds is the branch's lifetime and the PDS's replay window.
 */
export function mintClientAttestation(input: {
	clientId: string;
	kid: string;
	secretKey: Uint8Array;
	spaceDid: string;
	now?: Date;
}): string {
	const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const header = { alg: "ES256", typ: CLIENT_ATTESTATION_TYP, kid: input.kid };
	const payload = {
		iss: input.clientId,
		sub: input.clientId,
		aud: spaceHostAud(input.spaceDid),
		jti: crypto.randomUUID(),
		iat: issuedAt,
		exp: issuedAt + 60,
	};
	const signingInput = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(payload)))}`;
	const signature = p256.sign(new TextEncoder().encode(signingInput), input.secretKey, {
		lowS: true,
	});
	return `${signingInput}.${base64url(signature)}`;
}

/**
 * The headers a request authorized by a space credential carries.
 *
 * A space credential is not a bearer token: it is a JWT bound to a P-256 key, and the request
 * proves possession by signing exactly the credential and the audience DID. The signature input
 * carries only the covered list and the tag — the branch's signer adds no `created` or `keyid`,
 * and the verifier accepts their absence.
 */
export function signSpaceRequest(
	key: P256Key,
	opts: { authorization: string; audience: string },
): Record<string, string> {
	const components: Array<[string, string]> = [
		["authorization", opts.authorization],
		["atproto-space-audience", opts.audience],
	];
	const signatureInput = `(${components.map(([name]) => `"${name}"`).join(" ")});tag="${SIGNATURE_TAG}"`;
	const lines = components.map(([name, value]) => `"${name}": ${value.trim()}`);
	lines.push(`"@signature-params": ${signatureInput}`);
	const signature = p256.sign(new TextEncoder().encode(lines.join("\n")), key.secretKey, {
		lowS: true,
	});
	return {
		authorization: opts.authorization,
		"atproto-space-audience": opts.audience,
		"signature-input": `${SIGNATURE_LABEL}=${signatureInput}`,
		signature: `${SIGNATURE_LABEL}=:${Buffer.from(signature).toString("base64")}:`,
	};
}

/** The `Atproto-Space-Want-Mac` request header, as the branch serializes it. */
export function formatWantMacHeader(keyShare: string): string {
	return `type="${RECORD_MAC_TYPE}", ver=1, key_share="${keyShare}"`;
}

/**
 * The key share and shared secret for one read.
 *
 * The author's `#atproto_kem` key is published in their DID document. The reader makes an
 * ephemeral keypair, sends its public half, and derives the same secret the server will from
 * its private half — DHKEM(P-256, HKDF-SHA256), RFC 9180 §4.1. A fresh keypair per request is
 * what keeps a captured MAC from meaning anything later.
 */
export function encapsulate(authorKemDidKey: string): {
	keyShare: string;
	sharedSecret: Uint8Array;
} {
	const author = decodeDidKey(authorKemDidKey);
	if (author.curve !== "p256") throw new Error("the author's KEM key is not a P-256 did:key");
	const ephemeral = generateP256Key();
	// 🚨 **The KEM context carries the UNCOMPRESSED points.** The did:key is compressed, but
	// DHKEM's `shared_secret` info is built from the 65-byte SEC1 encodings on both sides — the
	// branch's `parseDidKey` decompresses before it derives, and using the compressed form here
	// produces a different 32 bytes that fails the MAC with no other symptom.
	const authorUncompressed = p256.Point.fromBytes(author.publicKey).toBytes(false);
	const ephemeralUncompressed = p256.getPublicKey(ephemeral.secretKey, false);
	const dh = p256.getSharedSecret(ephemeral.secretKey, authorUncompressed, true).slice(1);
	const kemPrefix = concat([utf8("HPKE-v1"), utf8("KEM"), uint16be(0x0010)]);
	const input = concat([kemPrefix, utf8("eae_prk"), dh]);
	const info = concat([
		uint16be(32),
		kemPrefix,
		utf8("shared_secret"),
		ephemeralUncompressed,
		authorUncompressed,
	]);
	return {
		keyShare: ephemeral.didKey,
		sharedSecret: new Uint8Array(hkdfSync("sha256", input, new Uint8Array(0), info, 32)),
	};
}

/** The `Atproto-Space-Mac` response header's MAC, validated for type and version. */
export function parseRecordMacHeader(value: string | null): Uint8Array {
	if (!value) throw new Error("the response carried no MAC");
	const type = /(?:^|,\s*)type="([^"]+)"/.exec(value)?.[1];
	const version = /(?:^|,\s*)ver=(\d+)/.exec(value)?.[1];
	const mac = /(?:^|,\s*)mac=:([^:]+):/.exec(value)?.[1];
	if (type !== RECORD_MAC_TYPE) throw new Error(`unexpected MAC type ${String(type)}`);
	if (version !== "1") throw new Error(`unexpected MAC version ${String(version)}`);
	if (!mac) throw new Error("the response MAC is malformed");
	return new Uint8Array(Buffer.from(mac, "base64"));
}

/**
 * Whether a MAC covers this record's URI and CID under the request's shared secret.
 *
 * Context: `"atproto-space-record-v1" || uint16be(len(uri)) || uri`, then the CID's own bytes.
 */
export function verifyRecordMac(
	sharedSecret: Uint8Array,
	uri: string,
	cid: string,
	mac: Uint8Array,
): boolean {
	const cidValue = cidBytes(cid);
	if (!cidValue) return false;
	const context = concat([utf8(`${RECORD_MAC_TYPE}-v1`), lengthPrefixed(uri)]);
	const expected = createHmac("sha256", sharedSecret)
		.update(concat([context, cidValue]))
		.digest();
	return expected.length === mac.length && timingSafeEqual(expected, mac);
}

/**
 * A CID string's bytes, which is what the MAC covers.
 *
 * ⚠️ **The bytes are the whole CID, version and codec included, not its multihash.** A base32
 * `b…` CIDv1 is the common case in a repository; the legacy base58 `Qm…` form is read too so a
 * record written before the current CID version is not reported as a forged one.
 */
export function cidBytes(cid: string): Uint8Array | null {
	if (cid.startsWith("b")) return base32Decode(cid.slice(1));
	if (cid.startsWith("Qm")) return base58Decode(cid);
	return null;
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function uint16be(value: number): Uint8Array {
	return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function lengthPrefixed(value: string): Uint8Array {
	const bytes = utf8(value);
	return concat([uint16be(bytes.length), bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** RFC 4648 base32, lowercase, no padding — the multibase a `b…` CID uses. */
function base32Decode(value: string): Uint8Array | null {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	const bits: number[] = [];
	for (const char of value.toLowerCase()) {
		const index = alphabet.indexOf(char);
		if (index === -1) return null;
		for (let shift = 4; shift >= 0; shift--) bits.push((index >> shift) & 1);
	}
	const bytes = new Uint8Array(Math.floor(bits.length / 8));
	for (let i = 0; i < bytes.length; i++) {
		let byte = 0;
		for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | (bits[i * 8 + bit] ?? 0);
		bytes[i] = byte;
	}
	return bytes;
}
