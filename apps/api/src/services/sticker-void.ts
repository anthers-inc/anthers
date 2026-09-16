// SPDX-License-Identifier: Apache-2.0
/**
 * Reverting Sticker directions when Anthers removes what a Sticker sits on or pays.
 *
 * 🚨 **Who removed it decides who keeps the money** (Parker, 2026-09-04).
 *
 * - **A giver removing their own Sticker** keeps the creator paid. The money was committed
 *   at the moment of giving, and letting somebody take it back would make standing
 *   rentable — give, collect the goodwill, withdraw before the cycle closes. That is
 *   `removed_at`, and it is display only.
 * - **A creator withdrawing their own Work** also keeps them paid. They broke no rule, and
 *   a creator has to stay free to take something out of circulation without it costing
 *   them money already given. Nothing here fires on a withdrawal.
 * - **Anthers removing it** reverts the direction. Paying directed money out on content
 *   Anthers removed would be funding the violation, so the money goes back to being
 *   distributed by time — which is what it would have done had nobody directed it.
 *
 * 🚨 **Every path by which Anthers removes something calls in here**: a DMCA takedown and a
 * quarantine of a Work, and a moderation hide of a comment, each with its reversal. A removal
 * path that records its action and forgets this one leaves the Stickers paying, and nothing
 * fails to say so.
 *
 * ⚠️ **A removal reaches the Stickers a subject PAYS as well as the ones sitting on it.** A
 * Sticker on a comment pays whoever wrote the thread's root, so taking a Work down has to void
 * the Stickers on every comment beneath it, or the comments would keep paying the creator of
 * the thing Anthers removed.
 *
 * ⭐ **Reverting is a subtraction, not a transfer.** `distribute-pool` distributes by time
 * only what was *not* directed, so leaving a voided Sticker out of that sum is the entire
 * mechanism. No money is moved, created or held anywhere; it simply stops being carved out.
 *
 * 🚨 **Only ever on a month that has not settled.** Once settlement has credited it the money
 * is owed to somebody, and voiding then would be a claim about the past rather than a routing
 * instruction. A takedown does not reach backwards into months already credited; withholding a
 * transfer in the hold after settlement is the payouts build's to do.
 */

import { db } from "@anthers/db/client";
import { comments, monthSettlements, stickers, works } from "@anthers/db/schema";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { commentRoots, threadCommentIds } from "./comment-thread.js";

/** What a Sticker can sit on. */
export type StickerSubjectType = "work" | "post" | "comment";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The database, or the transaction a removal is being written in.
 *
 * 🚨 **A restore must read through the transaction that undid the removal.** The Work or comment
 * only reads as live inside it until it commits, so a restore reading through `db` would find
 * the subject still removed and reinstate nothing.
 */
export type StickerExecutor = typeof db | Tx;

/**
 * The months settlement has closed, of those asked about.
 *
 * 🚨 **Read from `month_settlements` and from nothing else.** A distribution row is the nightly
 * estimate and exists from a month's first night, so treating one as settled made every takedown
 * after the first day void nothing. One marker per month is right because every account renews
 * on the 1st, so a month means the same window for every giver.
 */
async function settledCycles(cycles: string[]): Promise<Set<string>> {
	if (cycles.length === 0) return new Set();
	const rows = await db
		.select({ cycle: monthSettlements.billingCycle })
		.from(monthSettlements)
		.where(inArray(monthSettlements.billingCycle, cycles));
	return new Set(rows.map((r) => r.cycle));
}

/** The Stickers a removal of this subject reaches: on it, and on any comment its thread roots. */
async function reachedBy(subjectType: StickerSubjectType, subjectId: number): Promise<SQL> {
	const onSubject = and(eq(stickers.subjectType, subjectType), eq(stickers.subjectId, subjectId));
	if (subjectType === "comment") return onSubject as SQL;
	const thread = await threadCommentIds({ subjectType, subjectId });
	if (thread.length === 0) return onSubject as SQL;
	return or(
		onSubject,
		and(eq(stickers.subjectType, "comment"), inArray(stickers.subjectId, thread)),
	) as SQL;
}

/**
 * Revert every unsettled Sticker this subject's removal reaches. Returns how many, and the
 * dollars handed back to time-based distribution.
 *
 * ⚠️ **Idempotent**, because a subject can be removed by more than one path — a Work can be
 * quarantined and taken down at once — and re-voiding must not double-count anything a caller
 * reports.
 */
export async function voidStickersOnSubject(
	subjectType: StickerSubjectType,
	subjectId: number,
	exec: StickerExecutor = db,
): Promise<{ voided: number; dollars: number }> {
	const live = await exec
		.select({ id: stickers.id, cycle: stickers.billingCycle, amount: stickers.amount })
		.from(stickers)
		.where(and(await reachedBy(subjectType, subjectId), isNull(stickers.voidedAt)));
	if (live.length === 0) return { voided: 0, dollars: 0 };

	const settled = await settledCycles([...new Set(live.map((r) => r.cycle))]);
	const revertible = live.filter((r) => !settled.has(r.cycle));
	if (revertible.length === 0) return { voided: 0, dollars: 0 };

	await exec
		.update(stickers)
		.set({ voidedAt: new Date() })
		.where(
			inArray(
				stickers.id,
				revertible.map((r) => r.id),
			),
		);
	const dollars = revertible.reduce((sum, r) => sum + Number(r.amount), 0);
	return { voided: revertible.length, dollars: Math.round(dollars * 100) / 100 };
}

/**
 * Which of these Stickers sit on something Anthers still has removed, by any path.
 *
 * A Work is removed while it is taken down or quarantined, a comment while it is hidden or while
 * the Work its thread hangs off is removed. A post has no removal state of its own.
 */
async function stillRemoved(
	exec: StickerExecutor,
	rows: { id: number; subjectType: string; subjectId: number }[],
): Promise<Set<number>> {
	const commentIds = rows.filter((r) => r.subjectType === "comment").map((r) => r.subjectId);
	const roots = await commentRoots(commentIds);
	const hiddenComments = new Set<number>();
	if (commentIds.length > 0) {
		const hidden = await exec
			.select({ id: comments.id })
			.from(comments)
			.where(and(inArray(comments.id, commentIds), eq(comments.moderationStatus, "hidden")));
		for (const row of hidden) hiddenComments.add(row.id);
	}

	const workIds = [
		...rows.filter((r) => r.subjectType === "work").map((r) => r.subjectId),
		...[...roots.values()].filter((root) => root.subjectType === "work").map((r) => r.subjectId),
	];
	const removedWorks = new Set<number>();
	if (workIds.length > 0) {
		const removed = await exec
			.select({ id: works.id })
			.from(works)
			.where(
				and(
					inArray(works.id, workIds),
					or(eq(works.takedownStatus, "taken_down"), eq(works.quarantineStatus, "quarantined")),
				),
			);
		for (const row of removed) removedWorks.add(row.id);
	}

	const out = new Set<number>();
	for (const row of rows) {
		if (row.subjectType === "work" && removedWorks.has(row.subjectId)) out.add(row.id);
		if (row.subjectType === "comment") {
			const root = roots.get(row.subjectId);
			const rootRemoved = root?.subjectType === "work" && removedWorks.has(root.subjectId);
			if (hiddenComments.has(row.subjectId) || rootRemoved) out.add(row.id);
		}
	}
	return out;
}

/**
 * Put back what {@link voidStickersOnSubject} reverted, when a removal is undone.
 *
 * 🚨 **Only what no other removal still covers.** A Work can be quarantined and taken down at
 * once, and a comment hidden beneath a Work that is taken down; undoing one of those must leave
 * the Stickers voided while the other stands, or the money would flow back to content Anthers
 * still has removed.
 *
 * ⚠️ **Only for a cycle that is still unsettled.** A counter-notice can arrive after the
 * cycle closed, and by then the money has been distributed by time and paid out — so the
 * Sticker stays voided and the record says what actually happened. Restoring the Work does
 * not rewrite a settled month.
 */
export async function restoreStickersOnSubject(
	subjectType: StickerSubjectType,
	subjectId: number,
	exec: StickerExecutor = db,
): Promise<{ restored: number }> {
	const voided = await exec
		.select({
			id: stickers.id,
			cycle: stickers.billingCycle,
			subjectType: stickers.subjectType,
			subjectId: stickers.subjectId,
		})
		.from(stickers)
		.where(and(await reachedBy(subjectType, subjectId), isNotNull(stickers.voidedAt)));
	if (voided.length === 0) return { restored: 0 };

	const [settled, removed] = await Promise.all([
		settledCycles([...new Set(voided.map((r) => r.cycle))]),
		stillRemoved(exec, voided),
	]);
	const restorable = voided.filter((r) => !settled.has(r.cycle) && !removed.has(r.id));
	if (restorable.length === 0) return { restored: 0 };

	await exec
		.update(stickers)
		.set({ voidedAt: null })
		.where(
			inArray(
				stickers.id,
				restorable.map((r) => r.id),
			),
		);
	return { restored: restorable.length };
}
