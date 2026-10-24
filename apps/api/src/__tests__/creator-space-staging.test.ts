// SPDX-License-Identifier: Apache-2.0
/**
 * The creator draft and the gated manifest against the branch's real PDS — the lab's scenario
 * 04, driven through the services the Studio's job calls.
 *
 * What only this test can hold is the protocol's own refusals: that the creator reads the draft
 * and the manifest with their ordinary session, that an outsider's ordinary session is answered
 * `RepoNotFound` because a member's repo in a space needs a space credential, and that the
 * public listing the repository serves says `gated` and points at both records. The fake PDS
 * tests the mapping; this tests the addresses.
 *
 * ⚠️ **The read of the manifest as an entitled outsider is deliberately not here.** That needs
 * an HTTP message signature and an `atproto-space-want-mac` key share, which is the reader-side
 * credential client rather than the gate. The lab's 05, 07 and 11 hold that path; this holds the
 * creator's copy and the refusal.
 *
 * Skipped unless `SPACE_STAGING_PDS_URL` names a server:
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/network.mjs
 *   SPACE_STAGING_PDS_URL=http://127.0.0.1:2683 \
 *     bun test apps/api/src/__tests__/creator-space-staging.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { createManagingAppRoutes } from "../routes/managing-app.js";
import type { RepoWriter } from "../services/atproto-repo.js";
import { rkeyFromAtUri, syncWorkRecord } from "../services/atproto-repo.js";
import { SpaceClient } from "../services/atproto-space.js";
import {
	gatedSpaceUri,
	linkCreatorSpace,
	studioSpaceUri,
	syncCreatorSpace,
} from "../services/creator-space.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	draftWorkRkey,
	GATED_MANIFEST_RKEY,
} from "../services/creator-space-records.js";
import { managingAppFor } from "../services/managing-app.js";
import type { ResolveDid } from "../services/service-auth.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const PDS_URL = process.env.SPACE_STAGING_PDS_URL ?? null;
const PLC_URL = process.env.SPACE_STAGING_PLC_URL ?? "http://127.0.0.1:2682";

purgeAccountsCreatedHere();

const staged = PDS_URL ? describe : describe.skip;

interface Account {
	did: string;
	token: string;
	handle: string;
}

async function xrpc<T>(
	method: string,
	options: { body?: unknown; params?: Record<string, string>; token?: string } = {},
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
	const name = `${label}-${crypto.randomUUID().slice(0, 6)}`;
	const handle = `${name}.spaces.test`;
	const created = await xrpc<{ did: string; accessJwt: string; handle: string }>(
		"com.atproto.server.createAccount",
		{
			body: {
				handle,
				email: `${name}@example.com`,
				password: `space-${crypto.randomUUID()}`,
			},
		},
	);
	return { did: created.did, token: created.accessJwt, handle };
}

/** A repository writer over the staging account's own token, for the public listing. */
function repoWriter(did: string, token: string): RepoWriter {
	return {
		did,
		async createRecord(collection, record) {
			const answer = await xrpc<{ uri: string; cid: string }>("com.atproto.repo.createRecord", {
				body: { repo: did, collection, record, validate: false },
				token,
			});
			return { uri: answer.uri, cid: answer.cid };
		},
		async putRecord(collection, rkey, record) {
			const answer = await xrpc<{ uri: string; cid: string }>("com.atproto.repo.putRecord", {
				body: { repo: did, collection, rkey, record, validate: false },
				token,
			});
			return { uri: answer.uri, cid: answer.cid };
		},
		async deleteRecord(collection, rkey) {
			await xrpc("com.atproto.repo.deleteRecord", {
				body: { repo: did, collection, rkey },
				token,
			});
		},
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

staged("the creator draft and the gated manifest against a staging PDS", () => {
	let server: ReturnType<typeof Bun.serve> | undefined;
	let creator: Account;
	let outsider: Account;
	let userId = 0;
	let workId = 0;
	let publicId = 0;
	let resolveSession: ResolveSpaceSession;
	let studio = "";
	let gated = "";

	beforeAll(async () => {
		// The managing app the gated space names: a real DID document and checkUserAccess route,
		// so the PDS has somebody to resolve. Authorization is answered for nobody in particular
		// here; the read this suite proves is the owner's.
		const app = createManagingAppRoutes({
			resolveDid,
			authorize: async () => ({ authorized: true, reason: "entitled" }),
		});
		server = Bun.serve({ port: 0, fetch: app.fetch });

		creator = await account("cd");
		outsider = await account("co");

		const local = await createAccount(`creator-space-staging-${Date.now().toString(36)}`);
		userId = local.userId;
		const work = await insertWork({
			creatorId: userId,
			type: "text",
			title: "Nightjar",
			description: "A novel.",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
			sourceKey: `creators/${userId}/media/nightjar.epub`,
		});
		workId = work.id;
		publicId = work.publicId;
		await db.insert(assets).values({
			workId,
			file: `creators/${userId}/builds/nightjar-audio.zip`,
			filename: "nightjar-audio.zip",
			fileSize: 74_500_000,
			mimeType: "application/zip",
		});

		resolveSession = async (id) =>
			id === userId
				? { session: { did: creator.did, pdsUrl: PDS_URL as string, token: creator.token } }
				: { session: null, reason: "not_hosted" };
	});

	afterAll(async () => {
		// The lab network is disposable, but leaving spaces behind makes the next run's
		// `listSpaces` noisier for no reason.
		if (creator?.token) {
			for (const space of [gated, studio].filter(Boolean)) {
				await xrpc("com.atproto.simplespace.deleteSpace", {
					body: { space },
					token: creator.token,
				}).catch(() => undefined);
			}
		}
		server?.stop(true);
	});

	it("writes the draft, the manifest and a listing that points at both", async () => {
		const sync = await syncCreatorSpace(workId, {
			resolveSession,
			managingApp: managingAppFor(`http://localhost:${server?.port}`),
		});
		studio = studioSpaceUri(creator.did);
		gated = gatedSpaceUri(creator.did, publicId);
		const spaceUri = gated;
		const manifestUri = `${gated}/${creator.did}/${CREATOR_SPACE_COLLECTIONS.manifest}/${GATED_MANIFEST_RKEY}`;
		expect(sync.refs.draftUri).toBe(
			`${studio}/${creator.did}/${CREATOR_SPACE_COLLECTIONS.draft}/${draftWorkRkey(publicId)}`,
		);
		expect(sync.refs.spaceUri).toBe(spaceUri);
		expect(sync.refs.manifestUri).toBe(manifestUri);

		// The creator reads their own draft with an ordinary session.
		const client = new SpaceClient({ baseUrl: PDS_URL as string, token: creator.token });
		const draft = await client.getRecord({
			space: studio,
			repo: creator.did,
			collection: CREATOR_SPACE_COLLECTIONS.draft,
			rkey: draftWorkRkey(publicId),
		});
		expect(draft.value).toMatchObject({ title: "Nightjar", publicId });
		const draftFiles = (draft.value as { files: Array<{ role: string; key: string }> }).files;
		expect(
			draftFiles.some(
				(file) => file.role === "source" && file.key === `creators/${userId}/media/nightjar.epub`,
			),
		).toBe(true);

		const manifest = await client.getRecord({
			space: gated,
			repo: creator.did,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
		});
		expect(manifest.value).toMatchObject({
			publicId,
			files: [
				{ role: "source", key: `creators/${userId}/media/nightjar.epub` },
				{ role: "download", name: "nightjar-audio.zip", bytes: 74_500_000 },
			],
		});

		// The public listing lands in the creator's normal repository and points at the space.
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		const writer = repoWriter(creator.did, creator.token);
		const outcome = await syncWorkRecord(writer, row, {
			baseUrl: "https://anthers.org",
			existingUri: null,
			confirmedCredits: new Set<string>(),
			accessPointers: { space: spaceUri, manifest: manifestUri },
		});
		const atUri = outcome.uri as string;
		const rkey = rkeyFromAtUri(atUri, "org.anthers.work");
		expect(rkey).not.toBeNull();
		expect(outcome.plan.action).toBe("create");
		if (outcome.plan.action !== "create") throw new Error("expected a create");
		expect(outcome.plan.record.access).toEqual({
			state: "gated",
			space: spaceUri,
			manifest: manifestUri,
		});

		// The same listing read signed out, which is what the network sees.
		const anonymous = await xrpc<{ uri: string; value: { access?: Record<string, string> } }>(
			"com.atproto.repo.getRecord",
			{ params: { repo: creator.did, collection: "org.anthers.work", rkey: rkey as string } },
		);
		expect(anonymous.value.access?.space).toBe(spaceUri);
		expect(anonymous.value.access?.manifest).toBe(manifestUri);

		// The manifest is not in the public repository, and the outsider's ordinary session
		// cannot read the space that holds it: a member's repo in a space needs a credential.
		await expect(
			xrpc("com.atproto.repo.getRecord", {
				params: {
					repo: creator.did,
					collection: CREATOR_SPACE_COLLECTIONS.manifest,
					rkey: GATED_MANIFEST_RKEY,
				},
			}),
		).rejects.toMatchObject({ error: "RecordNotFound" });

		const outsiderClient = new SpaceClient({ baseUrl: PDS_URL as string, token: outsider.token });
		await expect(
			outsiderClient.getRecord({
				space: gated,
				repo: creator.did,
				collection: CREATOR_SPACE_COLLECTIONS.manifest,
				rkey: GATED_MANIFEST_RKEY,
			}),
		).rejects.toMatchObject({ error: "RepoNotFound" });
		await expect(
			outsiderClient.getRecord({
				space: studio,
				repo: creator.did,
				collection: CREATOR_SPACE_COLLECTIONS.draft,
				rkey: draftWorkRkey(publicId),
			}),
		).rejects.toMatchObject({ error: "RepoNotFound" });

		// The one pointer the order of writes defers: the draft and manifest name the listing.
		await linkCreatorSpace(sync, atUri, null);
		const linkedDraft = await client.getRecord({
			space: studio,
			repo: creator.did,
			collection: CREATOR_SPACE_COLLECTIONS.draft,
			rkey: draftWorkRkey(publicId),
		});
		expect((linkedDraft.value as { publishedAs?: string }).publishedAs).toBe(atUri);
		const linkedManifest = await client.getRecord({
			space: gated,
			repo: creator.did,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
		});
		expect((linkedManifest.value as { work?: string }).work).toBe(atUri);
	});
});
