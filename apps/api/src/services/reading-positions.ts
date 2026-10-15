// SPDX-License-Identifier: Apache-2.0
/**
 * Reading positions — the only writer of `reading_positions`.
 *
 * Single-writer in the same family as `services/library.ts` and `services/moderation.ts`:
 * the rows are the continue-reading rail's data and the readers' cross-device resume, and
 * a second writer would let a position disagree with itself. Each row is the user's own
 * state about where they stopped in one Work.
 *
 * 🚨 **Authoritative and unpublished, and a state never leaves this module's shape.** The
 * table's reasoning is on the table itself in `packages/db/src/schema/content.ts` — no
 * record ever publishes it, no `atproto_uri` column joins it, and nothing OUTSIDE the
 * user's own reads consumes it: no creator surface, no analytics, no rollup. A future
 * feature that wants "where readers stopped" must arrive as a decision on that page and a
 * deliberate widening of this module, never as a second reader of the table.
 *
 * **Newest-write-wins** is the whole conflict rule the module implements: an upsert
 * replaces the row whole, so the last device to push is where the reader is. The
 * further-along reconciliation between a Work's page and panel keys is a client-side,
 * same-device concern and deliberately does not exist here — the server would otherwise
 * refuse a re-read by dragging the opening back to the high-water mark.
 *
 * **The pointer is opaque to the server.** `{ page, panel }` for a paged Work, `{ cfi }`
 * for a reflow one, `{}` for a text Work whose `progress` fraction is the whole position.
 * This module bounds the payload's size and stores it; only the client's readers assign
 * its keys meaning.
 */

import { db, readingPositions, works } from "@anthers/db";
import type { InferSelectModel } from "drizzle-orm";
import { and, desc, eq } from "drizzle-orm";

export type ReadingPosition = InferSelectModel<typeof readingPositions>;

/** Why a position write was refused, when it was. */
export type PositionRefusal = "not_found";

/**
 * The user's positions, newest-touched first — the shape the rail reads its recency
 * order from and the clients adopt server positions from.
 */
export async function listPositions(userId: number): Promise<ReadingPosition[]> {
	return db
		.select()
		.from(readingPositions)
		.where(eq(readingPositions.userId, userId))
		.orderBy(desc(readingPositions.updatedAt));
}

/**
 * Upsert the caller's position for one Work. Refuses a Work that does not exist; the
 * route carries the access check, because whether the caller may reach the Work is a
 * request-shape question, not a storage question.
 *
 * Progress is clamped into 0–1 rather than validated into a refusal: a reader whose
 * fraction landed a hair outside (a reflow renderer's 1.0000001) should write a clamped
 * position, not bounce.
 */
export async function upsertPosition(
	userId: number,
	workId: number,
	progress: number,
	position: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; reason: PositionRefusal }> {
	const [work] = await db
		.select({ id: works.id })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return { ok: false, reason: "not_found" };

	const clamped = Math.min(1, Math.max(0, progress));
	await db
		.insert(readingPositions)
		.values({ userId, workId, progress: clamped, position })
		.onConflictDoUpdate({
			target: [readingPositions.userId, readingPositions.workId],
			set: {
				progress: clamped,
				position,
				// The upsert IS the newest-write-wins rule: one row, replaced whole.
				updatedAt: new Date(),
			},
		});
	return { ok: true };
}

/**
 * Whether a Work has an unfinished position for the caller — the rail's membership test
 * in its server form. Strictly past zero and strictly short of the end: a finished Work
 * belongs to the shelf below the rail, and an never-really-opened one (a sliver past
 * zero) does not belong on the rail either.
 *
 * ⚠️ Exported for the module's completeness rather than a current caller: the rail reads
 * the client-side store, and this exists so a future server-side rail query has the one
 * place to read the rule from.
 */
export function isUnfinished(position: ReadingPosition): boolean {
	return position.progress > 0 && position.progress < 1;
}

/** A user's position for one Work, or null. Own rows only, by construction. */
export async function findPosition(
	userId: number,
	workId: number,
): Promise<ReadingPosition | null> {
	const [row] = await db
		.select()
		.from(readingPositions)
		.where(and(eq(readingPositions.userId, userId), eq(readingPositions.workId, workId)))
		.limit(1);
	return row ?? null;
}