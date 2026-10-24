// SPDX-License-Identifier: Apache-2.0
/**
 * Anthers' signature over the two access artifacts: the receipt in the reader's space and
 * the short-lived grant delivery checks.
 *
 * ⭐ **One issuer, one key, one published JWKS.** A receipt says a transaction happened and a
 * grant says a Work opens now; both are Anthers speaking about access, so a verifier learns
 * one key and checks both. The key is separate from the OAuth client's attestation key on
 * purpose: that key proves the app to a space authority, this one proves Anthers to whoever
 * holds a receipt, and rotating one must not invalidate the other.
 *
 * 🚨 **Canonical JSON is part of the format, not a serialization detail.** A space record is
 * stored as CBOR and read back as a JSON object, so key order is not stable across a write.
 * What is signed is the recursively key-sorted form, and a verifier canonicalizes the payload
 * it received before checking the signature. Signing `JSON.stringify` of the live object
 * would verify against one serializer and fail against another with no content change.
 *
 * ⚠️ **A deployment without `ACCESS_SIGNING_JWK` signs nothing.** The environment value is a
 * private EC P-256 JWK filed in Bitwarden Secrets; its public half is derived here and served
 * at `/api/content/access/issuer.json`, so the metadata can never describe a key different
 * from the one that signs. A checkout with no filed key generates one per process, which is
 * enough for tests and `make dev` and is why a receipt written from a bare checkout stops
 * verifying after a restart.
 */
import { p256 } from "@noble/curves/nist.js";
import { deploymentOrigin, isPublicDeployment } from "../lib/deployment.js";

export interface AccessPublicJwk {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
	kid: string;
	alg: "ES256";
	use: "sig";
}

export interface AccessSigningKey {
	secretKey: Uint8Array;
	/** Uncompressed 65-byte SEC1 point, the form the verifier needs. */
	publicKey: Uint8Array;
	publicJwk: AccessPublicJwk;
}

/** Thrown when this process has no key to sign an access artifact with. */
export class AccessSigningUnavailable extends Error {
	constructor() {
		super("ACCESS_SIGNING_JWK is not configured, so no access artifact can be signed");
		this.name = "AccessSigningUnavailable";
	}
}

let cached: AccessSigningKey | null | undefined;

/** This process's signing key, or null when it has none it can publish. */
export function accessSigningKey(): AccessSigningKey | null {
	if (cached !== undefined) return cached;
	const raw = process.env.ACCESS_SIGNING_JWK?.trim();
	if (raw) {
		try {
			cached = fromPrivateJwk(JSON.parse(raw) as Record<string, unknown>);
			return cached;
		} catch (error) {
			console.error(
				`[access-signing] ACCESS_SIGNING_JWK is not a usable P-256 JWK: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			);
			cached = null;
			return null;
		}
	}
	if (isPublicDeployment()) {
		cached = null;
		return null;
	}
	const secretKey = p256.utils.randomSecretKey();
	const publicKey = p256.getPublicKey(secretKey, false);
	cached = fromPrivateJwk({
		kty: "EC",
		crv: "P-256",
		x: Buffer.from(publicKey.slice(1, 33)).toString("base64url"),
		y: Buffer.from(publicKey.slice(33)).toString("base64url"),
		d: Buffer.from(secretKey).toString("base64url"),
		kid: "anthers-access-dev-ephemeral",
	});
	return cached;
}

/** The document a verifier fetches to check a receipt, or null when nothing can be published. */
export function accessIssuerDocument(): { keys: AccessPublicJwk[] } | null {
	const key = accessSigningKey();
	return key ? { keys: [key.publicJwk] } : null;
}

/** The origin a receipt names as its issuer, where the JWKS is served. */
export function accessIssuerOrigin(): string {
	return deploymentOrigin() ?? "http://localhost:8000";
}

/**
 * Sign one payload and return both the key id and the base64url signature.
 *
 * The payload is canonicalized here so every caller signs the same bytes; nothing hands this
 * function a pre-serialized string.
 */
export function signAccessPayload(payload: Record<string, unknown>): {
	keyId: string;
	signature: string;
} {
	const key = accessSigningKey();
	if (!key) throw new AccessSigningUnavailable();
	const bytes = utf8(canonicalJson(payload));
	const signature = p256.sign(bytes, key.secretKey, { lowS: true });
	return { keyId: key.publicJwk.kid, signature: Buffer.from(signature).toString("base64url") };
}

/** Whether a signature covers this payload under the given key. */
export function verifyAccessPayload(
	payload: unknown,
	signature: string,
	publicKey: Uint8Array,
): boolean {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(Buffer.from(signature, "base64url"));
	} catch {
		return false;
	}
	if (bytes.length !== 64) return false;
	try {
		return p256.verify(bytes, utf8(canonicalJson(payload)), publicKey);
	} catch {
		return false;
	}
}

/**
 * A JSON serialization with every object's keys sorted, recursively.
 *
 * Arrays keep their order: it is data, not a set. This is the whole of the canonical form —
 * enough for the objects these payloads contain, and nothing a second implementation cannot
 * reproduce.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function fromPrivateJwk(jwk: Record<string, unknown>): AccessSigningKey {
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
		throw new Error("expected an EC P-256 private JWK");
	}
	const secretKey = new Uint8Array(Buffer.from(jwk.d, "base64url"));
	const publicKey = p256.getPublicKey(secretKey, false);
	return {
		secretKey,
		publicKey,
		publicJwk: {
			kty: "EC",
			crv: "P-256",
			x: Buffer.from(publicKey.slice(1, 33)).toString("base64url"),
			y: Buffer.from(publicKey.slice(33)).toString("base64url"),
			kid: typeof jwk.kid === "string" && jwk.kid ? jwk.kid : "anthers-access",
			alg: "ES256",
			use: "sig",
		},
	};
}

/** Test seam: forget the cached key after changing the environment. */
export function resetAccessSigningKeyForTesting(): void {
	cached = undefined;
}
