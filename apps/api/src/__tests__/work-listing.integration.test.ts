// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A Work's listing, written into a repository Anthers hosts, against a real server.
 *
 * `atproto-repo.test.ts` proves the *decision* against a fake repository, exhaustively and in
 * milliseconds. `scripts/atproto-writer.integration.test.ts` proves the *write* against a real
 * server using Anthers' own account. This proves the third thing neither can: that a Work in the
 * database, belonging to a creator whose credential is sealed in `hosted_accounts`, ends up with
 * a record in **that creator's** repository and a URI in its row — and loses both when it stops
 * being publicly listed.
 *
 * 🚨 **It refuses to run unless `ATPROTO_TEST_PDS` names a server.** A record on a real server is
 * world-readable the moment it lands and is broadcast to everyone listening; deleting it
 * afterwards broadcasts only the deletion, so anyone who kept a copy keeps it. Requiring the
 * operator to name the target is what stops this reaching production by defaulting to something.
 *
 *   make pds-up && make pds-test
 *
 * ⚠️ **This one needs the database as well as the server**, which is why it lives here rather
 * than beside its sibling in `scripts/`. It creates a real account on the throwaway server, seals
 * that account's password exactly as signup would, and lets the ordinary code path do the rest —
 * so what is exercised is the production path rather than a rehearsal of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts, users, works } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

const SERVICE = process.env.ATPROTO_TEST_PDS;

purgeAccountsCreatedHere();

const RUN = `wl${Date.now().toString(36)}`;
// Base 36 rather than a plain timestamp: the server refuses a long first segment outright, and
// `.test` is the domain a development PDS offers.
const handle = `probe-${Date.now().toString(36)}.test`;
const password = `probe-${crypto.randomUUID()}`;

const before = { url: process.env.HOSTED_PDS_URL, key: process.env.HOSTED_ACCOUNT_KEY };

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(() => {
	if (!SERVICE) return;
	process.env.HOSTED_PDS_URL = SERVICE;
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterAll(async () => {
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_ACCOUNT_KEY", before.key);
	await db.delete(works).where(like(works.slug, `${RUN}%`));
	await db.delete(hostedAccounts).where(like(hostedAccounts.did, `%${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

let creatorId = 0;
let workId = 0;
let did = "";

describe.skipIf(!SERVICE)("a Work's listing in a repository Anthers hosts", () => {
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

	it("writes a record into the creator's own repository when a Work is released", async () => {
		const work = await insertWork({
			creatorId,
			type: "game",
			slug: `${RUN}-released`,
			title: "The Weight of Small Hours",
			description: "A short game.",
			visibility: "released",
		});
		workId = work.id;
		await db.update(works).set({ releasedAt: new Date() }).where(eq(works.id, workId));

		const { syncWorkListing } = await import("../services/work-listing.js");
		const result = await syncWorkListing(workId);
		expect(result.status).toBe("synced");

		// 🚨 The record is in the CREATOR's repository, not Anthers'. That is the whole point of
		// hosting the identity, and a writer pointed at the wrong repo would pass every other
		// assertion here.
		const [row] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, workId));
		expect(row.uri).toStartWith(`at://${did}/org.anthers.work/`);

		// And it really is on the server, with the fields the Lexicon promises.
		const read = await fetch(
			`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${did}` +
				`&collection=org.anthers.work&rkey=${row.uri?.split("/").pop()}`,
		);
		expect(read.ok).toBe(true);
		const record = (await read.json()) as { value: Record<string, unknown> };
		expect(record.value.$type).toBe("org.anthers.work");
		expect(record.value.title).toBe("The Weight of Small Hours");
		expect(record.value.url).toContain(`-${work.publicId}`);
	}, 60_000);

	it("replaces the record rather than creating a second when the Work is edited", async () => {
		const [before] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, workId));

		await db.update(works).set({ title: "A Different Title" }).where(eq(works.id, workId));
		const { syncWorkListing } = await import("../services/work-listing.js");
		const result = await syncWorkListing(workId);
		expect(result.status).toBe("synced");

		const [after] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, workId));
		// ⚠️ The same address. A second record would leave the first orphaned and public, which
		// is far harder to clean up than a row somebody has to look at.
		expect(after.uri).toBe(before.uri);

		const read = await fetch(
			`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${did}` +
				`&collection=org.anthers.work&rkey=${after.uri?.split("/").pop()}`,
		);
		const record = (await read.json()) as { value: Record<string, unknown> };
		expect(record.value.title).toBe("A Different Title");
	}, 60_000);

	// 🚨 The half worth building carefully. A listing that outlives the thing it advertises is
	// the failure this whole design is shaped around — withdrawing a Work and leaving its record
	// up is precisely what withdrawing was meant to undo.
	it("removes the record when the Work stops being publicly listed", async () => {
		const [before] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, workId));
		const rkey = before.uri?.split("/").pop() as string;

		await db.update(works).set({ visibility: "withdrawn" }).where(eq(works.id, workId));
		const { syncWorkListing } = await import("../services/work-listing.js");
		const result = await syncWorkListing(workId);
		expect(result.status).toBe("synced");

		// The column is cleared, so the next sync knows there is no record rather than trying to
		// replace one that is gone.
		const [after] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, workId));
		expect(after.uri).toBeNull();

		const read = await fetch(
			`${SERVICE}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=org.anthers.work&rkey=${rkey}`,
		);
		expect(read.ok).toBe(false);
	}, 60_000);

	// ⚠️ The ordinary case, and the one that must never change: nobody is turned away for
	// lacking a handle, so a creator without one publishes exactly as they always did. There are
	// two routes into a repository now — a hosted identity and a permission granted over one
	// held elsewhere — and this creator has neither, which is what `no_identity` says.
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
		const work = await insertWork({
			creatorId: plain.id,
			type: "game",
			slug: `${RUN}-plain`,
			visibility: "released",
		});
		await db.update(works).set({ releasedAt: new Date() }).where(eq(works.id, work.id));

		const { syncWorkListing } = await import("../services/work-listing.js");
		const result = await syncWorkListing(work.id);
		expect(result).toEqual({ status: "skipped", reason: "no_identity" });

		const [row] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, work.id));
		expect(row.uri).toBeNull();
	}, 60_000);
});
