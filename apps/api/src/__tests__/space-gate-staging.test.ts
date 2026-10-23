// SPDX-License-Identifier: Apache-2.0
/**
 * The gate against the branch's real PDS: does a space authority actually call Anthers, and
 * does the answer it gets decide the credential?
 *
 * This is the half no unit test can hold. The PDS resolves our `did:web`, mints the service-auth
 * token, calls `checkUserAccess`, and issues or refuses a space credential on the answer. The
 * access decision itself is replaced here — the database policy is `space-gate.test.ts`, and a
 * staging account's identity does not exist in the local `users` table — so what this proves is
 * the protocol path end to end: identity document, service auth, route, answer.
 *
 * ⚠️ **The read of the manifest is not here, deliberately.** A space read needs an HTTP message
 * signature and an `atproto-space-want-mac` key share, which is the reader-side credential
 * client rather than the gate. The lab's 07 and 11 already hold that path; this holds the
 * question the authority asks of us.
 *
 * Skipped unless `SPACE_STAGING_PDS_URL` names a server:
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/network.mjs
 *   SPACE_STAGING_PDS_URL=http://127.0.0.1:2683 bun test apps/api/src/__tests__/space-gate-staging.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { didKeyFromPublicKey } from "../lib/did-key.js";
import { createManagingAppRoutes } from "../routes/managing-app.js";
import type { ResolveDid } from "../services/service-auth.js";

const PDS_URL = process.env.SPACE_STAGING_PDS_URL ?? null;
const PLC_URL = process.env.SPACE_STAGING_PLC_URL ?? "http://127.0.0.1:2682";

const staged = PDS_URL ? describe : describe.skip;

interface Account {
	did: string;
	token: string;
	handle: string;
}

async function xrpc<T>(
	method: string,
	options: {
		body?: unknown;
		params?: Record<string, string>;
		token?: string;
	} = {},
): Promise<T> {
	const url = new URL(`/xrpc/${method}`, PDS_URL as string);
	for (const [key, value] of Object.entries(options.params ?? {})) {
		url.searchParams.set(key, value);
	}
	const response = await fetch(url, {
		method: options.body === undefined ? "GET" : "POST",
		headers: {
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	if (!response.ok) {
		throw Object.assign(new Error(`${method}: ${response.status} ${String(data.error ?? text)}`), {
			status: response.status,
			error: data.error,
		});
	}
	return data as T;
}

async function account(label: string): Promise<Account> {
	// The staging PDS caps a service handle's first label at 18 characters, so the readable
	// part is a short prefix and the rest is the random tail that makes it unique.
	const name = `${label}-${crypto.randomUUID().slice(0, 6)}`;
	const handle = `${name}.spaces.test`;
	const created = await xrpc<{ did: string; accessJwt: string; handle: string }>(
		"com.atproto.server.createAccount",
		{
			body: {
				handle,
				email: `${name}@example.com`,
				password: `gate-${crypto.randomUUID()}`,
			},
		},
	);
	return { did: created.did, token: created.accessJwt, handle };
}

/** The local PLC directory answers `GET /:did` with the DID document the network resolves. */
const resolveDid: ResolveDid = async (did) => {
	try {
		const response = await fetch(`${PLC_URL}/${encodeURIComponent(did)}`);
		if (!response.ok) return null;
		return (await response.json()) as Awaited<ReturnType<ResolveDid>>;
	} catch {
		return null;
	}
};

/** A P-256 key the credential can be bound to, as the authority requires. */
function p256KeyId(): string {
	const key = p256.utils.randomSecretKey();
	return didKeyFromPublicKey("p256", p256.getPublicKey(key, true));
}

let server: ReturnType<typeof Bun.serve> | undefined;
const allowed: string[] = [];
let serviceId = "";

staged("the managing-app gate against a staging PDS", () => {
	beforeAll(async () => {
		const app = createManagingAppRoutes({
			resolveDid,
			authorize: async (query) => ({
				authorized: allowed.includes(query.userDid),
				reason: allowed.includes(query.userDid) ? "entitled" : "not-entitled",
			}),
		});
		server = Bun.serve({ port: 0, fetch: app.fetch });
		serviceId = `did:web:localhost%3A${server.port}#anthers`;
	});

	afterAll(() => {
		server?.stop(true);
	});

	it("resolves our identity document and answers through it", async () => {
		const response = await fetch(`http://localhost:${server?.port}/.well-known/did.json`);
		expect(response.status).toBe(200);
		const document = (await response.json()) as {
			id: string;
			service: Array<{ id: string; serviceEndpoint: string }>;
		};
		expect(document.id).toBe(`did:web:localhost%3A${server?.port}`);
		expect(document.service[0]?.serviceEndpoint).toBe(`http://localhost:${server?.port}`);
	});

	it("issues a credential to a reader it authorizes and refuses one it does not", async () => {
		const creator = await account("gc");
		const reader = await account("gr");
		const outsider = await account("go");
		allowed.length = 0;
		allowed.push(reader.did);

		const space = (
			await xrpc<{ uri: string }>("com.atproto.simplespace.createSpace", {
				token: creator.token,
				body: {
					spaceType: "org.anthers.creatorSpace",
					skey: "1",
					readPolicy: {
						$type: "com.atproto.simplespace.defs#managingAppPolicy",
						managingApp: serviceId,
					},
					writePolicy: {
						$type: "com.atproto.simplespace.defs#managingAppPolicy",
						managingApp: serviceId,
					},
					appAccess: { $type: "com.atproto.simplespace.defs#open" },
				},
			})
		).uri;

		async function credentialFor(account: Account): Promise<string> {
			const delegation = await xrpc<{ token: string }>("com.atproto.space.getDelegationToken", {
				params: { space },
				token: account.token,
			});
			const result = await xrpc<{ credential: string }>("com.atproto.space.getSpaceCredential", {
				body: {
					space,
					credentialKid: p256KeyId(),
					delegationToken: delegation.token,
				},
			});
			return result.credential;
		}

		const credential = await credentialFor(reader);
		expect(typeof credential).toBe("string");
		expect(credential.split(".")).toHaveLength(3);

		await expect(credentialFor(outsider)).rejects.toMatchObject({
			error: "UserNotAuthorized",
		});
	});

	it("refuses when the managing app cannot be reached at all", async () => {
		const creator = await account("uc");
		const reader = await account("ur");
		const space = (
			await xrpc<{ uri: string }>("com.atproto.simplespace.createSpace", {
				token: creator.token,
				body: {
					spaceType: "org.anthers.creatorSpace",
					skey: "2",
					readPolicy: {
						$type: "com.atproto.simplespace.defs#managingAppPolicy",
						// Nothing listens here, which is what an outage looks like to the PDS.
						managingApp: "did:web:localhost%3A1#anthers",
					},
					writePolicy: {
						$type: "com.atproto.simplespace.defs#managingAppPolicy",
						managingApp: "did:web:localhost%3A1#anthers",
					},
					appAccess: { $type: "com.atproto.simplespace.defs#open" },
				},
			})
		).uri;

		const delegation = await xrpc<{ token: string }>("com.atproto.space.getDelegationToken", {
			params: { space },
			token: reader.token,
		});
		await expect(
			xrpc("com.atproto.space.getSpaceCredential", {
				body: {
					space,
					credentialKid: p256KeyId(),
					delegationToken: delegation.token,
				},
			}),
		).rejects.toMatchObject({ error: "UserNotAuthorized" });
	});
});
