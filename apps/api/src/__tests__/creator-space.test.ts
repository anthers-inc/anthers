// SPDX-License-Identifier: Apache-2.0
/**
 * The creator-space sync, over the fake PDS: the two spaces, the two records, and the order
 * that makes the listing's pointer true.
 *
 * What the fake cannot hold is the protocol's refusal of an outsider's ordinary session; that
 * is `space-gate-staging.test.ts`'s sibling and the staging scenario below it. Here the subject
 * is our own mapping: which Work writes which record into which space, what the record says,
 * and what a second run does.
 */
import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	gatedSpaceUri,
	linkCreatorSpace,
	removeCreatorSpace,
	studioSpaceUri,
	syncCreatorSpace,
} from "../services/creator-space.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	GATED_MANIFEST_RKEY,
} from "../services/creator-space-records.js";
import { managingAppFor } from "../services/managing-app.js";
import { CREATOR_SPACE_TYPE } from "../services/space-gate.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { FakeSpacePds } from "./space-fake.js";
import { insertWork, type WorkFixture } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const MANAGING_APP = managingAppFor("http://localhost:4321");

interface Context {
	pds: FakeSpacePds;
	userId: number;
	did: string;
	resolveSession: ResolveSpaceSession;
}

let counter = 0;

async function context(): Promise<Context> {
	counter += 1;
	const account = await createAccount(`creator-space-${counter}`);
	const pds = new FakeSpacePds();
	pds.sessionDid = account.did;
	const session = { did: account.did, pdsUrl: "http://fake.pds", token: "token" };
	const resolveSession: ResolveSpaceSession = async (userId) =>
		userId === account.userId ? { session } : { session: null, reason: "not_hosted" };
	return { pds, userId: account.userId, did: account.did, resolveSession };
}

async function work(ctx: Context, fixture: Partial<WorkFixture> & { type: string }) {
	return insertWork({ creatorId: ctx.userId, ...fixture });
}

function sync(ctx: Context, workId: number) {
	return syncCreatorSpace(workId, {
		resolveSession: ctx.resolveSession,
		managingApp: MANAGING_APP,
		fetchImpl: ctx.pds.fetch,
	});
}

describe("creator spaces", () => {
	it("writes a private Work's draft into the creator's own space and nothing gated", async () => {
		const ctx = await context();
		const row = await work(ctx, {
			type: "text",
			title: "Nightjar",
			description: "A novel.",
			visibility: "private",
			sourceKey: `creators/${ctx.userId}/media/nightjar.pdf`,
		});

		const result = await sync(ctx, row.id);
		const studio = studioSpaceUri(ctx.did);
		expect(result.refs.draftUri).toBe(
			`${studio}/${ctx.did}/${CREATOR_SPACE_COLLECTIONS.draft}/${row.publicId}`,
		);
		expect(result.refs.spaceUri).toBeNull();
		expect(result.refs.manifestUri).toBeNull();

		// The space is the creator's alone: the member-list policy with no members.
		expect(ctx.pds.spaces.get(studio)?.readPolicy).toEqual({
			$type: "com.atproto.simplespace.defs#memberListPolicy",
		});

		const drafts = ctx.pds.recordsIn(studio, CREATOR_SPACE_COLLECTIONS.draft);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.value).toMatchObject({
			$type: CREATOR_SPACE_COLLECTIONS.draft,
			publicId: row.publicId,
			kind: "text",
			title: "Nightjar",
			files: [{ role: "source", key: `creators/${ctx.userId}/media/nightjar.pdf` }],
		});
		// Nobody has published it, so the draft points at nothing yet.
		expect((drafts[0]?.value as { publishedAs?: string }).publishedAs).toBeUndefined();

		const [stored] = await db
			.select({ draftUri: works.draftUri, gatedSpaceUri: works.gatedSpaceUri })
			.from(works)
			.where(eq(works.id, row.id));
		expect(stored?.draftUri).toBe(result.refs.draftUri);
		expect(stored?.gatedSpaceUri).toBeNull();
	});

	it("writes a gated Work's manifest into its own space, naming Anthers as the managing app", async () => {
		const ctx = await context();
		const row = await work(ctx, {
			type: "game",
			title: "Nightjar",
			visibility: "released",
			downloadEnabled: true,
			access: [{ threshold: 0, allow: true, price: "5.00" }],
			sourceKey: `creators/${ctx.userId}/media/nightjar.zip`,
		});
		await db.insert(assets).values({
			workId: row.id,
			file: `creators/${ctx.userId}/builds/nightjar-linux.tar.gz`,
			filename: "nightjar-linux.tar.gz",
			fileSize: 48_000_000,
			mimeType: "application/gzip",
			platform: "linux",
			version: "1.0",
		});

		const result = await sync(ctx, row.id);
		const space = gatedSpaceUri(ctx.did, row.publicId);
		expect(result.refs.spaceUri).toBe(space);
		expect(result.refs.manifestUri).toBe(
			`${space}/${ctx.did}/${CREATOR_SPACE_COLLECTIONS.manifest}/${GATED_MANIFEST_RKEY}`,
		);

		// The audience is decided by Anthers on every credential request, not by a member list.
		expect(ctx.pds.spaces.get(space)?.readPolicy).toEqual({
			$type: "com.atproto.simplespace.defs#managingAppPolicy",
			managingApp: MANAGING_APP.serviceId,
		});

		const manifests = ctx.pds.recordsIn(space, CREATOR_SPACE_COLLECTIONS.manifest);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.value).toMatchObject({
			$type: CREATOR_SPACE_COLLECTIONS.manifest,
			publicId: row.publicId,
			kind: "game",
			title: "Nightjar",
			files: [
				{ role: "source", key: `creators/${ctx.userId}/media/nightjar.zip` },
				{
					role: "download",
					name: "nightjar-linux.tar.gz",
					key: `creators/${ctx.userId}/builds/nightjar-linux.tar.gz`,
					bytes: 48_000_000,
					platform: "linux",
				},
			],
		});

		const [stored] = await db
			.select({ gatedSpaceUri: works.gatedSpaceUri, manifestUri: works.manifestUri })
			.from(works)
			.where(eq(works.id, row.id));
		expect(stored?.gatedSpaceUri).toBe(space);
		expect(stored?.manifestUri).toBe(result.refs.manifestUri);
	});

	it("leaves an open Work with no gated space at all", async () => {
		const ctx = await context();
		const row = await work(ctx, {
			type: "text",
			title: "Open",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "0" }],
		});

		const result = await sync(ctx, row.id);
		expect(result.refs.draftUri).not.toBeNull();
		expect(result.refs.spaceUri).toBeNull();
		// Only the creator's own space (`self`), never one keyed by the Work.
		expect(ctx.pds.spaces.has(gatedSpaceUri(ctx.did, row.publicId))).toBe(false);
		expect(ctx.pds.spaces.has(studioSpaceUri(ctx.did))).toBe(true);
	});

	it("converges on a second run and fills the one pointer the order of writes defers", async () => {
		const ctx = await context();
		const row = await work(ctx, {
			type: "text",
			title: "Nightjar",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
		});

		const first = await sync(ctx, row.id);
		const studio = studioSpaceUri(ctx.did);
		expect(ctx.pds.recordsIn(studio, CREATOR_SPACE_COLLECTIONS.draft)).toHaveLength(1);

		const listing = `at://${ctx.did}/org.anthers.work/3kabc`;
		await linkCreatorSpace(first, listing, null, { fetchImpl: ctx.pds.fetch });

		const draft = ctx.pds.recordsIn(studio, CREATOR_SPACE_COLLECTIONS.draft)[0];
		expect((draft?.value as { publishedAs?: string }).publishedAs).toBe(listing);
		const manifest = ctx.pds.recordsIn(
			gatedSpaceUri(ctx.did, row.publicId),
			CREATOR_SPACE_COLLECTIONS.manifest,
		)[0];
		expect((manifest?.value as { work?: string }).work).toBe(listing);

		// A second sync writes the same records again rather than creating a second space. The
		// type holds the creator's `self` space and this Work's gated one, so the count is two.
		const second = await sync(ctx, row.id);
		expect(
			[...ctx.pds.spaces.keys()].filter((uri) => uri.endsWith(`/${CREATOR_SPACE_TYPE}/self`)),
		).toHaveLength(1);
		expect(ctx.pds.spaces.has(gatedSpaceUri(ctx.did, row.publicId))).toBe(true);
		expect(ctx.pds.recordsIn(studio, CREATOR_SPACE_COLLECTIONS.draft)).toHaveLength(1);

		// Taking the listing down clears the pointer; it does not delete the creator's copy.
		await linkCreatorSpace(second, null, listing, { fetchImpl: ctx.pds.fetch });
		const cleared = ctx.pds.recordsIn(studio, CREATOR_SPACE_COLLECTIONS.draft)[0];
		expect((cleared?.value as { publishedAs?: string }).publishedAs).toBeUndefined();
	});

	it("removes a deleted Work's gated space and draft, and keeps the creator's studio", async () => {
		const ctx = await context();
		const row = await work(ctx, {
			type: "text",
			title: "Nightjar",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
		});
		await sync(ctx, row.id);
		const studio = studioSpaceUri(ctx.did);
		const gated = gatedSpaceUri(ctx.did, row.publicId);
		expect(ctx.pds.spaces.has(studio)).toBe(true);
		expect(ctx.pds.spaces.has(gated)).toBe(true);

		await removeCreatorSpace(
			{
				creatorId: ctx.userId,
				publicId: row.publicId,
				draftUri: `${studio}/${ctx.did}/${CREATOR_SPACE_COLLECTIONS.draft}/${row.publicId}`,
				gatedSpaceUri: gated,
			},
			{ resolveSession: ctx.resolveSession, fetchImpl: ctx.pds.fetch },
		);

		expect(ctx.pds.spaces.has(gated)).toBe(false);
		expect(ctx.pds.recordsIn(studio, CREATOR_SPACE_COLLECTIONS.draft)).toHaveLength(0);
		expect(ctx.pds.spaces.has(studio)).toBe(true);
	});

	it("treats a server with no space endpoints as an ordinary skip", async () => {
		// The production image's PDS still tracks `main`, which has no space lexicons. That is a
		// skip rather than a failure, so the feature can ship and start working when the image
		// does — and a listing sync does not log an error for every edit until then.
		const ctx = await context();
		const row = await work(ctx, { type: "text", title: "Nightjar", visibility: "private" });
		const unsupported = (async () =>
			new Response(JSON.stringify({ error: "MethodNotImplemented" }), {
				status: 501,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const result = await syncCreatorSpace(row.id, {
			resolveSession: ctx.resolveSession,
			managingApp: MANAGING_APP,
			fetchImpl: unsupported,
		});
		expect(result.skipped).toBe("unsupported");
		expect(result.refs.draftUri).toBeNull();
	});

	it("writes nothing for a quarantined Work, and reports why", async () => {
		const ctx = await context();
		const row = await work(ctx, {
			type: "text",
			title: "Held",
			visibility: "private",
		});
		await db.update(works).set({ quarantineStatus: "quarantined" }).where(eq(works.id, row.id));

		const result = await sync(ctx, row.id);
		expect(result.skipped).toBe("quarantined");
		expect(ctx.pds.spaces.size).toBe(0);
	});
});
