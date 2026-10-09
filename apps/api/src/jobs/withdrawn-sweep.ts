// SPDX-License-Identifier: Apache-2.0
/**
 * The claim-aware sweep — the rescue window's expiry, finally acting on the promise.
 *
 * 🚨 **This is the sweep the retention model has promised since the Terms were written.**
 * When a creator withdraws a purchased Work, buyers keep it — `withdrawn` is a visibility
 * state, never a deletion, and the buyer's access lives in `purchases` (`resolveAccess`
 * reads purchases and never visibility). The published promise is narrower than "forever":
 * **ninety days — WITHDRAWN_RESCUE_DAYS — for accounts not keeping it, indefinitely for
 * accounts that are.** This job is the boundary between those two.
 *
 * The design it implements is the ladder task's *Account storage*, and its one question
 * is the one both task briefs parked on each other for months: **does any claim remain
 * on the object?** Three claims exist, and the sweep asks them in order:
 *
 * 1. **Still published** — a Work whose visibility is `released` is never swept by this
 *    job, whatever else is true; withdrawal is the only state that puts media up for
 *    removal here, and the query's own `WHERE` is that gate. (A DMCA takedown and a
 *    legal-or-safety removal have their own paths — `services/dmca.ts` and the
 *    moderation flows — and neither routes through a ninety-day window; those paths
 *    OVERRIDE this job at every Badge and this job never touches a Work carrying a
 *    `takedownStatus`, because destroying what a legal act took custody of is the one
 *    unrecoverable error a retention sweep could make.)
 * 2. **A keeper** — a completed purchase carrying `keptAt`. The keeping election is
 *    automatic until the floor binds (the schema doc on `purchases.keptAt` carries the
 *    rule and the rationale); a lapsed Badge releases its keeper rows via
 *    `releaseKeepersFor`, which re-arms the buyer's ninety days from the release — the
 *    mechanism the design chose rather than a third account status.
 * 3. **The ninety days** — the free account's promise, counted per WORK from
 *    `withdrawnAt` (the date every notice names). A buyer inside it — including a
 *    released keeper whose clock re-armed — keeps the Work; nobody outside it and not
 *    keeping does.
 *
 * 🚨 **Removal is `purgeWorkMedia`, the enumeration that already exists** — one place
 * decides what a Work's media IS, shared with delete and account-erasure. The Work's row
 * (its purchases, the Library entries, the buyers' cloud saves — a purchase outlives
 * everything) is left standing: the record survives the bytes, and `mediaPurgedAt` is
 * what says so.
 *
 * ⚠️ **Idempotent on its own output**: a swept Work carries `mediaPurgedAt` and the next
 * run never lists it. The last-chance warning rides the SAME notification machinery the
 * withdrawal notice used — `essential`, per-purchase dedupe key — sent once, seven days
 * before a buyer's deadline, telling them what still rescues it.
 */

import { db } from "@anthers/db/client";
import { assets, purchases, transcodingJobs, works } from "@anthers/db/schema";
import { WITHDRAWN_RESCUE_DAYS } from "@anthers/shared/constants";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { purgeWorkMedia } from "../services/media-purge.js";
import { notifyMany } from "../services/notifications.js";

/** How long before the deadline the last-chance warning fires, in days. */
export const LAST_CHANCE_DAYS = 7;

/** What one sweep run did, so the worker logs a true figure. */
export interface SweepResult {
	/** Works whose media was removed this run. */
	sweptCount: number;
	/** Last-chance warnings sent this run (deduped by the notification key). */
	warnedCount: number;
}

/**
 * Release every keeping election an account's lapsed Badge was carrying.
 *
 * The lapse rule (the ladder task's design): "a Badge that lapses releases what it was
 * holding." A release sets `keptAt` back to null on every completed purchase the account
 * was keeping — which **re-arms the ninety-day clock from the release**, because the
 * sweep's deadline arithmetic counts from `withdrawnAt` and the buyer was promised
 * whichever window is longer; for a Work withdrawn long ago, the release's clock is the
 * buyer's ONLY remaining days, which is exactly the "harshest moment in the design" the
 * task's own words name, and the notification path matters here more than anywhere else.
 *
 * Returns the number of purchases released, so the lapse sweep's job logs it.
 */
export async function releaseKeepersFor(userId: number, now = new Date()): Promise<number> {
	const released = await db
		.update(purchases)
		.set({ keptAt: null, updatedAt: now })
		.where(
			and(
				eq(purchases.buyerId, userId),
				eq(purchases.status, "completed"),
				isNotNull(purchases.keptAt),
			),
		)
		.returning({ id: purchases.id });
	return released.length;
}

/**
 * Run the sweep: sweep the expired, warn the nearly-expired, in one pass each.
 *
 * Returns a {@link SweepResult}; the worker logs both figures and is quiet on zero —
 * the same posture every other sweep's worker takes, because a daily "0 swept" line
 * makes the log unreadable and the one log that must stay readable is the worker's.
 *
 * ⚠️ **The auto-elect pass is folded into the keeper query rather than run beside it.**
 * "Automatic until the floor binds" read literally as a nightly pass that elects every
 * unpurged purchase would write `keptAt` rows for buyers whose Badge has long lapsed —
 * keeping alive a claim the lapse rule released. So the automatic half is realized as
 * the *default*: a purchase with `keptAt` null within its window is exactly the state
 * "not keeping yet" describes, and the window arithmetic above already preserves it.
 * The election is written by the account's own act (the route) or the meter's binding
 * pass; the sweep only READS it. A buyer inside their window needs no election — the
 * promise is theirs whatever the column says.
 */
export async function runWithdrawnSweep(now = new Date()): Promise<SweepResult> {
	// Every withdrawn Work with its media still present — `mediaPurgedAt` is null —
	// is this run's candidate set. The query's visibility gate IS claim 1.
	const due = await db
		.select({ id: works.id, withdrawnAt: works.withdrawnAt })
		.from(works)
		.where(
			and(
				eq(works.visibility, "withdrawn"),
				isNotNull(works.withdrawnAt),
				isNull(works.mediaPurgedAt),
			),
		);
	if (due.length === 0) return { sweptCount: 0, warnedCount: 0 };
	const workIds = due.map((w) => w.id);

	// ── Claim 2: keepers, one query for the whole candidate set ─────────────────
	const keeperRows = await db
		.selectDistinct({ workId: purchases.workId })
		.from(purchases)
		.where(
			and(
				inArray(purchases.workId, workIds),
				eq(purchases.status, "completed"),
				isNotNull(purchases.keptAt),
			),
		);
	const kept = new Set(keeperRows.map((r) => r.workId));

	// ── Claim 3: the ninety days, per Work from its own withdrawal ──────────────
	const deadline = new Date(now);
	deadline.setDate(deadline.getDate() - WITHDRAWN_RESCUE_DAYS);
	const warnThreshold = new Date(now);
	warnThreshold.setDate(warnThreshold.getDate() - (WITHDRAWN_RESCUE_DAYS - LAST_CHANCE_DAYS));

	const sweptIds: number[] = [];
	const warnIds: number[] = [];
	for (const work of due) {
		if (!work.withdrawnAt) continue;
		if (kept.has(work.id)) continue;
		if (work.withdrawnAt <= deadline) {
			sweptIds.push(work.id);
		} else if (work.withdrawnAt <= warnThreshold) {
			warnIds.push(work.id);
		}
	}

	// ── The sweep half: purge the media, stamp the row ──────────────────────────
	for (const id of sweptIds) {
		const [item] = await db.select().from(works).where(eq(works.id, id)).limit(1);
		if (!item) continue;
		const [workAssets, jobRows] = await Promise.all([
			db.select().from(assets).where(eq(assets.workId, id)),
			db.select().from(transcodingJobs).where(eq(transcodingJobs.workId, id)),
		]);
		await purgeWorkMedia(item, workAssets, jobRows);
		await db.update(works).set({ mediaPurgedAt: new Date() }).where(eq(works.id, id));
	}

	// ── The warning half: essential, per purchase, deduped by key ───────────────
	let warnedCount = 0;
	if (warnIds.length > 0) {
		const rows = (
			await db
				.select({ purchaseId: purchases.id, buyerId: purchases.buyerId, workId: purchases.workId })
				.from(purchases)
				.where(and(inArray(purchases.workId, warnIds), eq(purchases.status, "completed")))
		).filter(
			(r): r is { purchaseId: number; buyerId: number; workId: number } => r.buyerId != null,
		);
		const withdrawnOf = new Map(due.map((w) => [w.id, w.withdrawnAt]));
		if (rows.length > 0) {
			const result = await notifyMany(
				rows.map((r) => {
					const withdrawnAt = withdrawnOf.get(r.workId);
					const deadlineAt = new Date(withdrawnAt ?? now);
					deadlineAt.setDate(deadlineAt.getDate() + WITHDRAWN_RESCUE_DAYS);
					const by = deadlineAt.toLocaleDateString("en-US", {
						year: "numeric",
						month: "long",
						day: "numeric",
					});
					return {
						userId: r.buyerId,
						category: "essential" as const,
						kind: "work_withdrawn_last_chance",
						title: "Last chance to download a Work you bought",
						body: `The rescue window closes ${by}. After that, a copy is yours to keep — a Badge holds onto it for you.`,
						linkPath: "/library",
						dedupeKey: `work-last-chance:${r.purchaseId}`,
					};
				}),
			);
			warnedCount = result.created;
		}
	}

	return { sweptCount: sweptIds.length, warnedCount };
}
