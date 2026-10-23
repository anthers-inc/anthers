// SPDX-License-Identifier: Apache-2.0
/**
 * The user-space outbox, held to the lab's user-space scenarios.
 *
 * The five this file covers are the ones a server can be made to fail on purpose:
 *
 *   - **01, a verified write.** The record lands, reads back at the same URI and CID, the
 *     commit advances, the oplog carries the operation, and only then does the row clear.
 *   - **01F, a failed read-back.** The write succeeded and the verification did not, so the
 *     outbox row and its payload stay and nothing is projected.
 *   - **02, a write that survives a kill.** The process dies after the write landed; the next
 *     drain writes the same bytes to the same key and converges.
 *   - **08, a projection rebuilt from `listRecords`.** The local shelf is deleted, rebuilt from
 *     the space alone, and a row the space does not carry is retracted.
 *   - **09, the registry's two sources.** An empty space is found through `listSpaces`, and a
 *     deliberately corrupted address is repaired from it.
 *
 * The real server is `scripts/atproto-space-smoke.ts`; the same path against a staging PDS is
 * `space-staging.test.ts`. This file is the failure modes.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { libraryItems, spaceOutbox, userSpaces } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import {
	drainSpaceOutbox,
	enqueueLibraryItem,
	type OutboxFailure,
	outboxBacklog,
} from "../services/space-outbox.js";
import { rebuildLibraryProjection } from "../services/space-projection.js";
import { type LibraryItemState, USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import {
	ensureUserSpace,
	reconcileUserSpace,
	registeredSpace,
	userSpaceUri,
} from "../services/space-registry.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { FakeSpacePds } from "./space-fake.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

let counter = 0;

interface Context {
	pds: FakeSpacePds;
	userId: number;
	did: string;
	spaceUri: string;
	workId: number;
	resolveSession: ResolveSpaceSession;
}

/** An account, a fake PDS, a Work to save, and the account's space already created. */
async function context(): Promise<Context> {
	counter += 1;
	const account = await createAccount(`spaces-outbox-${counter}`);
	const pds = new FakeSpacePds();
	pds.sessionDid = account.did;
	const resolveSession: ResolveSpaceSession = async (userId) =>
		userId === account.userId
			? { session: { did: account.did, pdsUrl: "http://fake.pds", token: "token" } }
			: { session: null, reason: "not_hosted" };
	const work = await insertWork({ creatorId: account.userId, type: "text", title: "Nightjar" });

	const ensured = await ensureUserSpace(account.userId, {
		resolveSession,
		fetchImpl: pds.fetch,
	});
	if (!ensured.space) throw new Error(`space was not created: ${ensured.reason}`);

	return {
		pds,
		userId: account.userId,
		did: account.did,
		spaceUri: ensured.space.spaceUri,
		workId: work.id,
		resolveSession,
	};
}

function shelfEntry(workId: number, overrides: Partial<LibraryItemState> = {}): LibraryItemState {
	return {
		subject: { kind: "work", id: workId, uri: null },
		hidden: false,
		sortOrder: 1,
		savedAt: new Date("2026-10-23T12:00:00.000Z"),
		...overrides,
	};
}

describe("the user-space outbox", () => {
	it("01: clears a row only after the write reads back verified", async () => {
		const ctx = await context();
		const queued = await enqueueLibraryItem(ctx.userId, shelfEntry(ctx.workId));
		expect(queued.queued).toBe(true);

		const report = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});

		expect(report.claimed).toBe(1);
		expect(report.cleared).toBe(1);
		expect(report.failures).toEqual([]);

		// The space holds the record, and the projection now holds the shelf row.
		const [record] = ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem);
		expect(record.value).toMatchObject({ subject: { kind: "work", id: ctx.workId } });
		const [shelf] = await db
			.select()
			.from(libraryItems)
			.where(and(eq(libraryItems.userId, ctx.userId), eq(libraryItems.workId, ctx.workId)));
		expect(shelf?.hidden).toBe(false);

		// Nothing is owed, and the registry knows the address.
		expect(await rowsFor(ctx.userId)).toHaveLength(0);
		const space = await registeredSpace(ctx.userId);
		expect(space?.spaceUri).toBe(userSpaceUri(ctx.did));
		expect(space?.verifiedAt).not.toBeNull();
	});

	it("01F: a failed read-back keeps the row and the record, and projects nothing", async () => {
		const ctx = await context();
		await enqueueLibraryItem(ctx.userId, shelfEntry(ctx.workId));
		ctx.pds.corruptReads = 1;

		const failed = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(failed.cleared).toBe(0);
		expect(failed.failures).toHaveLength(1);
		expect(failed.failures[0].kind).toBe("verification");
		expect(failed.failures[0].error).toContain("cid");

		// The row is still owed, with its payload, and no shelf row was projected.
		const rows = await rowsFor(ctx.userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("pending");
		expect(rows[0].attempts).toBe(1);
		expect(rows[0].record).toMatchObject({ subject: { id: ctx.workId } });
		expect(await shelfRows(ctx.userId)).toHaveLength(0);

		// The write itself did land, which is exactly the state the verification exists to catch.
		expect(ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem)).toHaveLength(1);

		// With the read-back honest again, the retry converges and clears.
		const retried = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
			now: new Date(Date.now() + 60_000),
		});
		expect(retried.cleared).toBe(1);
		expect(await rowsFor(ctx.userId)).toHaveLength(0);
		expect(await shelfRows(ctx.userId)).toHaveLength(1);
	});

	it("02: a write that landed before a kill is written again and converges", async () => {
		const ctx = await context();
		await enqueueLibraryItem(ctx.userId, shelfEntry(ctx.workId));
		ctx.pds.throwAfterWrite = 1;

		const killed = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(killed.cleared).toBe(0);
		expect(await rowsFor(ctx.userId)).toHaveLength(1);
		expect(ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem)).toHaveLength(1);

		const recovered = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
			now: new Date(Date.now() + 60_000),
		});
		expect(recovered.cleared).toBe(1);
		expect(await rowsFor(ctx.userId)).toHaveLength(0);
		// Same key, one record: the retry replaced rather than duplicated.
		expect(ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem)).toHaveLength(1);
	});

	it("08: rebuilds the shelf from listRecords and retracts a row the space lacks", async () => {
		const ctx = await context();
		await enqueueLibraryItem(ctx.userId, shelfEntry(ctx.workId));
		await drainSpaceOutbox({ resolveSession: ctx.resolveSession, fetchImpl: ctx.pds.fetch });
		expect(await shelfRows(ctx.userId)).toHaveLength(1);

		// A stray local row the space knows nothing about, which the rebuild must retract.
		const strayWork = await insertWork({ creatorId: ctx.userId, type: "text", title: "Stray" });
		await db.insert(libraryItems).values({ userId: ctx.userId, workId: strayWork.id });

		// Delete the whole projection, leaving only the space.
		await db.delete(libraryItems).where(eq(libraryItems.userId, ctx.userId));

		const rebuilt = await rebuildLibraryProjection(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if ("reason" in rebuilt) throw new Error(`rebuild failed: ${rebuilt.reason}`);
		expect(rebuilt.scanned).toBe(1);
		expect(rebuilt.inserted).toBe(1);

		const shelf = await shelfRows(ctx.userId);
		expect(shelf).toHaveLength(1);
		expect(shelf[0].workId).toBe(ctx.workId);

		// And a row the space does not carry is removed rather than kept.
		await db.insert(libraryItems).values({ userId: ctx.userId, workId: strayWork.id });
		const again = await rebuildLibraryProjection(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if ("reason" in again) throw new Error(`rebuild failed: ${again.reason}`);
		expect(again.removed).toBe(1);
		expect(await shelfRows(ctx.userId)).toHaveLength(1);
	});

	it("09: finds an empty space and repairs a corrupted registry address", async () => {
		const ctx = await context();
		// No record was ever written, so the space is still in `listSpaces` and nowhere else.
		expect(ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem)).toHaveLength(0);

		await db
			.update(userSpaces)
			.set({
				spaceUri: `at://${ctx.did}/space/org.anthers.userSpace/not-self`,
				verifiedAt: null,
			})
			.where(eq(userSpaces.userId, ctx.userId));

		const reconciled = await reconcileUserSpace(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(reconciled.space?.spaceUri).toBe(ctx.spaceUri);
		expect(reconciled.space?.lastError).toContain("repaired");
		expect(reconciled.space?.verifiedAt).not.toBeNull();
	});

	it("parks a row that keeps failing and tells the alert path", async () => {
		const ctx = await context();
		await enqueueLibraryItem(ctx.userId, shelfEntry(ctx.workId));
		ctx.pds.corruptReads = 99;

		const alerts: OutboxFailure[] = [];
		const alert = (failure: OutboxFailure) => {
			alerts.push(failure);
		};

		const first = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
			maxAttempts: 2,
			alert,
		});
		expect(first.failed).toBe(0);
		expect(alerts[0]).toMatchObject({ kind: "verification", terminal: false, attempts: 1 });

		const second = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
			now: new Date(Date.now() + 10 * 60_000),
			maxAttempts: 2,
			alert,
		});
		expect(second.failed).toBe(1);
		expect(alerts[1]).toMatchObject({ terminal: true, attempts: 2, rowId: alerts[0].rowId });

		// Parked, never cleared: the payload is still there for a requeue, and the backlog
		// reports it rather than looking empty.
		const [row] = await rowsFor(ctx.userId);
		expect(row.status).toBe("failed");
		expect(row.record).toMatchObject({ subject: { id: ctx.workId } });
		expect((await outboxBacklog()).failed).toBeGreaterThan(0);
	});
});

async function rowsFor(userId: number) {
	return db.select().from(spaceOutbox).where(eq(spaceOutbox.userId, userId));
}

async function shelfRows(userId: number) {
	return db.select().from(libraryItems).where(eq(libraryItems.userId, userId));
}
