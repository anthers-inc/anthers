// SPDX-License-Identifier: Apache-2.0
/**
 * The reader's side of a gated space, against the branch's real PDS — the lab's 05 and 11
 * driven through the code the app runs.
 *
 * What only this test can hold is the authority's own verdicts: the app perimeter refuses a
 * space whose allow-list does not name this client, a forged attestation is refused before the
 * managing app is asked, a non-member is refused through `checkUserAccess`, and a removed
 * member's next credential is refused while the one in hand still reads. It also proves the MAC
 * is real: the record the reader accepts is one whose signature and MAC the branch's PDS
 * produced, not one this code made for itself.
 *
 * Skipped unless `SPACE_STAGING_PDS_URL` names a server:
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/network.mjs
 *   SPACE_STAGING_PDS_URL=http://127.0.0.1:2683 \
 *     bun test apps/api/src/__tests__/space-credential-staging.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases, users, works } from "@anthers/db/schema";
import { p256 } from "@noble/curves/nist.js";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { didKeyFromVerificationMethod } from "../lib/did-key.js";
import { createManagingAppRoutes } from "../routes/managing-app.js";
import { buildClientMetadata } from "../services/atproto-client.js";
import {
	attestableClientId,
	clientSigningKey,
	resetClientSigningKeyForTesting,
} from "../services/client-attestation.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	GATED_MANIFEST_RKEY,
} from "../services/creator-space-records.js";
import { gatedManifestFor } from "../services/gated-manifest.js";
import { type ManagingAppIdentity, managingAppFor } from "../services/managing-app.js";
import type { ResolveDid } from "../services/service-auth.js";
import {
	readRecordWithCredential,
	readSpaceRecord,
	SpaceReadError,
} from "../services/space-credential.js";
import { generateP256Key } from "../services/space-crypto.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const PDS_URL = process.env.SPACE_STAGING_PDS_URL ?? null;
const PLC_URL = process.env.SPACE_STAGING_PLC_URL ?? "http://127.0.0.1:2682";
const staged = PDS_URL ? describe : describe.skip;

purgeAccountsCreatedHere();

interface Account {
	did: string;
	token: string;
	handle: string;
}

async function call<T = Record<string, unknown>>(
	method: string,
	options: { body?: unknown; params?: Record<string, string>; token?: string } = {},
): Promise<{ status: number; data: T }> {
	const url = new URL(`/xrpc/${method}`, PDS_URL as string);
	for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
	const response = await fetch(url, {
		method: options.body === undefined ? "GET" : "POST",
		headers: {
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	return { status: response.status, data: (text ? JSON.parse(text) : {}) as T };
}

async function account(label: string): Promise<Account> {
	const name = `${label}-${crypto.randomUUID().slice(0, 6)}`;
	const created = await call<{ did: string; accessJwt: string; handle: string }>(
		"com.atproto.server.createAccount",
		{
			body: {
				handle: `${name}.spaces.test`,
				email: `${name}@example.com`,
				password: `read-${crypto.randomUUID()}`,
			},
		},
	);
	return {
		did: created.data.did,
		token: created.data.accessJwt,
		handle: created.data.handle,
	};
}

const resolveDid: ResolveDid = async (did) => {
	try {
		const response = await fetch(`${PLC_URL}/${encodeURIComponent(did)}`);
		if (!response.ok) return null;
		return (await response.json()) as Awaited<ReturnType<ResolveDid>>;
	} catch {
		return null;
	}
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

const SAVED = {
	ATPROTO_CLIENT_ID: process.env.ATPROTO_CLIENT_ID,
	ATPROTO_CLIENT_JWK: process.env.ATPROTO_CLIENT_JWK,
};

staged("the reader's gated space credential against a staging PDS", () => {
	let server: ReturnType<typeof Bun.serve> | undefined;
	let identity: ManagingAppIdentity;
	let clientId = "";
	let creator: Account;
	let reader: Account;
	let outsider: Account;
	let localCreatorId = 0;
	let localReaderId = 0;
	let localOutsiderId = 0;
	let workId = 0;
	let publicId = 0;
	let space = "";
	let manifestUri = "";
	let otherSpace = "";
	let memberSpace = "";
	let memberManifestUri = "";
	let resolveSession: ResolveSpaceSession;
	const calls: Array<{ space: string; userDid: string; access: string; clientId?: string }> = [];
	const intentIds: string[] = [];
	let authorizedDid = "";

	beforeAll(async () => {
		process.env.ATPROTO_CLIENT_JWK = JSON.stringify(privateJwk("anthers-spaces-test"));
		resetClientSigningKeyForTesting();

		const app = new Hono()
			.get("/api/atproto/client-metadata.json", (c) => c.json(buildClientMetadata()))
			.route(
				"/",
				createManagingAppRoutes({
					resolveDid,
					authorize: async (query) => {
						calls.push(query);
						const authorized =
							query.access === "read" &&
							query.userDid === authorizedDid &&
							query.clientId === clientId;
						return { authorized, reason: authorized ? "entitled" : "not-entitled" };
					},
				}),
			);
		server = Bun.serve({ port: 0, fetch: app.fetch });
		process.env.ATPROTO_CLIENT_ID = `http://localhost:${server.port}/api/atproto/client-metadata.json`;
		resetClientSigningKeyForTesting();
		clientId = attestableClientId() as string;
		identity = managingAppFor(`http://localhost:${server.port}`);

		creator = await account("rc");
		reader = await account("rr");
		outsider = await account("ro");

		const creatorLocal = await createAccount(`read-creator-${Date.now().toString(36)}`);
		localCreatorId = creatorLocal.userId;
		await db
			.update(users)
			.set({ atprotoDid: creator.did, atprotoPdsUrl: PDS_URL })
			.where(eq(users.id, localCreatorId));
		const readerLocal = await createAccount(`read-reader-${Date.now().toString(36)}`);
		localReaderId = readerLocal.userId;
		await db
			.update(users)
			.set({ atprotoDid: reader.did, atprotoPdsUrl: PDS_URL })
			.where(eq(users.id, localReaderId));
		const outsiderLocal = await createAccount(`read-outsider-${Date.now().toString(36)}`);
		localOutsiderId = outsiderLocal.userId;
		await db
			.update(users)
			.set({ atprotoDid: outsider.did, atprotoPdsUrl: PDS_URL })
			.where(eq(users.id, localOutsiderId));

		const work = await insertWork({
			creatorId: localCreatorId,
			type: "text",
			title: "Nightjar",
			description: "A novel.",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
			sourceKey: `creators/${localCreatorId}/media/nightjar.epub`,
		});
		workId = work.id;
		publicId = work.publicId;
		const intent = `pi_reader_${Date.now()}`;
		intentIds.push(intent);
		await db.insert(purchases).values({
			buyerId: localReaderId,
			workId,
			creatorId: localCreatorId,
			workTitle: work.title,
			workType: work.type,
			workPublicId: publicId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			salesTax: "0.00",
			creatorEarnings: "5.00",
			stripePaymentIntentId: intent,
			status: "completed",
		});

		const policies = {
			readPolicy: {
				$type: "com.atproto.simplespace.defs#managingAppPolicy",
				managingApp: identity.serviceId,
			},
			writePolicy: {
				$type: "com.atproto.simplespace.defs#managingAppPolicy",
				managingApp: identity.serviceId,
			},
		};
		space = (
			await call<{ uri: string }>("com.atproto.simplespace.createSpace", {
				token: creator.token,
				body: {
					spaceType: "org.anthers.creatorSpace",
					skey: String(publicId),
					...policies,
					appAccess: { $type: "com.atproto.simplespace.defs#allowList", allowed: [clientId] },
				},
			})
		).data.uri;

		const manifest = await call<{ uri: string; cid: string }>("com.atproto.space.createRecord", {
			token: creator.token,
			body: {
				space,
				repo: creator.did,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
				validate: false,
				record: {
					$type: CREATOR_SPACE_COLLECTIONS.manifest,
					workId,
					publicId,
					url: `https://anthers.org/works/test-${publicId}`,
					title: "Nightjar",
					kind: "text",
					files: [
						{
							name: "nightjar.epub",
							key: `creators/${localCreatorId}/media/nightjar.epub`,
							bytes: 428_000,
							role: "source",
						},
					],
					updatedAt: new Date().toISOString(),
				},
			},
		});
		manifestUri = manifest.data.uri;
		await db.update(works).set({ gatedSpaceUri: space, manifestUri }).where(eq(works.id, workId));

		// A second space whose allow-list names somebody else: the authority verifies our
		// attestation and then refuses us at the app perimeter.
		otherSpace = (
			await call<{ uri: string }>("com.atproto.simplespace.createSpace", {
				token: creator.token,
				body: {
					spaceType: "org.anthers.creatorSpace",
					skey: `${publicId}other`,
					...policies,
					appAccess: {
						$type: "com.atproto.simplespace.defs#allowList",
						allowed: ["https://other.example/client-metadata.json"],
					},
				},
			})
		).data.uri;

		// Lab 05's space: a member-list read policy, so the authority refuses a removed member
		// at the next credential without asking the managing app at all.
		memberSpace = (
			await call<{ uri: string }>("com.atproto.simplespace.createSpace", {
				token: creator.token,
				body: {
					spaceType: "org.anthers.creatorSpace",
					skey: `${publicId}members`,
					readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
					writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
					appAccess: { $type: "com.atproto.simplespace.defs#allowList", allowed: [clientId] },
				},
			})
		).data.uri;
		await call("com.atproto.simplespace.putMember", {
			token: creator.token,
			body: { space: memberSpace, did: reader.did, read: true, write: false },
		});
		memberManifestUri = (
			await call<{ uri: string }>("com.atproto.space.createRecord", {
				token: creator.token,
				body: {
					space: memberSpace,
					repo: creator.did,
					collection: CREATOR_SPACE_COLLECTIONS.manifest,
					rkey: GATED_MANIFEST_RKEY,
					validate: false,
					record: {
						$type: CREATOR_SPACE_COLLECTIONS.manifest,
						workId,
						publicId,
						title: "Nightjar",
						kind: "text",
						files: [
							{ name: "nightjar.epub", key: "creators/0/media/nightjar.epub", role: "source" },
						],
						updatedAt: new Date().toISOString(),
					},
				},
			})
		).data.uri;

		resolveSession = async (id) =>
			id === localReaderId
				? { session: { did: reader.did, pdsUrl: PDS_URL as string, token: reader.token } }
				: { session: null, reason: "not_hosted" };
	});

	afterAll(async () => {
		if (creator?.token) {
			for (const uri of [space, otherSpace, memberSpace].filter(Boolean)) {
				await call("com.atproto.simplespace.deleteSpace", {
					body: { space: uri },
					token: creator.token,
				}).catch(() => undefined);
			}
		}
		server?.stop(true);
		for (const id of intentIds) {
			await db
				.delete(purchases)
				.where(eq(purchases.stripePaymentIntentId, id))
				.catch(() => undefined);
		}
		for (const [key, value] of Object.entries(SAVED)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetClientSigningKeyForTesting();
	});

	it("reads the manifest with an attested client, a credential and a verified MAC", async () => {
		authorizedDid = reader.did;
		const result = await gatedManifestFor({
			workId,
			readerUserId: localReaderId,
			resolveSession,
			resolveDid,
			clientId,
		});
		if (result.status !== "ok") throw new Error(`refused: ${result.reason} ${result.detail ?? ""}`);
		expect(result.manifest.files[0]).toMatchObject({
			name: "nightjar.epub",
			bytes: 428_000,
		});
		// The gate was asked with the verified client, which is what the lab's 11 asserts.
		expect(calls.some((call) => call.userDid === reader.did && call.clientId === clientId)).toBe(
			true,
		);
	});

	it("refuses a space whose allow-list does not name this client", async () => {
		const key = clientSigningKey();
		if (!key) throw new Error("no client key");
		await expect(
			readSpaceRecord({
				reader: { did: reader.did, pdsUrl: PDS_URL as string, token: reader.token },
				creatorDid: creator.did,
				creatorPdsUrl: PDS_URL as string,
				space: otherSpace,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
				expectedUri: manifestUri,
				authorKemDidKey: (await kemFor(creator.did)) as string,
				clientId,
				clientKey: key,
			}),
		).rejects.toMatchObject({ cause: expect.objectContaining({ error: "AppNotAuthorized" }) });
	});

	it("refuses an attestation whose signature does not match the published key", async () => {
		authorizedDid = reader.did;
		const key = clientSigningKey();
		if (!key) throw new Error("no client key");
		const forged = { ...key, secretKey: generateP256Key().secretKey };
		await expect(
			readSpaceRecord({
				reader: { did: reader.did, pdsUrl: PDS_URL as string, token: reader.token },
				creatorDid: creator.did,
				creatorPdsUrl: PDS_URL as string,
				space,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
				expectedUri: manifestUri,
				authorKemDidKey: (await kemFor(creator.did)) as string,
				clientId,
				clientKey: forged,
			}),
		).rejects.toBeInstanceOf(SpaceReadError);
	});

	it("refuses a non-member through checkUserAccess", async () => {
		authorizedDid = reader.did;
		const key = clientSigningKey();
		if (!key) throw new Error("no client key");
		await expect(
			readSpaceRecord({
				reader: { did: outsider.did, pdsUrl: PDS_URL as string, token: outsider.token },
				creatorDid: creator.did,
				creatorPdsUrl: PDS_URL as string,
				space,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
				expectedUri: manifestUri,
				authorKemDidKey: (await kemFor(creator.did)) as string,
				clientId,
				clientKey: key,
			}),
		).rejects.toMatchObject({ cause: expect.objectContaining({ error: "UserNotAuthorized" }) });
	});

	it("refuses a credential request with no attestation at all", async () => {
		const delegation = await call<{ token: string }>("com.atproto.space.getDelegationToken", {
			token: reader.token,
			params: { space },
		});
		const credential = await call("com.atproto.space.getSpaceCredential", {
			body: {
				space,
				credentialKid: generateP256Key().didKey,
				delegationToken: delegation.data.token,
			},
		});
		expect(credential.status).toBeGreaterThanOrEqual(400);
		expect(credential.data.error).toBe("AppNotAuthorized");
	});

	it("refuses a removed member's next credential while the one in hand still reads", async () => {
		const key = clientSigningKey();
		if (!key) throw new Error("no client key");
		const kem = (await kemFor(creator.did)) as string;
		const member = { did: reader.did, pdsUrl: PDS_URL as string, token: reader.token };
		const first = await readSpaceRecord({
			reader: member,
			creatorDid: creator.did,
			creatorPdsUrl: PDS_URL as string,
			space: memberSpace,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
			expectedUri: memberManifestUri,
			authorKemDidKey: kem,
			clientId,
			clientKey: key,
		});
		expect(first.record.uri).toBe(memberManifestUri);

		await call("com.atproto.simplespace.removeMember", {
			token: creator.token,
			body: { space: memberSpace, did: reader.did },
		});

		await expect(
			readSpaceRecord({
				reader: member,
				creatorDid: creator.did,
				creatorPdsUrl: PDS_URL as string,
				space: memberSpace,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
				expectedUri: memberManifestUri,
				authorKemDidKey: kem,
				clientId,
				clientKey: key,
			}),
		).rejects.toMatchObject({ cause: expect.objectContaining({ error: "UserNotAuthorized" }) });

		const stillReads = await readRecordWithCredential({
			credential: first.credential,
			key: first.key,
			creatorDid: creator.did,
			creatorPdsUrl: PDS_URL as string,
			space: memberSpace,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
			expectedUri: memberManifestUri,
			authorKemDidKey: kem,
		});
		expect(stillReads.uri).toBe(memberManifestUri);
	});

	async function kemFor(did: string): Promise<string | null> {
		const document = await resolveDid(did);
		const method = document?.verificationMethod?.find((candidate) =>
			candidate.id?.endsWith("#atproto_kem"),
		);
		return method ? didKeyFromVerificationMethod(method) : null;
	}
});
