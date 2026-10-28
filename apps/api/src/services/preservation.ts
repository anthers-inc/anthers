// SPDX-License-Identifier: Apache-2.0
/**
 * The preservation program — the one writer of the preservation flag.
 *
 * **A Work anybody has saved to their Library stays available, indefinitely.** A purchase
 * saves itself to the Library (`services/library.ts`), so every sold Work qualifies, and
 * so does a free Work somebody chose to keep. What the program then promises is narrow and
 * absolute: if the creator withdraws the Work or closes their account, Anthers keeps its
 * media rather than removing it, and nothing expires.
 *
 * 🚨 **"Anybody" means somebody other than the creator.** A creator may keep their own
 * unreleased Work (`saveWork` allows it), and a flag set by that save would make the draft
 * permanently undeletable — the program exists to keep what somebody else has. So
 * `preserveCurrentVersion` carries the keeper and refuses the creator's own save, which is
 * what makes a set flag mean *this Work was released and is being kept*, and what lets both
 * disposal doors ask the flag alone.
 *
 * ⭐ **The flag marks a VERSION, because a version is what Anthers actually keeps**
 * (Parker, 2026-10-25). Two columns hold it, one for each place a version can be: the one
 * the Work currently serves carries it on `works.preserved`, and a version a replace
 * retired carries it on `work_media_versions.preserved`. `preserveCurrentVersion` writes
 * the first; `services/work-versions.ts` moves it to the second at archive time, and a
 * replacement inherits it, because the new bytes are the ones the Work's holders now fetch.
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
 * entry lands and never leaves: unsaving later, or a refund releasing a Library entry, does
 * not un-preserve a Work Anthers has already undertaken to keep. Nothing here ever sets the
 * column back to false, and nothing should.
 *
 * ⚠️ **Preserved bytes leave every allowance.** They are the program's own cost and appear
 * in no account's meter — the storage sweep excludes preserved Works from the per-account
 * figures it writes. Charging a creator or a reader for the bytes Anthers keeps on the
 * public's behalf would be charging them for the program.
 */

import { db, workAssets, workBuildFiles, workBuilds, workMediaVersions, works } from "@anthers/db";
import type { WorkVersionMedia } from "@anthers/db/schema";
import { and, eq, exists, isNull, ne, or, type SQL, sql } from "drizzle-orm";

/**
 * Mark the media version this Work currently serves as preserved, if somebody other than
 * its creator is keeping it.
 *
 * Idempotent and cheap enough to call on every save: the `preserved = false` predicate makes
 * a repeat a no-op the database answers without a row version changing.
 *
 * 🚨 **The keeper is carried into the predicate, and the creator's own save is refused.**
 * `saveWork` lets a creator keep their own unreleased Work, and a flag set by that save
 * would make a draft permanently undeletable — preservation is what *somebody else* keeping
 * a Work earns. A Work whose creator has already gone (`creatorId` null) has no creator left
 * to be the keeper, so a later save still counts.
 *
 * ⚠️ **Called from every door that writes a Library entry for a Work** — a person pressing
 * Save, a purchase completing, and a reader's space projecting its Library. A fourth door that
 * forgets this call creates a Work whose current version a buyer can lose, so the door
 * belongs beside the save it follows rather than anywhere else.
 */
export async function preserveCurrentVersion(workId: number, keeperId: number): Promise<void> {
	await db
		.update(works)
		.set({ preserved: true })
		.where(
			and(
				eq(works.id, workId),
				eq(works.preserved, false),
				or(isNull(works.creatorId), ne(works.creatorId, keeperId)),
			),
		);
}

/**
 * **This Work has a preserved version** — the current one, or one a replacement retired.
 *
 * The one definition of "Anthers keeps this Work", shared by the two things that ask:
 * the withdrawn-Work sweep (which must not purge it) and account deletion (which must
 * withdraw rather than destroy it). Writing it twice is how the two answers drift, and
 * the drift is a Work kept by one path and destroyed by the other.
 */
export const hasPreservedVersion: SQL<unknown> = or(
	eq(works.preserved, true),
	exists(
		db
			.select({ id: workMediaVersions.id })
			.from(workMediaVersions)
			.where(and(eq(workMediaVersions.workId, works.id), eq(workMediaVersions.preserved, true))),
	),
) as SQL<unknown>;

/**
 * What the program holds: how many Works, and how many bytes Anthers is carrying for them.
 *
 * ⚠️ **The figure counts DB-known media only** — the same enumeration the purge would
 * remove (asset rows carry their own sizes, and so do browser-build files). It is not the
 * vendor's billed figure, which also counts HLS output and source objects the meter measures
 * with a `size()` head; an inventory is what the program can enumerate without a network
 * round trip per Work, and the plan's cost line reads the vendor's rate against it.
 */
/** The bytes one archived version's manifest declares — its files carry their own sizes. */
function manifestBytes(media: WorkVersionMedia): number {
	if (media.kind === "source") return media.file.fileSize ?? 0;
	if (media.kind === "set") {
		return media.files.reduce((sum, file) => sum + (file.fileSize ?? 0), 0);
	}
	return (
		media.assets.reduce((sum, asset) => sum + (asset.fileSize ?? 0), 0) +
		media.webBuilds.reduce(
			(sum, build) => sum + build.files.reduce((acc, file) => acc + (file.fileSize ?? 0), 0),
			0,
		)
	);
}

export async function preservationInventory(): Promise<{ works: number; bytes: number }> {
	const hasPreservedVersion = exists(
		db
			.select({ id: workMediaVersions.id })
			.from(workMediaVersions)
			.where(and(eq(workMediaVersions.workId, works.id), eq(workMediaVersions.preserved, true))),
	);
	const [counted] = await db
		.select({ count: sql<string>`COUNT(*)` })
		.from(works)
		.where(or(eq(works.preserved, true), hasPreservedVersion));
	// The current version's counted media, where the current version is the one preserved.
	const [assetTotal] = await db
		.select({ total: sql<string>`COALESCE(SUM(${workAssets.fileSize}), 0)` })
		.from(workAssets)
		.innerJoin(works, eq(workAssets.workId, works.id))
		.where(eq(works.preserved, true));
	const [buildTotal] = await db
		.select({ total: sql<string>`COALESCE(SUM(${workBuildFiles.fileSize}), 0)` })
		.from(workBuildFiles)
		.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
		.innerJoin(works, eq(workBuilds.workId, works.id))
		.where(eq(works.preserved, true));
	// And the preserved archived versions, whose manifests carry their own sizes.
	const archived = await db
		.select({ media: workMediaVersions.media })
		.from(workMediaVersions)
		.where(eq(workMediaVersions.preserved, true));
	return {
		works: Number(counted?.count ?? 0),
		bytes:
			Number(assetTotal?.total ?? 0) +
			Number(buildTotal?.total ?? 0) +
			archived.reduce((sum, row) => sum + manifestBytes(row.media), 0),
	};
}
