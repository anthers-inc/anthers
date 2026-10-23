// SPDX-License-Identifier: Apache-2.0
/**
 * The managing-app surface: the identity document a space authority resolves, and the gate it
 * calls once it has.
 *
 * These are HTTP-level tests with the network and the database both replaced, so what they
 * prove is the surface rather than the policy: the document names the host that served it,
 * the route reads the authority out of a verified token rather than the query string, and an
 * unverifiable caller is refused before it can ask about anybody's space.
 */
import { describe, expect, it } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { didKeyFromPublicKey } from "../lib/did-key.js";
import { createManagingAppRoutes } from "../routes/managing-app.js";
import { CHECK_USER_ACCESS_METHOD, managingAppFor } from "../services/managing-app.js";
import type { ResolveDid } from "../services/service-auth.js";
import type { SpaceAccessDecision } from "../services/space-gate.js";

const ORIGIN = "http://localhost:8000";
const SERVICE = "did:web:localhost%3A8000#anthers";
const ISSUER = "did:plc:spaceauthorityspaceauthority";

const privateKey = secp256k1.utils.randomSecretKey();
const didKey = didKeyFromPublicKey("secp256k1", secp256k1.getPublicKey(privateKey, true));
const resolveDid: ResolveDid = async (did) =>
	did === ISSUER
		? {
				id: did,
				verificationMethod: [
					{
						id: `${did}#atproto`,
						type: "Multikey",
						publicKeyMultibase: didKey.slice("did:key:".length),
					},
				],
			}
		: null;

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(overrides: Record<string, unknown> = {}): string {
	const signing = `${b64url({ typ: "JWT", alg: "ES256K" })}.${b64url({
		iss: ISSUER,
		aud: SERVICE,
		lxm: CHECK_USER_ACCESS_METHOD,
		exp: Math.floor(Date.now() / 1000) + 60,
		jti: "test",
		...overrides,
	})}`;
	const signature = secp256k1.sign(new TextEncoder().encode(signing), privateKey);
	return `${signing}.${Buffer.from(signature).toString("base64url")}`;
}

function request(path: string, init: RequestInit = {}) {
	const app = createManagingAppRoutes({
		resolveDid,
		authorize: async () => ({ authorized: true, reason: "entitled" }),
	});
	return app.request(`${ORIGIN}${path}`, init);
}

const CHECK = `/xrpc/${CHECK_USER_ACCESS_METHOD}?space=at%3A%2F%2F${ISSUER}%2Fspace%2Forg.anthers.creatorSpace%2F42&user=did%3Aplc%3Areader&access=read`;

describe("the managing-app identity", () => {
	it("percent-encodes a local port into the DID, and keeps the service fragment", () => {
		expect(managingAppFor("http://localhost:8000")).toEqual({
			did: "did:web:localhost%3A8000",
			serviceId: "did:web:localhost%3A8000#anthers",
			endpoint: "http://localhost:8000",
		});
	});

	it("names a bare host without a port", () => {
		expect(managingAppFor("https://anthers.org")).toEqual({
			did: "did:web:anthers.org",
			serviceId: "did:web:anthers.org#anthers",
			endpoint: "https://anthers.org",
		});
	});
});

describe("the managing-app DID document", () => {
	it("names the host that served it, and the API under that host", async () => {
		const response = await request("/.well-known/did.json");
		expect(response.status).toBe(200);
		const document = (await response.json()) as {
			id: string;
			service: Array<{ id: string; serviceEndpoint: string }>;
		};
		expect(document.id).toBe("did:web:localhost%3A8000");
		expect(document.service).toContainEqual(
			expect.objectContaining({ id: "#anthers", serviceEndpoint: ORIGIN }),
		);
	});
});

describe("checkUserAccess", () => {
	it("answers the verified authority's question", async () => {
		const seen: Array<Record<string, string>> = [];
		const app = createManagingAppRoutes({
			resolveDid,
			authorize: async (query) => {
				seen.push(query);
				return { authorized: true, reason: "entitled" };
			},
		});
		const response = await app.request(`${ORIGIN}${CHECK}`, {
			headers: { Authorization: `Bearer ${token()}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authorized: true });
		expect(seen).toEqual([
			{
				space: `at://${ISSUER}/space/org.anthers.creatorSpace/42`,
				authority: ISSUER,
				userDid: "did:plc:reader",
				access: "read",
			},
		]);
	});

	it("carries a refusal as an answer rather than an error", async () => {
		const app = createManagingAppRoutes({
			resolveDid,
			authorize: async (): Promise<SpaceAccessDecision> => ({
				authorized: false,
				reason: "not-entitled",
			}),
		});
		const response = await app.request(`${ORIGIN}${CHECK}`, {
			headers: { Authorization: `Bearer ${token()}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authorized: false });
	});

	it("refuses a request with no service auth before it reads the question", async () => {
		let asked = false;
		const app = createManagingAppRoutes({
			resolveDid,
			authorize: async () => {
				asked = true;
				return { authorized: true, reason: "entitled" };
			},
		});
		const response = await app.request(`${ORIGIN}${CHECK}`);
		expect(response.status).toBe(401);
		expect(asked).toBe(false);
	});

	it("refuses a token addressed to another service", async () => {
		const response = await request(CHECK, {
			headers: {
				Authorization: `Bearer ${token({ aud: "did:web:elsewhere.example#app" })}`,
			},
		});
		expect(response.status).toBe(401);
		expect(((await response.json()) as { error: string }).error).toBe("BadJwtAudience");
	});

	it("refuses a token minted for another method", async () => {
		const response = await request(CHECK, {
			headers: {
				Authorization: `Bearer ${token({ lxm: "com.atproto.space.notifyWrite" })}`,
			},
		});
		expect(response.status).toBe(401);
		expect(((await response.json()) as { error: string }).error).toBe("BadJwtLexiconMethod");
	});

	it("refuses a signature that does not verify", async () => {
		const [header, payload] = token().split(".");
		const otherKey = secp256k1.utils.randomSecretKey();
		const forged = secp256k1.sign(new TextEncoder().encode(`${header}.${payload}`), otherKey);
		const response = await request(CHECK, {
			headers: {
				Authorization: `Bearer ${header}.${payload}.${Buffer.from(forged).toString("base64url")}`,
			},
		});
		expect(response.status).toBe(401);
		expect(((await response.json()) as { error: string }).error).toBe("BadJwtSignature");
	});

	it("refuses a question missing its parameters", async () => {
		const response = await request(
			`/xrpc/${CHECK_USER_ACCESS_METHOD}?space=at%3A%2F%2F${ISSUER}%2Fspace%2Forg.anthers.creatorSpace%2F42`,
			{ headers: { Authorization: `Bearer ${token()}` } },
		);
		expect(response.status).toBe(400);
	});
});
