// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A creator's post and project records, written into a repository Anthers hosts, against a real
 * server.
 *
 * `atproto-creator-records.test.ts` proves the *mapping* in milliseconds and
 * `atproto-record-plan.test.ts` proves the *decision* against a fake repository. This proves the
 * third thing neither can: that a post in the database, belonging to a creator whose credential
 * is sealed in `hosted_accounts`, ends up with a record in **that creator's** repository and a
 * URI in its row — and loses both when the creator takes it down.
 *
 * 🚨 **The retraction cases are why this file exists.** `posts.published_at` is stamped once and
 * never cleared, so a retracted post is a row saying `is_published = false` beside a date saying
 * when it went live, and an earlier version of the mapper read that row as publishable. Against a
 * fake repository that mistake is a plan object with the wrong word in it; here it is a record
 * still readable on a server after its creator took the post down, which is what it would
 * actually be.
 *
 * 🚨 **It refuses to run unless `ATPROTO_TEST_PDS` names a server.** A record on a real server is
 * world-readable the moment it lands and is broadcast to everyone listening; deleting it
 * afterwards broadcasts only the deletion, so anyone who kept a copy keeps it. Requiring the
 * operator to name the target is what stops this reaching production by defaulting to something.
 *
 *   make pds-up && make pds-test
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts, posts, projects, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import { POST_COLLECTION, PROJECT_COLLECTION } from "../services/atproto-record-plan.js";
import { removeAtprotoRecord } from "../services/atproto-record-removal.js";
import { syncPostRecord, syncProjectRecord } from "../services/creator-record-listing.js";
import { setPublishedLexiconsForTesting } from "../services/published-lexicons.js";
import { purgeAccountsCreatedHere } from "./cleanup";

const SERVICE = process.env.ATPROTO_TEST_PDS;

purgeAccountsCreatedHere();

const RUN = `cr${Date.now().toString(36)}`;
// Base 36 rather than a plain timestamp: the server refuses a long first segment outright, and
// `.test` is the domain a development PDS offers.
const handle = `probe-${Date.now().toString(36)}c.test`;
const password = `probe-${crypto.randomUUID()}`;

const before = { url: process.env.HOSTED_PDS_URL, key: process.env.HOSTED_ACCOUNT_KEY };

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(() => {
	if (!SERVICE) return;
	process.env.HOSTED_PDS_URL = SERVICE;
	// ⚠️ Neither schema is published, so the gate would rightly write nothing. A throwaway server
	// is the one place a draft schema's records may land, and opening the gate here is what lets
	// this suite exercise the rest of the production path.
	setPublishedLexiconsForTesting(["org.anthers.work", "org.anthers.post", "org.anthers.project"]);
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterAll(async () => {
	restore("HOSTED_PDS_URL", before.url);
	setPublishedLexiconsForTesting(undefined);
	restore("HOSTED_ACCOUNT_KEY", before.key);
	await db.delete(posts).where(like(posts.slug, `${RUN}%`));
	await db.delete(projects).where(like(projects.slug, `${RUN}%`));
	await db.delete(hostedAccounts).where(like(hostedAccounts.did, `%${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

let creatorId = 0;
let postId = 0;
let projectId = 0;
let did = "";

/** Whether a record is still readable on the server. The only question this file really asks. */
async function recordExists(collection: string, uri: string | null): Promise<boolean> {
	if (!uri) return false;
	const res = await fetch(
		`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${did}` +
			`&collection=${collection}&rkey=${uri.split("/").pop()}`,
	);
	return res.ok;
}

async function postUri(): Promise<string | null> {
	const [row] = await db.select({ uri: posts.atprotoUri }).from(posts).where(eq(posts.id, postId));
	return row?.uri ?? null;
}

async function projectUri(): Promise<string | null> {
	const [row] = await db
		.select({ uri: projects.atprotoUri })
		.from(projects)
		.where(eq(projects.id, projectId));
	return row?.uri ?? null;
}

describe.skipIf(!SERVICE)("a creator's records in a repository Anthers hosts", () => {
	it("sets up an account on the server and seals its credential the way signup does", async () => {
		const res = await fetch(`${SERVICE}/xrpc/com.atproto.server.createAccount`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ handle, email: `${handle}@example.invalid`, password }),
		});
		expect(res.ok).toBe(true);
		const account = (await res.json()) as { did: string };
		did = account.did;

		const [user] = await db
			.insert(users)
			.values({
				username: `${RUN}creator`,
				email: `${RUN}creator@example.test`,
				emailVerified: true,
				isCreator: true,
				atprotoDid: did,
				atprotoHandle: handle,
			})
			.returning();
		creatorId = user.id;

		const { seal } = await import("../services/secret-box.js");
		await db
			.insert(hostedAccounts)
			.values({ did, userId: creatorId, handle, sealedPassword: seal(password) });
	}, 60_000);

	it("writes a record into the creator's own repository when a post is published", async () => {
		const [post] = await db
			.insert(posts)
			.values({
				creatorId,
				publicId: Date.now(),
				slug: `${RUN}-published`,
				title: "What I Learned Making a Small Thing",
				isPublished: true,
				publishedAt: new Date("2026-08-14T00:00:00.000Z"),
			})
			.returning();
		postId = post.id;

		const result = await syncPostRecord(postId);
		expect(result.status).toBe("synced");

		// 🚨 The record is in the CREATOR's repository, not Anthers'. That is the whole point of
		// hosting the identity, and a writer pointed at the wrong repo would pass every other
		// assertion here.
		const uri = await postUri();
		expect(uri).toStartWith(`at://${did}/${POST_COLLECTION}/`);
		expect(await recordExists(POST_COLLECTION, uri)).toBe(true);

		const read = await fetch(
			`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${did}` +
				`&collection=${POST_COLLECTION}&rkey=${uri?.split("/").pop()}`,
		);
		const record = (await read.json()) as { value: Record<string, unknown> };
		expect(record.value.$type).toBe("org.anthers.post");
		expect(record.value.url).toContain(`/posts/${RUN}-published-`);
		// The post's own date, not the moment the record happened to be written.
		expect(record.value.publishedAt).toBe("2026-08-14T00:00:00.000Z");
		// ⚠️ No body. A post is authored as sanitized HTML and the Lexicon publishes markdown, so
		// there is nothing to carry yet — asserted here as well as in the mapper's own test,
		// because this is the layer that would actually put somebody's writing on a network.
		expect(record.value.content).toBeUndefined();
	}, 60_000);

	it("replaces the record rather than creating a second when the post is renamed", async () => {
		const was = await postUri();
		await db
			.update(posts)
			.set({ slug: `${RUN}-renamed` })
			.where(eq(posts.id, postId));

		const result = await syncPostRecord(postId);
		expect(result.status).toBe("synced");

		// ⚠️ The same address. A second record would leave the first orphaned and public, which is
		// far harder to clean up than a row somebody has to look at.
		expect(await postUri()).toBe(was);

		const read = await fetch(
			`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${did}` +
				`&collection=${POST_COLLECTION}&rkey=${was?.split("/").pop()}`,
		);
		const record = (await read.json()) as { value: Record<string, unknown> };
		expect(record.value.url).toContain(`/posts/${RUN}-renamed-`);
	}, 60_000);

	// 🚨 **The one worth building carefully, and the one the mapper originally got wrong.** The
	// date stays stamped, so a version reading it alone calls this publishable — and because a
	// record exists by now, the plan comes out `replace`. A creator taking their writing down, and
	// Anthers answering by rewriting it on the network.
	it("removes the record when the creator unpublishes the post, date still stamped", async () => {
		const was = await postUri();
		await db.update(posts).set({ isPublished: false }).where(eq(posts.id, postId));

		const result = await syncPostRecord(postId);
		expect(result.status).toBe("synced");
		if (result.status === "synced") expect(result.plan.action).toBe("delete");

		// The date is still there, which is exactly what makes this case a trap.
		const [row] = await db
			.select({ publishedAt: posts.publishedAt, uri: posts.atprotoUri })
			.from(posts)
			.where(eq(posts.id, postId));
		expect(row.publishedAt).not.toBeNull();
		// The column is cleared, so the next sync knows there is no record rather than trying to
		// replace one that is gone.
		expect(row.uri).toBeNull();
		expect(await recordExists(POST_COLLECTION, was)).toBe(false);
	}, 60_000);

	it("writes a project's record, and takes it down when the project goes back to a draft", async () => {
		const [project] = await db
			.insert(projects)
			.values({
				creatorId,
				slug: `${RUN}-trilogy`,
				title: "The Lanterns Trilogy",
				description: "Three games about light.",
				isPublished: true,
			})
			.returning();
		projectId = project.id;

		expect((await syncProjectRecord(projectId)).status).toBe("synced");
		const uri = await projectUri();
		expect(uri).toStartWith(`at://${did}/${PROJECT_COLLECTION}/`);
		expect(await recordExists(PROJECT_COLLECTION, uri)).toBe(true);

		// 🚨 A draft project is one its creator kept out of the public browse listing. A record for
		// it would publish the thing more loudly than the listing it was withheld from.
		await db.update(projects).set({ isPublished: false }).where(eq(projects.id, projectId));
		expect((await syncProjectRecord(projectId)).status).toBe("synced");
		expect(await projectUri()).toBeNull();
		expect(await recordExists(PROJECT_COLLECTION, uri)).toBe(false);
	}, 60_000);

	// 🚨 The path the reconciling sweep can never cover, because the row it would compare against
	// is exactly what has gone. Deleting the row without this leaves the record up for ever.
	it("takes a record down for a row that has already been deleted", async () => {
		const [project] = await db
			.insert(projects)
			.values({
				creatorId,
				slug: `${RUN}-deleted`,
				title: "Something Being Thrown Away",
				isPublished: true,
			})
			.returning();
		expect((await syncProjectRecord(project.id)).status).toBe("synced");

		const [row] = await db
			.select({ uri: projects.atprotoUri })
			.from(projects)
			.where(eq(projects.id, project.id));
		const uri = row.uri as string;
		expect(await recordExists(PROJECT_COLLECTION, uri)).toBe(true);

		// The order every delete path has to follow: capture the address, delete the row, then
		// remove the record from what was captured.
		await db.delete(projects).where(eq(projects.id, project.id));
		const result = await removeAtprotoRecord({
			ownerId: creatorId,
			collection: PROJECT_COLLECTION,
			uri,
		});
		expect(result).toEqual({ status: "removed" });
		expect(await recordExists(PROJECT_COLLECTION, uri)).toBe(false);

		// ⚠️ And again, because a retry after a half-finished attempt has to finish the job rather
		// than fail it — that is what lets this queue's retry budget be the most generous of the three.
		expect(
			await removeAtprotoRecord({ ownerId: creatorId, collection: PROJECT_COLLECTION, uri }),
		).toEqual({
			status: "removed",
		});
	}, 60_000);

	// ⚠️ The ordinary case, and the one that must never change: nobody is turned away for lacking
	// a handle, so a creator without one publishes exactly as they always did.
	it("does nothing at all for a creator with no identity at all", async () => {
		const [plain] = await db
			.insert(users)
			.values({
				username: `${RUN}plain`,
				email: `${RUN}plain@example.test`,
				emailVerified: true,
				isCreator: true,
			})
			.returning();
		const [post] = await db
			.insert(posts)
			.values({
				creatorId: plain.id,
				publicId: Date.now() + 1,
				slug: `${RUN}-plain`,
				isPublished: true,
				publishedAt: new Date(),
			})
			.returning();

		expect(await syncPostRecord(post.id)).toEqual({ status: "skipped", reason: "no_identity" });
		const [row] = await db
			.select({ uri: posts.atprotoUri })
			.from(posts)
			.where(eq(posts.id, post.id));
		expect(row.uri).toBeNull();
	}, 60_000);
});
