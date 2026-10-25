// SPDX-License-Identifier: Apache-2.0
/**
 * The preservation program — the one writer of `works.preserved`.
 *
 * **A Work anybody has saved to their Library stays available, indefinitely.** A purchase
 * saves itself to the Library (`services/library.ts`), so every sold Work qualifies, and
 * so does a free Work somebody chose to keep. What the program then promises is narrow and
 * absolute: if the creator withdraws the Work or closes their account, Anthers keeps its
 * media rather than removing it, and nothing expires.
 *
 * ⭐ **Why this is a program and not a perk** (Parker, 2026-10-25). Preservation is a
 * cultural benefit whether or not any individual chooses to carry it — a work that survives
 * its creator leaving is worth more to everyone than the bytes cost — so it sits beside
 * free access among the charitable programs, funded from Anthers Support, rather than on
 * the Badge ladder. The design it replaced asked a buyer to hold a Badge and elect to keep
 * a withdrawn Work, which had two structural faults rather than fixable ones: a Work several
 * people kept was stored once and each holder drew a share, so the last holder standing
 * silently inherited the whole object; and it put a preservation decision in front of
 * somebody reading a storage bar, which is the wrong person at the wrong moment.
 *
 * 🚨 **The write is one-way, and that is the promise.** A Work enters when its first Library
 * entry lands and never leaves: unsaving later, or a refund releasing a shelf entry, does
 * not un-preserve a Work Anthers has already undertaken to keep. Nothing here ever sets the
 * column back to false, and nothing should.
 *
 * ⚠️ **Preserved bytes leave every allowance.** They are the program's own cost and appear
 * in no account's meter — the storage sweep excludes preserved Works from the per-account
 * figures it writes. Charging a creator or a reader for the bytes Anthers keeps on the
 * public's behalf would be charging them for the program.
 */

import { assets, db, webBuildFiles, webBuilds, works } from "@anthers/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Put a Work in the preservation program, if it is not already in it.
 *
 * Idempotent and cheap enough to call on every save: the `preserved = false` predicate makes
 * a repeat a no-op the database answers without a row version changing.
 *
 * ⚠️ **Called from every door that writes a Library entry for a Work** — a person pressing
 * Save, a purchase completing, and a reader's space projecting its shelf. A fourth door that
 * forgets this call creates a Work a buyer can lose, so the door belongs beside the save it
 * follows rather than anywhere else.
 */
export async function preserveWork(workId: number): Promise<void> {
	await db
		.update(works)
		.set({ preserved: true })
		.where(and(eq(works.id, workId), eq(works.preserved, false)));
}

/**
 * What the program holds: how many Works, and how many bytes Anthers is carrying for them.
 *
 * ⚠️ **The figure counts DB-known media only** — the same enumeration the purge would
 * remove (asset rows carry their own sizes, and so do browser-build files). It is not the
 * vendor's billed figure, which also counts HLS output and source objects the meter measures
 * with a `size()` head; an inventory is what the program can enumerate without a network
 * round trip per Work, and the plan's cost line reads the vendor's rate against it.
 */
export async function preservationInventory(): Promise<{ works: number; bytes: number }> {
	const [counted] = await db
		.select({ count: sql<string>`COUNT(*)` })
		.from(works)
		.where(eq(works.preserved, true));
	const [assetTotal] = await db
		.select({ total: sql<string>`COALESCE(SUM(${assets.fileSize}), 0)` })
		.from(assets)
		.innerJoin(works, eq(assets.workId, works.id))
		.where(eq(works.preserved, true));
	const [buildTotal] = await db
		.select({ total: sql<string>`COALESCE(SUM(${webBuildFiles.fileSize}), 0)` })
		.from(webBuildFiles)
		.innerJoin(webBuilds, eq(webBuildFiles.buildId, webBuilds.id))
		.innerJoin(works, eq(webBuilds.workId, works.id))
		.where(eq(works.preserved, true));
	return {
		works: Number(counted?.count ?? 0),
		bytes: Number(assetTotal?.total ?? 0) + Number(buildTotal?.total ?? 0),
	};
}
