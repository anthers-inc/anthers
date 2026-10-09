// SPDX-License-Identifier: Apache-2.0
/**
 * The storage reading — one account's allowance, what it has drawn, and what is left.
 *
 * The route surface composes its answer here and nowhere else, on the one-writer rule
 * every service module carries: the meter (`jobs/storage-usage.ts`) is the only writer of
 * `storage_usage` rows, and this is the only reader that turns a row into the account-facing
 * shape. Nothing here recomputes bytes from the upstream tables — the figure served is the
 * figure the meter stored, because a second derivation would be exactly the drift the
 * meter's DB-first rule exists to prevent.
 *
 * 🚨 **The allowance resolves from the held Anthers Badge, and the reading is cycle-shaped.**
 * `heldAnthersBadgeAmount` answers this cycle's held threshold, which `storageGibFor` turns
 * into the ruled ladder's figure — the same read the save routes run for their perk gate, so
 * the allowance a reading shows is the allowance the gates enforce. A lapsed Badge reads as
 * free's 25 GiB, which is true: the floor is combined and unBadge'd.
 *
 * ⚠️ **An account with no row this cycle is not zero — it is unmetered-yet.** The daily
 * sweep writes a row only for accounts holding bytes, so a fresh account's reading answers
 * the all-zero shape rather than a missing row, and the caller's `sampledAt: null` says the
 * estimate has not been sampled this cycle rather than pretending zeros were measured.
 */

import { db } from "@anthers/db/client";
import { storageUsage } from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import {
	STORAGE_LADDER_GIB,
	STORAGE_PER_GIB_MONTH,
	STORAGE_USE_KINDS,
	type StorageUseKind,
	storageGibFor,
} from "@anthers/shared/constants";
import { and, eq } from "drizzle-orm";
import { heldAnthersBadgeAmount } from "./anthers-badges.js";

/** The account-facing reading. Figures are bytes and GiB as numbers; money is a string. */
export interface StorageReading {
	/** The ruled allowance at this account's held Badge, in GiB. */
	allowanceGiB: number;
	/** Bytes held this cycle, across every purpose — the figure the allowance binds. */
	bytesUsed: number;
	/** The allowance-binding figure in GiB, one decimal — what the panel draws the bar against. */
	giBUsed: number;
	/** Bytes remaining under the allowance, 0 when over. */
	bytesFree: number;
	/** Whether the account can buy overflow at cost — Root or above. */
	topUpEligible: boolean;
	/**
	 * The at-cost charge, in dollars, for the bytes past the allowance — "0.00" when
	 * within it or not eligible. **An estimate beside the readings**, computed the same
	 * way `estimateStorageCost` computes it, never a billed figure.
	 */
	overflowCost: string;
	/** Per-purpose lines, keyed by every known kind so a reader never has to default them. */
	purposes: Record<StorageUseKind, number>;
	/** When this cycle's figure was sampled — null before the meter's first sweep saw the account. */
	sampledAt: Date | null;
	/** The cycle the reading belongs to. */
	cycle: string;
}

/** The reading for one account, this cycle (or the cycle named — tests freeze one). */
export async function storageReadingFor(userId: number, cycle?: string): Promise<StorageReading> {
	const billingCycle = cycle ?? currentCycleKey();
	const anthersDollars = await heldAnthersBadgeAmount(userId);
	const allowanceGiB = storageGibFor(anthersDollars);
	const allowanceBytes = allowanceGiB * 1024 * 1024 * 1024;

	const [row] = await db
		.select()
		.from(storageUsage)
		.where(and(eq(storageUsage.userId, userId), eq(storageUsage.billingCycle, billingCycle)))
		.limit(1);

	const purposes = Object.fromEntries(STORAGE_USE_KINDS.map((k) => [k, 0])) as Record<
		StorageUseKind,
		number
	>;
	if (row) {
		for (const kind of STORAGE_USE_KINDS) {
			purposes[kind] = row.purposes[kind] ?? 0;
		}
	}
	const bytesUsed = row?.bytes ?? 0;
	const giBUsed = Math.round((bytesUsed / (1024 * 1024 * 1024)) * 10) / 10;
	const bytesFree = Math.max(0, allowanceBytes - bytesUsed);
	const topUpEligible = allowanceGiB > STORAGE_LADDER_GIB.free;
	const overflowGiB =
		bytesUsed > allowanceBytes ? (bytesUsed - allowanceBytes) / (1024 * 1024 * 1024) : 0;
	const overflowCost = topUpEligible ? (overflowGiB * STORAGE_PER_GIB_MONTH).toFixed(2) : "0.00";

	return {
		allowanceGiB,
		bytesUsed,
		giBUsed,
		bytesFree,
		topUpEligible,
		overflowCost,
		purposes,
		sampledAt: row?.sampledAt ?? null,
		cycle: billingCycle,
	};
}
