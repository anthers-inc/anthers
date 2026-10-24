// SPDX-License-Identifier: Apache-2.0
/**
 * Drain the receipts Anthers owes readers' spaces.
 *
 * ⭐ **The `access_receipts` row is the worklist, and the sweep is the guarantee.** A payment
 * webhook inserts a `pending` row when it stamps a purchase; this job writes the signed
 * record into the reader's space and marks the row. That is the same split the space outbox
 * uses: the database says what is owed, the sweep is what moves it, and a missed enqueue
 * costs a minute rather than the write.
 *
 * ⚠️ **The sweep is bounded and sequential on purpose.** One receipt is one small record to
 * another server; fifty of them at once would spend the reader's PDS login budget and this
 * worker's attention for no gain. A failure leaves the row `pending` with its attempts
 * counted, and only an exhausted row is marked `failed` — a state a person reads, not one
 * another retry silently papers over.
 *
 * A reader with no hosted identity is `skipped`, not failed: Anthers has no credential for
 * that space, so the receipt waits for a reissue after the same choice every other space
 * write waits on.
 */
import { db } from "@anthers/db";
import { accessReceipts } from "@anthers/db/schema";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { type ReceiptKind, writeAccessReceipt } from "../services/access-receipts.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";

export interface AccessReceiptsJobData {
	/** How many owed receipts one pass may attempt. */
	limit?: number;
	/**
	 * Scope one pass to named purchases, for a reissue or a drill. The cron sweep omits it
	 * and takes whatever is owed, oldest first.
	 */
	purchaseIds?: number[];
}

/** Test seams: the worker passes none, and each row's write resolves its own session. */
export interface AccessReceiptsJobOptions {
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
}

/** Attempts before a row is marked failed. The job's own cron is the retry clock. */
export const RECEIPT_MAX_ATTEMPTS = 8;

export async function accessReceiptsJob(
	data: AccessReceiptsJobData = {},
	options: AccessReceiptsJobOptions = {},
): Promise<void> {
	const limit = data.limit ?? 50;
	const scope = data.purchaseIds?.length
		? inArray(accessReceipts.purchaseId, data.purchaseIds)
		: undefined;
	const owed = await db
		.select()
		.from(accessReceipts)
		.where(
			and(
				eq(accessReceipts.state, "pending"),
				lt(accessReceipts.attempts, RECEIPT_MAX_ATTEMPTS),
				scope,
			),
		)
		.orderBy(asc(accessReceipts.createdAt))
		.limit(limit);
	if (owed.length === 0) return;

	let written = 0;
	let failed = 0;
	let skipped = 0;
	for (const row of owed) {
		const now = new Date();
		const attempts = row.attempts + 1;
		try {
			const result = await writeAccessReceipt(row.purchaseId, row.kind as ReceiptKind, {
				now,
				resolveSession: options.resolveSession,
				fetchImpl: options.fetchImpl,
			});
			if (result.outcome === "written" || result.outcome === "already_written") {
				await db
					.update(accessReceipts)
					.set({
						state: "written",
						attempts,
						spaceUri: result.spaceUri,
						lastError: null,
						writtenAt: now,
						updatedAt: now,
					})
					.where(eq(accessReceipts.id, row.id));
				written++;
				continue;
			}
			if (result.reason === "no_reader" || result.reason === "not_hosted") {
				await db
					.update(accessReceipts)
					.set({ state: "skipped", attempts, lastError: result.reason, updatedAt: now })
					.where(eq(accessReceipts.id, row.id));
				skipped++;
				continue;
			}
			// `not_settled` and `not_refunded` are races with the row that owes the receipt;
			// they retry like any other unfinished write.
			await db
				.update(accessReceipts)
				.set({
					attempts,
					lastError: result.reason,
					state: attempts >= RECEIPT_MAX_ATTEMPTS ? "failed" : "pending",
					updatedAt: now,
				})
				.where(eq(accessReceipts.id, row.id));
			if (attempts >= RECEIPT_MAX_ATTEMPTS) failed++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await db
				.update(accessReceipts)
				.set({
					attempts,
					lastError: message,
					state: attempts >= RECEIPT_MAX_ATTEMPTS ? "failed" : "pending",
					updatedAt: now,
				})
				.where(eq(accessReceipts.id, row.id));
			if (attempts >= RECEIPT_MAX_ATTEMPTS) failed++;
			console.error(`[access-receipts] purchase ${row.purchaseId} ${row.kind}: ${message}`);
		}
	}
	if (written > 0 || failed > 0 || skipped > 0) {
		console.log(
			`[access-receipts] ${owed.length} owed: ${written} written, ${failed} failed, ` +
				`${skipped} skipped`,
		);
	}
}
