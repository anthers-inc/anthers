// SPDX-License-Identifier: Apache-2.0
/**
 * The keeping election — a buyer's claim on a withdrawn Work's bytes, past ninety days.
 *
 * **Automatic until the floor binds** is the whole rule (the ladder task's leaned answer,
 * made binding by this module): every completed purchase of a withdrawn Work is keeping,
 * unless the buyer's kept bytes would exceed their allowance — past it, the election is
 * theirs. This module is the one writer of `purchases.keptAt`, on the one-writer rule
 * every service module carries, and the claim check the sweep runs reads it.
 *
 * 🚨 **The write only ever ELECTS or RELEASES on a completed purchase; the claim itself
 * is the timestamp.** A release (`keptAt` back to null) re-arms the buyer's ninety-day
 * clock from the release, which is the lapse rule settled with the mechanism that
 * already exists rather than a third account status; an election stamps `keptAt` and
 * ends the countdown. Neither write is possible on anything but a completed purchase of
 * the caller's own, and a Work that is not withdrawn has no keeping to elect — keeping a
 * published Work's media is what publishing already does.
 *
 * ⭐ **The bytes the election commits are the object's, shared**: a Work several people
 * keep is stored ONCE, and each keeper draws a 1/N share against their own allowance
 * (`keptShareBytes`'s derivation). That is the figure the meter records into the
 * keeper's `kept-files` line, and the figure the floor binds on.
 */

import { db } from "@anthers/db/client";
import { assets, purchases, webBuildFiles, webBuilds, works } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";

/** Why an election was refused, when it was. */
export type KeepRefusal = "not_found" | "not_purchased" | "not_withdrawn" | "purged";

/** The buyer-facing copy each refusal carries — the next move differs per reason. */
export const KEEP_REFUSAL_COPY: Record<KeepRefusal, string> = {
	not_found: "Work not found",
	not_purchased: "You have not bought this Work.",
	not_withdrawn:
		"This Work is not withdrawn — keeping applies to a purchase its creator took out of public circulation.",
	purged:
		"The rescue window already closed, so this copy is gone. A Badge held before the next withdrawal keeps the next one.",
};

/**
 * The buyer's 1/N share of a kept Work's bytes, in whole bytes.
 *
 * ⚠️ **The share divides COUNTED media, not the object's theoretical size** — the same
 * enumeration `media-purge.ts` would remove, read from the asset rows that carry their
 * own sizes plus the Work record's own columns. Purged media shares zero, correctly.
 */
export async function keptShareBytes(workId: number, keeperCount: number): Promise<number> {
	if (keeperCount <= 0) return 0;
	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	if (!work) return 0;
	const [assetTotal] = await db
		.select({ total: sql<string>`COALESCE(SUM(${assets.fileSize}), 0)` })
		.from(assets)
		.where(eq(assets.workId, workId));
	let bytes = Number(assetTotal?.total ?? 0);
	const [buildTotal] = await db
		.select({ total: sql<string>`COALESCE(SUM(${webBuildFiles.fileSize}), 0)` })
		.from(webBuildFiles)
		.innerJoin(webBuilds, eq(webBuildFiles.buildId, webBuilds.id))
		.where(eq(webBuilds.workId, workId));
	bytes += Number(buildTotal?.total ?? 0);
	return Math.round(bytes / keeperCount);
}

/**
 * Elect to keep: stamp `keptAt` on the caller's completed purchase of this Work.
 *
 * The refusal shape is honest about WHY, because the buyer's next move differs: a
 * `not_purchased` refusal is permanent absent a purchase, while `purged` means the
 * rescue sweep already removed the bytes and keeping cannot bring them back.
 */
export async function electToKeep(
	userId: number,
	workId: number,
	now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: KeepRefusal }> {
	const [work] = await db
		.select({ visibility: works.visibility, mediaPurgedAt: works.mediaPurgedAt })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return { ok: false, reason: "not_found" };
	if (work.mediaPurgedAt) return { ok: false, reason: "purged" };
	if (work.visibility !== "withdrawn") return { ok: false, reason: "not_withdrawn" };

	const updated = await db
		.update(purchases)
		.set({ keptAt: now, updatedAt: now })
		.where(
			and(
				eq(purchases.buyerId, userId),
				eq(purchases.workId, workId),
				eq(purchases.status, "completed"),
			),
		)
		.returning({ id: purchases.id });
	if (updated.length === 0) return { ok: false, reason: "not_purchased" };
	return { ok: true };
}

/**
 * Release: take the election back, re-arming the ninety-day window from now.
 *
 * Deliberately allowed on a published Work too — releasing a claim is always safe — and
 * answers `not_purchased` where the caller holds no completed purchase, so a refusal is
 * never about the Work's state but about the caller's own.
 */
export async function releaseKeep(
	userId: number,
	workId: number,
	now = new Date(),
): Promise<{ ok: true; released: boolean } | { ok: false; reason: KeepRefusal }> {
	const released = await db
		.update(purchases)
		.set({ keptAt: null, updatedAt: now })
		.where(
			and(
				eq(purchases.buyerId, userId),
				eq(purchases.workId, workId),
				eq(purchases.status, "completed"),
			),
		)
		.returning({ id: purchases.id });
	return { ok: true, released: released.length > 0 };
}
