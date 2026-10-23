// SPDX-License-Identifier: Apache-2.0
/**
 * Service-auth verification: the one thing standing between the network and the space gate.
 *
 * The cases worth having are the ones where a plausible token is wrong in a way a reader
 * would not see: a token addressed to another service, one minted for another method, one
 * that expired a minute ago, and one signed by a key the issuer no longer publishes. Each
 * must be refused for its own reason, and a rotation must be survivable — the protocol's own
 * verifier retries once against a freshly resolved key, so a cache that outlived a rotation
 * cannot be the reason a valid authority is refused.
 */
import { describe, expect, it } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { didKeyFromPublicKey } from "../lib/did-key.js";
import {
	type ResolveDid,
	type ServiceAuthDidDocument,
	ServiceAuthError,
	verifyServiceAuth,
} from "../services/service-auth.js";

const SERVICE = "did:web:anthers.example#anthers";
const LXM = "com.atproto.simplespace.checkUserAccess";
const ISSUER = "did:plc:authorityauthorityauthority";

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(
	privateKey: Uint8Array,
	payload: Record<string, unknown>,
	header: Record<string, unknown> = { typ: "JWT", alg: "ES256K" },
): string {
	const signing = `${b64url(header)}.${b64url(payload)}`;
	const signature = secp256k1.sign(new TextEncoder().encode(signing), privateKey);
	return `${signing}.${Buffer.from(signature).toString("base64url")}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iss: ISSUER,
		aud: SERVICE,
		lxm: LXM,
		exp: Math.floor(Date.now() / 1000) + 60,
		jti: "abc123",
		...overrides,
	};
}

function documentFor(did: string, multibase: string): ServiceAuthDidDocument {
	return {
		id: did,
		verificationMethod: [{ id: `${did}#atproto`, type: "Multikey", publicKeyMultibase: multibase }],
	};
}

describe("verifyServiceAuth", () => {
	const privateKey = secp256k1.utils.randomSecretKey();
	const didKey = didKeyFromPublicKey("secp256k1", secp256k1.getPublicKey(privateKey, true));
	const multibase = didKey.slice("did:key:".length);
	const resolver: ResolveDid = async (did) =>
		did === ISSUER ? documentFor(ISSUER, multibase) : null;

	it("accepts a token signed by the issuer's own #atproto key", async () => {
		const verified = await verifyServiceAuth(sign(privateKey, claims()), {
			serviceId: SERVICE,
			lxm: LXM,
			resolveDid: resolver,
		});
		expect(verified.iss).toBe(ISSUER);
		expect(verified.aud).toBe(SERVICE);
		expect(verified.lxm).toBe(LXM);
	});

	it("accepts an ES256 token as well as ES256K", async () => {
		const p256Key = p256.utils.randomSecretKey();
		const p256DidKey = didKeyFromPublicKey("p256", p256.getPublicKey(p256Key, true));
		const p256Resolver: ResolveDid = async () =>
			documentFor(ISSUER, p256DidKey.slice("did:key:".length));

		const signing = `${b64url({ typ: "JWT", alg: "ES256" })}.${b64url(claims())}`;
		const signature = p256.sign(new TextEncoder().encode(signing), p256Key);
		const verified = await verifyServiceAuth(
			`${signing}.${Buffer.from(signature).toString("base64url")}`,
			{ serviceId: SERVICE, lxm: LXM, resolveDid: p256Resolver },
		);
		expect(verified.iss).toBe(ISSUER);
	});

	it("refuses a token whose payload was changed after signing", async () => {
		const [header, , signature] = sign(privateKey, claims()).split(".");
		const tampered = `${header}.${b64url(claims({ user: "did:plc:somebodyelse" }))}.${signature}`;
		await expect(
			verifyServiceAuth(tampered, { serviceId: SERVICE, lxm: LXM, resolveDid: resolver }),
		).rejects.toBeInstanceOf(ServiceAuthError);
	});

	it("refuses a token addressed to another service", async () => {
		await expect(
			verifyServiceAuth(sign(privateKey, claims({ aud: "did:web:elsewhere.example#app" })), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: resolver,
			}),
		).rejects.toThrow(/audience/);
	});

	it("refuses a token minted for another method", async () => {
		await expect(
			verifyServiceAuth(sign(privateKey, claims({ lxm: "com.atproto.space.notifyWrite" })), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: resolver,
			}),
		).rejects.toThrow(/lexicon method/);
	});

	it("refuses a token with no lxm at all", async () => {
		const { lxm: _omitted, ...withoutLxm } = claims();
		await expect(
			verifyServiceAuth(sign(privateKey, withoutLxm), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: resolver,
			}),
		).rejects.toThrow(/missing jwt lexicon method/);
	});

	it("refuses an expired token, at the protocol's five-second skew", async () => {
		const expired = Math.floor(Date.now() / 1000) - 60;
		await expect(
			verifyServiceAuth(sign(privateKey, claims({ exp: expired })), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: resolver,
			}),
		).rejects.toThrow(/expired/);
	});

	it("refuses an issuer that is not a bare DID", async () => {
		await expect(
			verifyServiceAuth(sign(privateKey, claims({ iss: `${ISSUER}#atproto` })), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: resolver,
			}),
		).rejects.toThrow(/issuer/);
	});

	it("refuses an access token or a DPoP proof offered as service auth", async () => {
		await expect(
			verifyServiceAuth(sign(privateKey, claims(), { typ: "at+jwt", alg: "ES256K" }), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: resolver,
			}),
		).rejects.toThrow(/jwt type/);
	});

	it("refuses an issuer whose document has no #atproto key", async () => {
		await expect(
			verifyServiceAuth(sign(privateKey, claims()), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: async () => ({ id: ISSUER, verificationMethod: [] }),
			}),
		).rejects.toThrow(/missing or bad key/);
	});

	it("refuses an issuer that does not resolve", async () => {
		await expect(
			verifyServiceAuth(sign(privateKey, claims()), {
				serviceId: SERVICE,
				lxm: LXM,
				resolveDid: async () => null,
			}),
		).rejects.toThrow(/could not resolve/);
	});

	it("survives a key rotation by resolving the document again", async () => {
		const rotated = secp256k1.utils.randomSecretKey();
		const rotatedKey = didKeyFromPublicKey("secp256k1", secp256k1.getPublicKey(rotated, true));
		const calls: Array<{ fresh?: boolean }> = [];
		const rotating: ResolveDid = async (_did, options) => {
			calls.push(options ?? {});
			return documentFor(ISSUER, (options?.fresh ? rotatedKey : didKey).slice("did:key:".length));
		};

		const verified = await verifyServiceAuth(sign(rotated, claims()), {
			serviceId: SERVICE,
			lxm: LXM,
			resolveDid: rotating,
		});
		expect(verified.iss).toBe(ISSUER);
		expect(calls).toEqual([{}, { fresh: true }]);
	});
});
