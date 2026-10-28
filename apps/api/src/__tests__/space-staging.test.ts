// SPDX-License-Identifier: Apache-2.0
/**
 * The user-space outbox against a real spaces-capable PDS.
 *
 * This is the Phase 1 gate in executable form: the same outbox the worker runs, against the
 * branch's PDS, with no fake in the transport. It is skipped unless `SPACE_STAGING_PDS_URL`
 * names a server, because no CI run has one and a test that quietly pointed at the real
 * network would be the one mistake this project cannot take back.
 *
 * The server is the lab's dev environment:
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/network.mjs
 *   SPACE_STAGING_PDS_URL=http://127.0.0.1:2683 bun test apps/api/src/__tests__/space-staging.test.ts
 *
 * ⚠️ **The local account is a `users` row and nothing else.** The space belongs to the
 * staging identity, which is created on the staging server; the fixture account exists so the
 * registry and the outbox have a real foreign key to hang on, and it is deleted with the
 * space at the end. The two DIDs are deliberately different — the test is about the outbox,
 * not about which account created the identity.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { userLibraryItems, userSpaces } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { SpaceClient } from "../services/atproto-space.js";
import { drainSpaceOutbox, enqueueLibraryItem } from "../services/space-outbox.js";
import { rebuildLibraryProjection } from "../services/space-projection.js";
import { type LibraryItemState, USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { ensureUserSpace, reconcileUserSpace, userSpaceUri } from "../services/space-registry.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const PDS_URL = process.env.SPACE_STAGING_PDS_URL ?? null;

purgeAccountsCreatedHere();

const staged = PDS_URL ? describe : describe.skip;

staged("the user-space outbox against a staging PDS", () => {
	let did = "";
	let token = "";
	let userId = 0;
	let workId = 0;
	let spaceUri = "";
	let resolveSession: ResolveSpaceSession;

	/** A fetch that can fail a read-back or die after a write, around the real transport. */
	function transport(options: { corruptNextRead?: boolean; killNextPut?: boolean }) {
		return (async (input: URL | string, init?: RequestInit) => {
			const url = new URL(input.toString());
			const method = url.pathname.replace(/^\/xrpc\//, "");
			if (method === "com.atproto.space.getRecord" && options.corruptNextRead) {
				options.corruptNextRead = false;
				const response = await fetch(input.toString(), init);
				const body = (await response.json()) as Record<string, unknown>;
				return new Response(JSON.stringify({ ...body, cid: "bafycorruptedreadback" }), {
					status: response.status,
					headers: { "content-type": "application/json" },
				});
			}
			if (method === "com.atproto.space.putRecord" && options.killNextPut) {
				options.killNextPut = false;
				await fetch(input.toString(), init);
				throw new Error("simulated kill after the write landed");
			}
			return fetch(input.toString(), init);
		}) as typeof fetch;
	}

	async function xrpc(method: string, body: Record<string, unknown>, auth?: string) {
		const response = await fetch(new URL(`/xrpc/${method}`, PDS_URL as string), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(auth ? { authorization: `Bearer ${auth}` } : {}),
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		if (!response.ok) {
			throw new Error(`${method}: ${response.status} ${String(data.error ?? text)}`);
		}
		return data;
	}

	async function setUp(): Promise<void> {
		if (spaceUri) return;
		const handle = `outbox-${Date.now().toString(36)}.spaces.test`;
		const created = (await xrpc("com.atproto.server.createAccount", {
			handle,
			email: `outbox-${Date.now().toString(36)}@example.com`,
			password: `outbox-${crypto.randomUUID()}`,
		})) as { did: string; accessJwt: string };
		did = created.did;
		token = created.accessJwt;

		// The local side: an account row for the foreign keys, and a Work to keep.
		const account = await createAccount(`spaces-staging-${Date.now().toString(36)}`);
		userId = account.userId;
		const work = await insertWork({ creatorId: userId, type: "text", title: "Nightjar" });
		workId = work.id;

		resolveSession = async (id) =>
			id === userId
				? { session: { did, pdsUrl: PDS_URL as string, token } }
				: { session: null, reason: "not_hosted" };

		const ensured = await ensureUserSpace(userId, { resolveSession });
		if (!ensured.space) throw new Error(`space was not created: ${ensured.reason}`);
		spaceUri = ensured.space.spaceUri;
	}

	function entry(overrides: Partial<LibraryItemState> = {}): LibraryItemState {
		return {
			subject: { kind: "work", id: workId, uri: null },
			hidden: false,
			sortOrder: 1,
			savedAt: new Date(),
			...overrides,
		};
	}

	it("01: a verified write, commit and oplog against the branch's PDS", async () => {
		await setUp();
		expect(spaceUri).toBe(userSpaceUri(did));

		await enqueueLibraryItem(userId, entry());
		const report = await drainSpaceOutbox({ resolveSession });
		expect(report.cleared).toBe(1);
		expect(report.failures).toEqual([]);

		// Read it back with a fresh client, outside the outbox, so the check is not the
		// outbox agreeing with itself.
		const client = new SpaceClient({ baseUrl: PDS_URL as string, token });
		const records = await client.listRecords({
			space: spaceUri,
			repo: did,
			collection: USER_SPACE_COLLECTIONS.libraryItem,
		});
		expect(records.records).toHaveLength(1);
		expect(records.records[0].value).toMatchObject({ subject: { id: workId } });

		const commit = await client.getLatestCommit({ space: spaceUri, repo: did });
		expect(commit.commit.space).toBe(spaceUri);
		const ops = await client.listRepoOps({ space: spaceUri, repo: did });
		expect(
			ops.ops.some(
				(op) =>
					op.collection === USER_SPACE_COLLECTIONS.libraryItem && op.cid === records.records[0].cid,
			),
		).toBe(true);

		const [library] = await db
			.select()
			.from(userLibraryItems)
			.where(and(eq(userLibraryItems.userId, userId), eq(userLibraryItems.workId, workId)));
		expect(library).toBeTruthy();
	});

	it("01F: a read-back the PDS answers wrongly keeps the row and the record", async () => {
		await setUp();
		await enqueueLibraryItem(userId, entry({ hidden: true }));
		const failed = await drainSpaceOutbox({
			resolveSession,
			fetchImpl: transport({ corruptNextRead: true }),
		});
		expect(failed.cleared).toBe(0);
		expect(failed.failures[0]?.kind).toBe("verification");

		const client = new SpaceClient({ baseUrl: PDS_URL as string, token });
		const records = await client.listRecords({
			space: spaceUri,
			repo: did,
			collection: USER_SPACE_COLLECTIONS.libraryItem,
		});
		expect(records.records.some((record) => (record.value as { hidden?: boolean }).hidden)).toBe(
			true,
		);

		const retried = await drainSpaceOutbox({
			resolveSession,
			now: new Date(Date.now() + 60_000),
		});
		expect(retried.cleared).toBe(1);
	});

	it("02: a write that landed before a kill converges on the retry", async () => {
		await setUp();
		await enqueueLibraryItem(userId, entry({ hidden: false, sortOrder: 2 }));
		const killed = await drainSpaceOutbox({
			resolveSession,
			fetchImpl: transport({ killNextPut: true }),
		});
		expect(killed.cleared).toBe(0);

		const recovered = await drainSpaceOutbox({
			resolveSession,
			now: new Date(Date.now() + 60_000),
		});
		expect(recovered.cleared).toBe(1);

		const client = new SpaceClient({ baseUrl: PDS_URL as string, token });
		const records = await client.listRecords({
			space: spaceUri,
			repo: did,
			collection: USER_SPACE_COLLECTIONS.libraryItem,
		});
		expect(records.records).toHaveLength(1);
	});

	it("08: rebuilds the Library from the space alone", async () => {
		await setUp();
		await db.delete(userLibraryItems).where(eq(userLibraryItems.userId, userId));
		const rebuilt = await rebuildLibraryProjection(userId, { resolveSession });
		if ("reason" in rebuilt) throw new Error(`rebuild failed: ${rebuilt.reason}`);
		expect(rebuilt.inserted).toBe(1);
		expect(rebuilt.scanned).toBe(1);
	});

	it("09: repairs a corrupted registry address from listSpaces", async () => {
		await setUp();
		await db
			.update(userSpaces)
			.set({
				spaceUri: `at://${did}/space/org.anthers.userSpace/not-self`,
				verifiedAt: null,
			})
			.where(eq(userSpaces.userId, userId));

		const reconciled = await reconcileUserSpace(userId, { resolveSession });
		expect(reconciled.space?.spaceUri).toBe(spaceUri);
		expect(reconciled.space?.lastError).toContain("repaired");
	});

	afterAll(async () => {
		// Dispose of the staging space and the local account. The server is the lab's and
		// disposable, but leaving a space behind would make the next run's `listSpaces` noisier
		// for no reason.
		if (token && spaceUri) {
			await xrpc("com.atproto.simplespace.deleteSpace", { space: spaceUri }, token).catch(
				() => undefined,
			);
		}
	});
});
