// SPDX-License-Identifier: Apache-2.0
/**
 * How many Works an account has released — the signal behind
 * `@anthers/shared/verified-creator`.
 *
 * 🚨 **`released_at`, not `visibility = 'released'`.** A withdrawn Work keeps its
 * `released_at`, because withdrawing is not un-making the thing and buyers may still hold it
 * (`works`' own comment on `visibility` carries the reasoning). Counting the visibility
 * instead would un-verify a creator the moment they withdrew their only Work, which is the
 * opposite of what the record says happened.
 *
 * The count rides a creator-only read at `/auth/me` boot, so its caller skips the query for
 * anybody who has not turned creator mode on; `idx_works_creator` makes it a cheap one when
 * they have.
 */
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export async function releasedWorkCount(creatorId: number): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(works)
		.where(and(eq(works.creatorId, creatorId), isNotNull(works.releasedAt)));
	return row?.count ?? 0;
}
