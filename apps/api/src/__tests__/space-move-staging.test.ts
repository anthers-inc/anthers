// SPDX-License-Identifier: Apache-2.0
/**
 * The move drill: an identity, its public repo, its space, its blob and its members move to a
 * second PDS, the old server is retired, and the new copy keeps answering.
 *
 * Gated on `MOVE_CONTROL_URL`, which the lab's `scripts/move-network.mjs` prints. The control
 * server is a test harness, not production: it exposes the PLC email token from the old PDS's
 * own database (a real operator receives it by email) and retires the old server on request.
 *
 * ⚠️ **Nothing here touches the real network.** Both PDSes and the PLC are the lab's, and the
 * accounts are disposable.
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/move-network.mjs
 *   MOVE_CONTROL_URL=http://127.0.0.1:2685 bun test apps/api/src/__tests__/space-move-staging.test.ts
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { SpaceClient } from "../services/atproto-space.js";
import {
	gatedSpaceUri,
	STUDIO_SPACE_POLICIES,
	studioSpaceUri,
	syncCreatorSpace,
} from "../services/creator-space.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	CREATOR_SPACE_TYPE,
	GATED_MANIFEST_RKEY,
} from "../services/creator-space-records.js";
import { managingAppFor } from "../services/managing-app.js";
import { moveAccount } from "../services/space-move.js";
import { USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { ensureUserSpace } from "../services/space-registry.js";
import { type ResolveSpaceSession, spaceClientFor } from "../services/space-writer.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const CONTROL = process.env.MOVE_CONTROL_URL ?? null;

purgeAccountsCreatedHere();

const drill = CONTROL ? describe : describe.skip;
const SAVE = new TextEncoder().encode("a moved reader's save\n".repeat(20));

interface Network {
	plc: string;
	oldPds: string;
	newPds: string;
}

async function controlNetwork(): Promise<Network> {
	const response = await fetch(`${CONTROL}/health`);
	if (!response.ok) throw new Error("the move network is not answering");
	return (await response.json()) as Network;
}

async function xrpc<T = Record<string, unknown>>(
	base: string,
	method: string,
	opts: {
		token?: string;
		body?: Record<string, unknown>;
		params?: Record<string, string>;
		/** A POST with no input, which the PLC-signature request is. */
		post?: boolean;
	} = {},
): Promise<T> {
	const url = new URL(`/xrpc/${method}`, base);
	for (const [key, value] of Object.entries(opts.params ?? {})) url.searchParams.set(key, value);
	const response = await fetch(url, {
		method: opts.body === undefined && !opts.post ? "GET" : "POST",
		headers: {
			...(opts.body === undefined ? {} : { "content-type": "application/json" }),
			...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
		},
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
	});
	const text = await response.text();
	const data = text ? JSON.parse(text) : {};
	if (!response.ok) throw new Error(`${method}: ${response.status} ${data.error ?? text}`);
	return data as T;
}

interface Staged {
	did: string;
	handle: string;
	token: string;
	password: string;
	email: string;
	spaceUri: string;
	userId: number;
	resolveSession: ResolveSpaceSession;
	/**
	 * The creator half: a studio, a gated Work's space, the media key its manifest names, and an
	 * empty space of the same type — the state a crash between `createSpace` and its first record
	 * leaves behind, and the one a commit comparison has to treat as vacuously true.
	 */
	creator: {
		studio: string;
		gated: string;
		empty: string;
		publicId: number;
		mediaKey: string;
	};
}

/**
 * An account on the old PDS, a local row for the registry, a space, a blob and a member — and
 * the creator half: a studio and a gated Work's space, whose manifest names an R2 key rather
 * than a blob.
 */
async function stage(network: Network, label: string): Promise<Staged> {
	const tag = `${label}${Date.now().toString(36)}`;
	const handle = `${tag}.spaces.test`;
	const email = `${tag}@example.com`;
	const password = `pw-${tag}-${tag}`;
	const created = await xrpc<{ did: string; accessJwt: string }>(
		network.oldPds,
		"com.atproto.server.createAccount",
		{ body: { handle, email, password } },
	);
	const did = created.did;
	const token = created.accessJwt;

	const member = await xrpc<{ did: string }>(network.oldPds, "com.atproto.server.createAccount", {
		body: {
			handle: `m${tag}.spaces.test`,
			email: `m${tag}@example.com`,
			password: `pw-${tag}-m-${tag}`,
		},
	});

	const local = await createAccount(`mv-${tag.slice(-12)}`);
	const resolveSession: ResolveSpaceSession = async (id) =>
		id === local.userId
			? { session: { did, pdsUrl: network.oldPds, token } }
			: { session: null, reason: "not_hosted" };

	const ensured = await ensureUserSpace(local.userId, { resolveSession });
	if (!ensured.space) throw new Error(`space was not created: ${ensured.reason}`);

	const client = spaceClientFor({ did, pdsUrl: network.oldPds, token });
	const blob = await client.uploadBlob(SAVE, "text/plain");
	await client.putRecord({
		space: ensured.space.spaceUri,
		repo: did,
		collection: USER_SPACE_COLLECTIONS.workSave,
		rkey: "work-1",
		record: { $type: USER_SPACE_COLLECTIONS.workSave, blob },
		validate: false,
	});
	await client.putMember(ensured.space.spaceUri, {
		did: member.did,
		read: true,
		write: false,
	});

	const mediaKey = `creators/${local.userId}/media/nightjar-${tag}.epub`;
	const media = new TextEncoder().encode(`a moved creator's novel ${tag}\n`.repeat(20));
	await storage.upload(mediaKey, media, "application/epub+zip");
	const work = await insertWork({
		creatorId: local.userId,
		type: "text",
		title: "Nightjar",
		visibility: "released",
		access: [{ threshold: 0, allow: true, price: "5.00" }],
		sourceKey: mediaKey,
	});
	await syncCreatorSpace(work.id, {
		resolveSession,
		managingApp: managingAppFor("http://localhost:4321"),
	});
	const emptySkey = `empty-${tag}`;
	const emptySpace = `at://${did}/space/${CREATOR_SPACE_TYPE}/${emptySkey}`;
	await client.createSpace({
		spaceType: CREATOR_SPACE_TYPE,
		skey: emptySkey,
		...STUDIO_SPACE_POLICIES,
	});
	const creator = {
		studio: studioSpaceUri(did),
		gated: gatedSpaceUri(did, work.publicId),
		empty: emptySpace,
		publicId: work.publicId,
		mediaKey,
	};

	// A public record, so the CAR has something in it beyond the empty root.
	await xrpc(network.oldPds, "com.atproto.repo.createRecord", {
		token,
		body: {
			repo: did,
			collection: "com.example.note",
			rkey: "note-1",
			record: { $type: "com.example.note", text: "moved from the old server" },
			validate: false,
		},
	});

	return {
		did,
		handle,
		token,
		password,
		email,
		spaceUri: ensured.space.spaceUri,
		userId: local.userId,
		resolveSession,
		creator,
	};
}

async function plcToken(did: string): Promise<string> {
	const response = await fetch(`${CONTROL}/plc-token?did=${encodeURIComponent(did)}`);
	const body = (await response.json()) as { token: string | null };
	if (!body.token) throw new Error("the old PDS has no PLC token for this DID");
	return body.token;
}

drill("the hosted-identity move against two PDSes", () => {
	let network: Network;
	let moved: Staged;

	it("moves the DID, the public repo, the space, the blob and the members", async () => {
		network = await controlNetwork();
		moved = await stage(network, "mv");
		process.env.ATPROTO_PLC_URL = network.plc;

		// The signature email the operator would relay.
		await xrpc(network.oldPds, "com.atproto.identity.requestPlcOperationSignature", {
			token: moved.token,
			post: true,
		});
		const token = await plcToken(moved.did);

		const result = await moveAccount(moved.userId, {
			target: {
				pdsUrl: network.newPds,
				email: moved.email,
				password: moved.password,
				handle: moved.handle,
			},
			plcToken: token,
			resolveSession: moved.resolveSession,
		});
		if (!result.ok) {
			throw new Error(
				`move failed at ${result.stages.at(-1)?.name}: ${result.stages.at(-1)?.detail}`,
			);
		}
		const report = result.report;

		expect(report.did).toBe(moved.did);
		expect(report.repoImported).toBe(true);
		// The Library, the creator's studio, the gated Work's space and one empty space.
		expect(report.spaces).toHaveLength(4);
		expect(report.spaces.find((space) => space.spaceUri === moved.spaceUri)).toMatchObject({
			records: 1,
			blobs: 1,
			members: 1,
			recordsMatched: 1,
			commitMatches: true,
		});
		expect(report.spaces.find((space) => space.spaceUri === moved.creator.studio)).toMatchObject({
			records: 1,
			blobs: 0,
			members: 0,
			recordsMatched: 1,
			commitMatches: true,
		});
		expect(report.spaces.find((space) => space.spaceUri === moved.creator.gated)).toMatchObject({
			records: 1,
			blobs: 0,
			recordsMatched: 1,
			commitMatches: true,
		});
		// No records, so no commit to compare: `null`, not a failure.
		expect(report.spaces.find((space) => space.spaceUri === moved.creator.empty)).toMatchObject({
			records: 0,
			recordsMatched: 0,
			commitMatches: null,
		});
		expect(report.didPointsAtNew).toBe(true);
		// The staging identity was created directly on the old PDS, not through Anthers' hosting,
		// so there is no hosted row to retire; the drill retires the server itself below.
		expect(report.retired).toBe("none");

		const [row] = await db
			.select({ atprotoPdsUrl: users.atprotoPdsUrl })
			.from(users)
			.where(eq(users.id, moved.userId));
		expect(row?.atprotoPdsUrl).toBe(network.newPds);

		// Sign in on the new server and read the space back with a client the move did not use.
		const fresh = await xrpc<{ accessJwt: string }>(
			network.newPds,
			"com.atproto.server.createSession",
			{
				body: { identifier: moved.handle, password: moved.password },
			},
		);
		const reader = new SpaceClient({ baseUrl: network.newPds, token: fresh.accessJwt });
		const records = await reader.listRecords({
			space: moved.spaceUri,
			repo: moved.did,
			collection: USER_SPACE_COLLECTIONS.workSave,
		});
		expect(records.records).toHaveLength(1);
		const blob = (records.records[0].value as { blob: { ref: { $link: string } } }).blob;
		const bytes = await reader.getBlob({
			space: moved.spaceUri,
			repo: moved.did,
			cid: blob.ref.$link,
		});
		expect([...bytes.bytes]).toEqual([...SAVE]);
		const members = await reader.listMembers(moved.spaceUri);
		expect(members.members).toHaveLength(1);

		// The creator's records arrived with their addresses and their media pointers intact.
		const manifest = await reader.getRecord({
			space: moved.creator.gated,
			repo: moved.did,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
		});
		const manifestFiles = (manifest.value as { files: Array<{ key: string }> }).files;
		expect(manifestFiles[0]?.key).toBe(moved.creator.mediaKey);
		// ⚠️ The move carries the pointer, not the bytes: R2 is the home of the media, and the
		// check is that the pointer still resolves rather than that the space holds a blob.
		expect(await storage.size(moved.creator.mediaKey)).toBeGreaterThan(0);
		const draft = await reader.getRecord({
			space: moved.creator.studio,
			repo: moved.did,
			collection: CREATOR_SPACE_COLLECTIONS.draft,
			rkey: String(moved.creator.publicId),
		});
		expect(draft.value).toMatchObject({ publicId: moved.creator.publicId, title: "Nightjar" });
	});

	it("leaves the old copy intact when the move cannot start", async () => {
		// A second account on the old server, then a target that does not answer. The failure is
		// before the PLC operation, so nothing about the old identity may have changed.
		const survivor = await stage(network, "sv");

		const result = await moveAccount(survivor.userId, {
			target: {
				pdsUrl: "http://127.0.0.1:9",
				email: survivor.email,
				password: survivor.password,
			},
			plcToken: "not-used",
			resolveSession: survivor.resolveSession,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("move_failed");

		// The old PDS still has the Library space, the record and the blob, and the creator's
		// spaces were never reached because the move failed before the PLC operation.
		const client = spaceClientFor({
			did: survivor.did,
			pdsUrl: network.oldPds,
			token: survivor.token,
		});
		const records = await client.listRecords({
			space: survivor.spaceUri,
			repo: survivor.did,
			collection: USER_SPACE_COLLECTIONS.workSave,
		});
		expect(records.records).toHaveLength(1);
		const blob = (records.records[0].value as { blob: { ref: { $link: string } } }).blob;
		const bytes = await client.getBlob({
			space: survivor.spaceUri,
			repo: survivor.did,
			cid: blob.ref.$link,
		});
		expect([...bytes.bytes]).toEqual([...SAVE]);

		const doc = (await (
			await fetch(`${network.plc}/${encodeURIComponent(survivor.did)}`)
		).json()) as {
			service?: Array<{ serviceEndpoint?: string }>;
		};
		expect(doc.service?.[0]?.serviceEndpoint).toBe(network.oldPds);
	});

	it("keeps serving from the new PDS after the old one is retired", async () => {
		const retired = await fetch(`${CONTROL}/retire-old`, { method: "POST" });
		expect(retired.ok).toBe(true);

		// The old server is gone.
		await expect(
			fetch(`${network.oldPds}/xrpc/com.atproto.server.describeServer`),
		).rejects.toThrow();

		// The new one still answers for the moved identity.
		const fresh = await xrpc<{ accessJwt: string }>(
			network.newPds,
			"com.atproto.server.createSession",
			{
				body: { identifier: moved.handle, password: moved.password },
			},
		);
		const reader = new SpaceClient({ baseUrl: network.newPds, token: fresh.accessJwt });
		const records = await reader.listRecords({
			space: moved.spaceUri,
			repo: moved.did,
			collection: USER_SPACE_COLLECTIONS.workSave,
		});
		expect(records.records).toHaveLength(1);
		const describe = await xrpc<{ did: string }>(
			network.newPds,
			"com.atproto.server.describeServer",
		);
		expect(describe.did).toBeTruthy();
	});
});
