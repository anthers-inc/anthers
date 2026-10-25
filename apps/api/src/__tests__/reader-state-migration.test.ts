// SPDX-License-Identifier: Apache-2.0
/**
 * The reader-state cutover: rows into the space, the flag that makes it canonical, and the
 * rollback that makes the database canonical again.
 *
 * The test reads the records out of the fake PDS rather than trusting the migration's counts,
 * because the promise is that the reader's Library, progress and save are in the space at the
 * same values. It also proves the two directions the flag owns: a forward write queues only on
 * `space`, and a failed read-back refuses the flip.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { spaceOutbox, workSaves } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { saveWork } from "../services/library.js";
import {
	migrateReaderState,
	queueLibraryEntry,
	readerStateHome,
	rollbackReaderState,
} from "../services/reader-state-migration.js";
import { upsertPosition } from "../services/reading-positions.js";
import { drainSpaceOutbox } from "../services/space-outbox.js";
import { USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { spaceContext } from "./space-fixtures.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const SAVE = '{"level":7,"seed":"nightjar"}';

async function rowsFor(userId: number) {
	return db.select().from(spaceOutbox).where(eq(spaceOutbox.userId, userId));
}

describe("the reader-state cutover", () => {
	it("backfills the Library, progress and save, then flips to the space", async () => {
		const ctx = await spaceContext();
		const saved = await saveWork(ctx.userId, ctx.workId);
		if (!saved.ok) throw new Error("the fixture Work could not be saved");
		await upsertPosition(ctx.userId, ctx.workId, 0.4267, { page: 42 });
		await db.insert(workSaves).values({
			userId: ctx.userId,
			workId: ctx.workId,
			blob: SAVE,
			runtime: "godot",
			note: "chapter seven",
			byteSize: SAVE.length,
		});

		const migrated = await migrateReaderState(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if (!migrated.ok) throw new Error(`migration refused: ${migrated.reason}`);
		expect(migrated.report).toMatchObject({ library: 1, positions: 1, saves: 1, remaining: 0 });

		const [library] = ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem);
		expect(library.value).toMatchObject({
			subject: { kind: "work", id: ctx.workId },
			hidden: false,
		});

		const [position] = ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.readingPosition);
		expect(position.value).toMatchObject({
			subject: { id: ctx.workId },
			// 0.4267 as basis points: the protocol has no float.
			progressBps: 4267,
			position: { page: 42 },
		});

		const [save] = ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.workSave);
		expect(save.value).toMatchObject({
			subject: { id: ctx.workId },
			save: SAVE,
			runtime: "godot",
			note: "chapter seven",
		});

		// The database is still the projection the Library reads.
		expect(await readerStateHome(ctx.userId)).toBe("space");
		expect(await rowsFor(ctx.userId)).toHaveLength(0);
	});

	it("queues a forward write only while the space is canonical, and the rollback stops it", async () => {
		const ctx = await spaceContext();
		const migrated = await migrateReaderState(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(migrated.ok).toBe(true);

		const extra = await insertWork({ creatorId: ctx.userId, type: "text", title: "Second" });
		const saved = await saveWork(ctx.userId, extra.id);
		if (!saved.ok) throw new Error("the second Work could not be saved");
		await queueLibraryEntry(ctx.userId, saved.id);
		expect(await rowsFor(ctx.userId)).toHaveLength(1);
		const drained = await drainSpaceOutbox({
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(drained.cleared).toBe(1);
		expect(ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem)).toHaveLength(1);

		await rollbackReaderState(ctx.userId);
		expect(await readerStateHome(ctx.userId)).toBe("db");

		const third = await insertWork({ creatorId: ctx.userId, type: "text", title: "Third" });
		const afterRollback = await saveWork(ctx.userId, third.id);
		if (!afterRollback.ok) throw new Error("the third Work could not be saved");
		await queueLibraryEntry(ctx.userId, afterRollback.id);
		expect(await rowsFor(ctx.userId)).toHaveLength(0);
		expect(ctx.pds.recordsIn(ctx.spaceUri, USER_SPACE_COLLECTIONS.libraryItem)).toHaveLength(1);
	});

	it("refuses the flip when a record cannot be verified, and keeps the row", async () => {
		const ctx = await spaceContext();
		const saved = await saveWork(ctx.userId, ctx.workId);
		if (!saved.ok) throw new Error("the fixture Work could not be saved");
		ctx.pds.corruptReads = 99;

		const migrated = await migrateReaderState(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(migrated.ok).toBe(false);
		if (!migrated.ok) expect(migrated.reason).toBe("outbox_not_cleared");
		expect(await readerStateHome(ctx.userId)).toBe("db");

		const rows = await rowsFor(ctx.userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("pending");
	});
});
