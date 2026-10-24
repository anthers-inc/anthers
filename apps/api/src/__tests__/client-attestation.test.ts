// SPDX-License-Identifier: Apache-2.0
/**
 * The app's attestation key and the metadata that publishes its public half.
 *
 * The key is the one new secret this feature introduces, and the two failure directions matter:
 * a deployment without it must publish no `jwks` and refuse to attest (never sign with
 * something a space authority cannot verify), while a checkout must still be self-consistent
 * for the staging runs. The client id is the second half: an authority fetches it, so only an
 * id that names the metadata document can be attested against.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { buildClientMetadata } from "../services/atproto-client.js";
import {
	attestableClientId,
	clientJwks,
	clientSigningKey,
	resetClientSigningKeyForTesting,
} from "../services/client-attestation.js";

const SAVED = {
	ATPROTO_CLIENT_ID: process.env.ATPROTO_CLIENT_ID,
	ATPROTO_CLIENT_JWK: process.env.ATPROTO_CLIENT_JWK,
	BASE_URL: process.env.BASE_URL,
	FRONTEND_URL: process.env.FRONTEND_URL,
};

function privateJwk(kid: string): Record<string, string> {
	const secretKey = p256.utils.randomSecretKey();
	const publicKey = p256.getPublicKey(secretKey, false);
	return {
		kty: "EC",
		crv: "P-256",
		x: Buffer.from(publicKey.slice(1, 33)).toString("base64url"),
		y: Buffer.from(publicKey.slice(33)).toString("base64url"),
		d: Buffer.from(secretKey).toString("base64url"),
		kid,
	};
}

beforeEach(() => {
	process.env.ATPROTO_CLIENT_JWK = JSON.stringify(privateJwk("anthers-spaces-test"));
	process.env.ATPROTO_CLIENT_ID = "https://anthers.org/api/atproto/client-metadata.json";
	delete process.env.FRONTEND_URL;
	delete process.env.BASE_URL;
	resetClientSigningKeyForTesting();
});

afterEach(() => {
	for (const [key, value] of Object.entries(SAVED)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetClientSigningKeyForTesting();
});

describe("the app's attestation key", () => {
	it("derives the public half from the filed private JWK", () => {
		const key = clientSigningKey();
		expect(key).not.toBeNull();
		expect(key?.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
		expect(key?.publicJwk.kid).toBe("anthers-spaces-test");
		// The published x/y are the key's own, not the environment's — a stale x/y cannot make
		// the metadata describe a key different from the one that signs.
		const publicKey = p256.getPublicKey(key?.secretKey as Uint8Array, false);
		expect(key?.publicJwk.x).toBe(Buffer.from(publicKey.slice(1, 33)).toString("base64url"));
		expect(key?.publicJwk.y).toBe(Buffer.from(publicKey.slice(33)).toString("base64url"));
	});

	it("publishes the JWKS in the discoverable client metadata", () => {
		const metadata = buildClientMetadata() as { client_id: string; jwks?: { keys: unknown[] } };
		expect(metadata.client_id).toBe("https://anthers.org/api/atproto/client-metadata.json");
		expect(metadata.jwks?.keys).toHaveLength(1);
		expect(clientJwks()?.keys[0]?.kid).toBe("anthers-spaces-test");
	});

	it("publishes no JWKS and refuses to attest without a key in a deployment", () => {
		delete process.env.ATPROTO_CLIENT_JWK;
		process.env.FRONTEND_URL = "https://anthers.org";
		resetClientSigningKeyForTesting();
		expect(clientSigningKey()).toBeNull();
		const metadata = buildClientMetadata() as { jwks?: unknown };
		expect(metadata.jwks).toBeUndefined();
	});
});

describe("the client id an attestation may name", () => {
	it("is the discoverable metadata document", () => {
		expect(attestableClientId()).toBe("https://anthers.org/api/atproto/client-metadata.json");
	});

	it("is a plain-http document for a staging run", () => {
		process.env.ATPROTO_CLIENT_ID = "http://localhost:4517/api/atproto/client-metadata.json";
		expect(attestableClientId()).toBe("http://localhost:4517/api/atproto/client-metadata.json");
	});

	it("is not the loopback client identifier, which no authority can fetch", () => {
		process.env.ATPROTO_CLIENT_ID =
			"http://localhost?redirect_uris=http%3A%2F%2F127.0.0.1%3A8000%2Fapi%2Fatproto%2Fcallback";
		expect(attestableClientId()).toBeNull();
		delete process.env.ATPROTO_CLIENT_ID;
		// A checkout with no explicit id and no public origin has nothing fetchable either.
		expect(attestableClientId()).toBeNull();
	});
});
