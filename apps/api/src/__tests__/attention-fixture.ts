// SPDX-License-Identifier: Apache-2.0
/**
 * Test fixture for attention rows in the range model.
 *
 * Time is recorded as ranges now — a row carries its real `startedAt`/`endedAt`
 * window and a stable `clientId`, and every reader splits overlapping windows
 * rather than summing durations. A fixture that inserts a duration-only row is
 * writing pre-range history; one that means "this viewer consumed N seconds" has
 * to write the window, end to end, so the split credits it in full.
 */
import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";

let fixtureSerial = 0;

/**
 * Insert a single attention RANGE: an interval of `seconds` ending at
 * `endsAt` (default now), never overlapping another fixture row for the same
 * user. Overlap would go through the intra-account split and under-credit, which
 * is the real behavior — a fixture should not accidentally ask for it.
 *
 * Pass `endsAt` explicitly for rows outside the current moment (e.g. distribute-
 * pool's fixed cycle, or prune's old days); it is the window's position that
 * decides which reader sees the row.
 */
export async function insertAttentionRange(
	row: Pick<typeof attentionEvents.$inferInsert, "userId" | "creatorId" | "eventType"> &
		Partial<typeof attentionEvents.$inferInsert> & { seconds: number; endsAt?: Date },
): Promise<void> {
	const { seconds, endsAt, eventType = "watch", ...rest } = row;
	const endedAt = endsAt ?? new Date();
	const startedAt = new Date(endedAt.getTime() - seconds * 1_000);
	fixtureSerial += 1;
	await db.insert(attentionEvents).values({
		...rest,
		eventType,
		durationSeconds: seconds,
		startedAt,
		endedAt,
		createdAt: endsAt ?? new Date(),
		clientId: `fixture-${fixtureSerial}`,
	});
}
