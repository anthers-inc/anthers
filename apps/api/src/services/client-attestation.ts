// SPDX-License-Identifier: Apache-2.0
/**
 * The app's own key: the P-256 private half an OAuth client mints client attestations with.
 *
 * ⭐ **The key is the app's identity to a space authority, not a reader's secret.** A space
 * names Anthers in its `appAccess` allow-list by the client id; the authority verifies the
 * attestation against the JWKS published in this app's client metadata and hands the verified
 * id to `checkUserAccess`. The reader's own credential is a different key, generated per read
 * and never stored — see `space-credential.ts`.
 *
 * 🚨 **The private half lives in Bitwarden Secrets and reaches this process as an environment
 * value.** `ATPROTO_CLIENT_JWK` is a private EC JWK, filed in both the dev and prod projects;
 * the public half is derived here and published in the metadata document. A deployment without
 * it publishes no `jwks` and refuses to attest rather than minting something unverifiable.
 * A checkout generates an ephemeral key so tests and `make dev` are self-consistent, but a
 * restart then changes the published key, and the authority's metadata cache holds the old one
 * for an hour — which is why dev and prod both have a filed key.
 */
import { p256 } from "@noble/curves/nist.js";
import { isPublicDeployment, publicOrigin } from "../lib/deployment.js";

export interface PublicClientJwk {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
	kid: string;
	alg: "ES256";
	use: "sig";
}

export interface ClientSigningKey {
	secretKey: Uint8Array;
	publicJwk: PublicClientJwk;
}

let cached: ClientSigningKey | null | undefined;

/** The app's attestation key, or null when this process has none it can publish. */
export function clientSigningKey(): ClientSigningKey | null {
	if (cached !== undefined) return cached;
	const raw = process.env.ATPROTO_CLIENT_JWK?.trim();
	if (raw) {
		try {
			cached = fromPrivateJwk(JSON.parse(raw) as Record<string, unknown>);
			return cached;
		} catch (error) {
			// A malformed key is a misconfiguration; refusing attestations is safer than signing
			// with something the metadata cannot describe.
			console.error(
				`[client-attestation] ATPROTO_CLIENT_JWK is not a usable P-256 JWK: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			);
			cached = null;
			return null;
		}
	}
	if (isPublicDeployment()) {
		// Fail closed: a deployment only attests with a key whose public half is published.
		cached = null;
		return null;
	}
	// A checkout without the filed key: one key for the life of the process, so the metadata it
	// serves and the attestation it mints agree.
	const secretKey = p256.utils.randomSecretKey();
	const publicKey = p256.getPublicKey(secretKey, false);
	cached = fromPrivateJwk({
		kty: "EC",
		crv: "P-256",
		x: Buffer.from(publicKey.slice(1, 33)).toString("base64url"),
		y: Buffer.from(publicKey.slice(33)).toString("base64url"),
		d: Buffer.from(secretKey).toString("base64url"),
		kid: "anthers-spaces-dev-ephemeral",
	});
	return cached;
}

/** The JWKS the client metadata publishes, or null when this process has no key. */
export function clientJwks(): { keys: PublicClientJwk[] } | null {
	const key = clientSigningKey();
	return key ? { keys: [key.publicJwk] } : null;
}

/**
 * The client id an attestation may name, or null when it would not be resolvable.
 *
 * ⚠️ **The authority fetches this URL to find the JWKS, so it has to be a real document.** A
 * checkout's default client id is the loopback shape — `http://localhost?redirect_uris=…` —
 * which is an OAuth identifier, not a metadata URL; attesting with it would be refused before
 * the app was ever asked. A deployment's id is `https://…/api/atproto/client-metadata.json`.
 */
export function attestableClientId(): string | null {
	const id =
		process.env.ATPROTO_CLIENT_ID?.trim() ||
		(publicOrigin() ? `${publicOrigin()}/api/atproto/client-metadata.json` : "");
	if (!id) return null;
	try {
		const url = new URL(id);
		if (url.protocol === "https:") return id;
		if (url.protocol !== "http:") return null;
		// Plain HTTP is a checkout or a staging run: it is attestable only when it names a
		// document path rather than carrying the loopback client's parameters in the query.
		return url.pathname !== "/" && url.search === "" ? id : null;
	} catch {
		return null;
	}
}

function fromPrivateJwk(jwk: Record<string, unknown>): ClientSigningKey {
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
		throw new Error("expected an EC P-256 private JWK");
	}
	const secretKey = new Uint8Array(Buffer.from(jwk.d, "base64url"));
	const publicKey = p256.getPublicKey(secretKey, false);
	return {
		secretKey,
		publicJwk: {
			kty: "EC",
			crv: "P-256",
			x: Buffer.from(publicKey.slice(1, 33)).toString("base64url"),
			y: Buffer.from(publicKey.slice(33)).toString("base64url"),
			kid: typeof jwk.kid === "string" && jwk.kid ? jwk.kid : "anthers-spaces",
			alg: "ES256",
			use: "sig",
		},
	};
}

/** Test seam: forget the cached key after changing the environment. */
export function resetClientSigningKeyForTesting(): void {
	cached = undefined;
}
