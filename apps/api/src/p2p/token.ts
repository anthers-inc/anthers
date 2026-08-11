// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery token — Ed25519 asymmetric signing (per 45.05 Peer-Auth Protocol Spec).
 *
 * The hub signs with an Ed25519 private key; peers verify with the corresponding public
 * key. The private key never leaves the hub, so any peer that can verify a token cannot
 * mint one. This is the multi-peer upgrade from the spike's HMAC-SHA256 (symmetric)
 * scheme, which only worked when the hub was the sole verifier.
 *
 * The token attests: "this peer (userId) is entitled to download this asset (assetId)
 * on this Work (workId), until this time (exp)." That is the full extent of the
 * attestation — no runtime auth, no chunk encryption, no DRM. See 45.05 § No chunk
 * encryption for the deliberate non-decision.
 *
 * Format: <base64url-payload>.<base64url-signature>
 *   payload: JSON { w, a, u, e, k? } — short field names to keep the token compact
 *   signature: Ed25519 over the base64url payload string (the bytes before the dot)
 *
 * This is deliberately NOT a JWT: no header, no algorithm negotiation, no third-party
 * library. One signing algorithm (Ed25519), fixed, with no algorithm-selection surface.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import {
	P2P_TOKEN_TTL_SECONDS,
	type P2pTokenPayload,
	verifyP2pToken as verifySharedToken,
} from "@anthers/shared/p2p-token";

/** Re-exported so existing importers keep one import site. */
export { P2P_TOKEN_TTL_SECONDS, type P2pTokenPayload };

/** Key ID for the initial signing key. Increment on rotation. */
const CURRENT_KEY_ID = 1;

// ── base64url helpers ────────────────────────────────────────────────────────

function b64urlEncode(data: Uint8Array): string {
	return Buffer.from(data).toString("base64url");
}

function b64urlDecode(str: string): Uint8Array {
	return Buffer.from(str, "base64url");
}

// ── Key management ───────────────────────────────────────────────────────────

let cachedPrivateKey: CryptoKey | null = null;
let cachedPublicKeyBytes: Uint8Array | null = null;

/**
 * The hub's Ed25519 private key, base64url-encoded PKCS8 DER.
 * Generate one with `generateKeyPair()` and set it as `P2P_HUB_PRIVATE_KEY`.
 */
function getPrivateKeyB64(): string | null {
	return process.env.P2P_HUB_PRIVATE_KEY ?? null;
}

/** Generate a new Ed25519 keypair (for bootstrapping or tests). */
export async function generateKeyPair(): Promise<{
	privateKeyB64: string;
	publicKeyB64: string;
}> {
	const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	const rawPriv = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
	const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
	return {
		privateKeyB64: b64urlEncode(new Uint8Array(rawPriv)),
		publicKeyB64: b64urlEncode(new Uint8Array(rawPub)),
	};
}

async function getSigningKey(): Promise<CryptoKey> {
	if (cachedPrivateKey) return cachedPrivateKey;
	const b64 = getPrivateKeyB64();
	if (!b64) {
		throw new Error(
			"P2P_HUB_PRIVATE_KEY not set. Generate one with generateKeyPair() and set the env var.",
		);
	}
	const keyBytes = b64urlDecode(b64);
	cachedPrivateKey = await crypto.subtle.importKey(
		"pkcs8",
		keyBytes as BufferSource,
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	return cachedPrivateKey;
}

/**
 * Derive the public key from the private key using Node crypto, since Web Crypto
 * doesn't let you extract a public key from a non-extractable private key.
 */
async function derivePublicKeyBytes(): Promise<Uint8Array> {
	if (cachedPublicKeyBytes) return cachedPublicKeyBytes;
	const b64 = getPrivateKeyB64();
	if (!b64) {
		throw new Error("P2P_HUB_PRIVATE_KEY not set — cannot derive public key.");
	}
	const keyBytes = b64urlDecode(b64);
	const nodePriv = createPrivateKey({ key: Buffer.from(keyBytes), format: "der", type: "pkcs8" });
	const nodePub = createPublicKey(nodePriv);
	const spki = nodePub.export({ type: "spki", format: "der" });
	cachedPublicKeyBytes = new Uint8Array(spki).slice(-32);
	return cachedPublicKeyBytes;
}

/** The public key bytes (32 bytes, base64url) for distribution to peers. */
export async function getPublicKeyB64(): Promise<string> {
	const pubBytes = await derivePublicKeyBytes();
	return b64urlEncode(pubBytes);
}

// ── Token minting ───────────────────────────────────────────────────────────

/** Mint a short-lived P2P delivery token for one asset on one Work for one user. */
export async function mintP2pToken(params: {
	workId: number;
	assetId: number;
	userId: number;
	ttlSeconds?: number;
}): Promise<string> {
	const { workId, assetId, userId, ttlSeconds = P2P_TOKEN_TTL_SECONDS } = params;
	const payload: P2pTokenPayload = {
		w: workId,
		a: assetId,
		u: userId,
		e: Math.floor(Date.now() / 1000) + ttlSeconds,
		k: CURRENT_KEY_ID,
	};
	const payloadJson = JSON.stringify(payload);
	const payloadB64 = b64urlEncode(new TextEncoder().encode(payloadJson));
	const signingKey = await getSigningKey();
	const signature = await crypto.subtle.sign(
		"Ed25519",
		signingKey,
		new TextEncoder().encode(payloadB64) as BufferSource,
	);
	const sigB64 = b64urlEncode(new Uint8Array(signature));
	return `${payloadB64}.${sigB64}`;
}

// ── Token verification ───────────────────────────────────────────────────────

/**
 * Verification now lives in `@anthers/shared/p2p-token`, because the hub is not its only
 * caller: 45.05's "both sides check" means a serving peer runs the same check, and a
 * verifier that drifted a shade more permissive on the peer would be a hole exactly where
 * nobody looks. One implementation, imported by both.
 *
 * This wrapper exists only to supply the hub's own public key, which the hub can derive
 * from its private key and a peer must fetch over TLS.
 */
export type VerifiedToken = P2pTokenPayload;

export async function verifyP2pToken(
	token: string,
	publicKeyB64?: string,
): Promise<VerifiedToken | null> {
	const pub = publicKeyB64 ?? (await getPublicKeyB64());
	return verifySharedToken(token, pub);
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Set the private key directly (for tests). Pass a base64url PKCS8 DER key.
 * Resets cached keys.
 */
export function _setPrivateKeyForTest(b64: string): void {
	process.env.P2P_HUB_PRIVATE_KEY = b64;
	cachedPrivateKey = null;
	cachedPublicKeyBytes = null;
}

/** Reset all cached key state (for test isolation). */
export function _resetKeyCache(): void {
	cachedPrivateKey = null;
	cachedPublicKeyBytes = null;
}
