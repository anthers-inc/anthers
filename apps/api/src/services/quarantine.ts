// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Quarantine — the one place material is taken out of reach of everybody, including
 * the people who paid for it.
 *
 * This is the child-safety counterpart to `services/dmca.ts`, and the difference between
 * them is the whole reason it exists. A **withdrawal** keeps serving buyers, because a
 * purchase outlives the Work. A **takedown** stops serving buyers because continuing to
 * deliver infringing bytes is continuing to infringe. A **quarantine** stops serving
 * everybody — buyers, the creator, an operator — because the material may not be
 * delivered to anyone at all, and a receipt is not an exception to that.
 *
 * 🚨 **Nothing here deletes.** Removal is a state on this platform and never a delete,
 * and here that ordinary rule and 18 U.S.C. § 2258A(h) point the same way: a completed
 * CyberTipline report is itself a one-year preservation request, so destroying the object
 * would be destroying evidence under a statutory hold. Objects are **moved** to the
 * quarantine prefix, which no signer will touch, and a hold is placed in the same breath.
 *
 * **The four things a quarantine has to do, and where each one lives:**
 *
 * 1. *The object leaves every delivery path.* `storage.move` into `QUARANTINE_PREFIX`,
 *    and `assertServableKey` makes `getUrl` and the presigner throw on the result.
 * 2. *The Work leaves `released`.* Here, recording `priorVisibility` so a cleared finding
 *    restores what the creator actually chose.
 * 3. *A record is written, never a rendering.* `media_quarantine` — see the schema note.
 * 4. *Everything quarantined is under a preservation hold.* `placeHold` on the Work, the
 *    uploader and the report, so no sweep can reach any of it.
 *
 * ⚠️ **Delivery is denied in two independent places and that is deliberate.**
 * `resolveAccessSync` refuses the Work, which every delivery route inherits for free; the
 * storage layer refuses the key, which catches a route that never resolved a Work. Either
 * alone would be enough on a good day. This is not a good-day feature.
 *
 * **What this deliberately does not decide: whether the uploader's account is suspended.**
 * `40.06` refuses a `user` subject with `400 not_moderatable` because suspension has
 * unanswered consequences for Works, purchases, support in flight and payouts, and
 * 60.14's Step 6 tells an operator not to invent one during an incident. Denying delivery
 * is this module; suspending a person is a decision that has not been taken.
 */

import { db } from "@anthers/db/client";
import type { VendorMatch } from "@anthers/db/schema";
import {
	assets,
	mediaQuarantine,
	moderationActions,
	moderationReports,
	transcodingJobs,
	works,
} from "@anthers/db/schema";
import type { ModerationActionType } from "@anthers/shared/moderation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { placeHold, preservationExpiry } from "./legal-hold.js";
import { urlToKey } from "./media-purge.js";
import { originalKeyFor, quarantineKeyFor } from "./storage/acl.js";
import { storage } from "./storage/index.js";

/** How a finding arrived. A hash match and a classifier hunch may never collapse into one. */
export type QuarantineSource = "report" | "scan" | "operator";

/** Which of a Work's objects a row names, for the operator and for the restore. */
export type QuarantineObjectKind = "source" | "thumbnail" | "asset" | "audio" | "hls";

export interface QuarantineInput {
	workId: number;
	source: QuarantineSource;
	/**
	 * **Our own determination** — what Anthers concluded this is, in our vocabulary.
	 *
	 * 🚨 Never a vendor's answer. § 7.6 of 60.13: a detection vendor's data is an input to
	 * our determination and never a substitute for it, and Shield says outright that its
	 * classifications are not final determinations of legality. Pass the vendor's answer as
	 * `vendorMatch` instead, which is kept apart for retention and for the rule that it
	 * must never reach an agent.
	 */
	classification: string;
	/** What a detection vendor returned, when one did. See the schema note before reading it. */
	vendorMatch?: VendorMatch | null;
	/** The operator who acted, or null when a job did. */
	actorId?: number | null;
	/** The report that triggered this, when one did. */
	reportId?: number | null;
	note?: string;
}

export interface QuarantineResult {
	/** How many objects were moved out of reach. Zero is legitimate — see below. */
	objectsMoved: number;
	/** Objects the database named that storage did not have. Recorded, never fatal. */
	objectsMissing: number;
	holdIds: number[];
}

/**
 * One object a Work owns: where the database says it is, and what kind of thing it is.
 *
 * Enumerated here rather than by the caller, on exactly the rule `media-purge.ts` states
 * for deletion — *a caller says WHAT is going away, never WHICH KEYS.* The two paths
 * diverged once already when only one of them swept storage, and a quarantine that misses
 * an object is the same defect with a much worse subject.
 */
interface WorkObject {
	key: string;
	kind: QuarantineObjectKind;
}

/**
 * Every object of a Work's that could be delivered.
 *
 * ⚠️ **HLS renditions and processed audio are included even though they are derived**,
 * which is the opposite of the rule `40.12` states for *scanning* — there, a transform of
 * a source already handled needs no independent scan. Detection and quarantine ask
 * different questions: a rendition is not new material to check, and it is absolutely
 * still bytes a player can fetch. Leaving them behind would take the source out of reach
 * and keep serving the video.
 */
async function objectsFor(workId: number): Promise<WorkObject[]> {
	const [work] = await db
		.select({ sourceKey: works.sourceKey, thumbnail: works.thumbnail })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return [];

	const [assetRows, jobRows] = await Promise.all([
		db.select({ file: assets.file }).from(assets).where(eq(assets.workId, workId)),
		db
			.select({
				hlsManifestUrl: transcodingJobs.hlsManifestUrl,
				outputFileUrl: transcodingJobs.outputFileUrl,
			})
			.from(transcodingJobs)
			.where(eq(transcodingJobs.workId, workId)),
	]);

	const out: WorkObject[] = [];
	const seen = new Set<string>();
	const add = (raw: string | null, kind: QuarantineObjectKind) => {
		if (!raw) return;
		const key = urlToKey(raw);
		if (!key || seen.has(key)) return;
		seen.add(key);
		out.push({ key, kind });
	};

	add(work.sourceKey, "source");
	add(work.thumbnail, "thumbnail");
	for (const a of assetRows) add(a.file, "asset");
	for (const j of jobRows) {
		add(j.outputFileUrl, "audio");
		// The manifest names a directory of segments. Every one of them is a separate
		// object, so the prefix is expanded rather than moved as a unit — `storage.move`
		// takes keys, and a prefix move would need a list-and-copy of its own.
		if (j.hlsManifestUrl) {
			const master = urlToKey(j.hlsManifestUrl);
			for (const key of await listHlsObjects(master)) add(key, "hls");
		}
	}
	return out;
}

/**
 * Every object under an HLS master's directory.
 *
 * The manifest is fetched and its segment references resolved rather than the prefix
 * being listed, because `StorageService` has no list primitive and adding one for this
 * would be a wider change than the case needs. A variant playlist is followed one level,
 * which is the depth `jobs/transcode-video.ts` produces.
 */
async function listHlsObjects(masterKey: string): Promise<string[]> {
	const prefix = masterKey.replace(/\/[^/]+$/, "");
	if (!prefix || prefix === masterKey) return [masterKey];

	const found = new Set<string>([masterKey]);
	const queue = [masterKey];
	// Depth 2: master → variant playlists → segments. Bounded explicitly rather than
	// recursing, so a malformed manifest cannot spin.
	for (let depth = 0; depth < 2 && queue.length > 0; depth++) {
		const level = queue.splice(0, queue.length);
		for (const key of level) {
			const bytes = await storage.read(key).catch(() => null);
			if (!bytes) continue;
			for (const line of new TextDecoder().decode(bytes).split("\n")) {
				const name = line.trim();
				// Playlist directives start with `#`; everything else is a relative path.
				if (!name || name.startsWith("#") || name.includes("/")) continue;
				const child = `${prefix}/${name}`;
				if (found.has(child)) continue;
				found.add(child);
				if (name.endsWith(".m3u8")) queue.push(child);
			}
		}
	}
	return [...found];
}

/**
 * Take a Work's material out of reach and preserve it.
 *
 * Idempotent: quarantining a Work that is already quarantined moves whatever objects are
 * still in place and adds no second set of records. That matters because the realistic
 * caller is an operator acting during an incident, and 60.14 Step 2 is explicit that a
 * report is never delayed for want of tooling — so the button has to be safe to press
 * twice.
 *
 * 🚨 **Storage moves happen BEFORE the transaction, and the ordering is the design.** A
 * commit followed by a failed move leaves the database saying the material is out of
 * reach while it is still servable, which is the one lie this module cannot tell. Moving
 * first means the failure mode is an object already parked with no row explaining it —
 * unreachable, and visible in the next quarantine of the same Work.
 */
export async function quarantineWork(input: QuarantineInput): Promise<QuarantineResult> {
	const [work] = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			visibility: works.visibility,
			quarantineStatus: works.quarantineStatus,
		})
		.from(works)
		.where(eq(works.id, input.workId))
		.limit(1);
	if (!work) throw new Error(`No such Work: ${input.workId}`);

	const objects = await objectsFor(input.workId);
	const moved: (WorkObject & { quarantineKey: string })[] = [];
	let objectsMissing = 0;

	for (const object of objects) {
		const quarantineKey = quarantineKeyFor(object.key);
		const ok = await storage.move(object.key, quarantineKey);
		if (ok) moved.push({ ...object, quarantineKey });
		else objectsMissing++;
	}

	// Only the first quarantine records what the creator had chosen. A second pass on an
	// already-delisted Work would otherwise overwrite `released` with `private` and lose
	// the way back.
	const priorVisibility =
		work.quarantineStatus === "quarantined" ? "" : (work.visibility ?? "private");

	await db.transaction(async (tx) => {
		await tx
			.update(works)
			.set({
				quarantineStatus: "quarantined",
				// The Work leaves `released`. Delisting matters beyond the delivery denial
				// because a listed card still renders its thumbnail from the public bucket,
				// and for this material the thumbnail may be the finding itself.
				visibility: "private",
			})
			.where(eq(works.id, input.workId));

		if (moved.length > 0) {
			await tx.insert(mediaQuarantine).values(
				moved.map((object) => ({
					workId: input.workId,
					uploaderId: work.creatorId,
					originalKey: object.key,
					quarantineKey: object.quarantineKey,
					objectKind: object.kind,
					source: input.source,
					classification: input.classification,
					vendorMatch: input.vendorMatch ?? null,
					reportId: input.reportId ?? null,
					priorVisibility,
					placedBy: input.actorId ?? null,
					note: input.note ?? "",
				})),
			);
		}

		// The append-only log every other moderation decision writes to, so an operator
		// reading a Work's history sees this beside the hides and the takedowns rather
		// than having to know a second table exists.
		//
		// `action: "hide"` with a distinguishing `reason`, which is exactly what
		// `takeDownWork` does with `reason: "dmca"`. The action vocabulary stays two-valued
		// on purpose — widening `ModerationActionType` would mean every reader of the log
		// grew a case for a decision that is, mechanically, still "this stopped being
		// served". What kind of stopping it was is the reason's job.
		await tx.insert(moderationActions).values({
			subjectType: "work",
			subjectId: input.workId,
			action: "hide" satisfies ModerationActionType,
			actorId: input.actorId ?? null,
			actorRole: input.actorId == null ? "automated" : "operator",
			reason: "quarantine",
			// Our determination only. A vendor's classification is Match Data and must not be
			// copied into the append-only log, which is permanent and read by agents.
			note: [input.source, input.classification, input.note].filter(Boolean).join(": "),
		});

		// Acting on the material answers any open report about it. Left open, the queue
		// would keep re-serving work that is done.
		await tx
			.update(moderationReports)
			.set({
				status: "resolved",
				resolvedAt: new Date(),
				resolvedBy: input.actorId ?? null,
			})
			.where(
				and(
					eq(moderationReports.subjectType, "work"),
					eq(moderationReports.subjectId, input.workId),
					eq(moderationReports.status, "open"),
				),
			);
	});

	// 🚨 Placed AFTER the state is written, and never skipped. Everything quarantined is
	// under a preservation hold — quarantining without one moves material somewhere a
	// sweep can still reach, which is worse than leaving it where it was, because nothing
	// is watching the quarantine prefix.
	const expiresAt = preservationExpiry();
	const reason = `Quarantine of Work ${input.workId} (${input.source}), § 2258A(h) preservation`;
	const holdIds: number[] = [];
	holdIds.push(
		(
			await placeHold({
				subjectType: "work",
				subjectId: input.workId,
				reason,
				placedBy: input.actorId ?? null,
				expiresAt,
			})
		).holdId,
	);
	if (work.creatorId != null) {
		holdIds.push(
			(
				await placeHold({
					subjectType: "user",
					subjectId: work.creatorId,
					reason,
					placedBy: input.actorId ?? null,
					expiresAt,
				})
			).holdId,
		);
	}
	if (input.reportId != null) {
		holdIds.push(
			(
				await placeHold({
					subjectType: "report",
					subjectId: input.reportId,
					reason,
					placedBy: input.actorId ?? null,
					expiresAt,
				})
			).holdId,
		);
	}

	return { objectsMoved: moved.length, objectsMissing, holdIds };
}

/**
 * Put a Work's material back, for a finding that turned out to be wrong.
 *
 * **The legal hold is deliberately NOT lifted here.** A quarantine can be cleared because
 * somebody looked and the finding was mistaken; a preservation obligation ends when the
 * obligation ends, which is a different question decided by a different person on a
 * statutory clock. Coupling them would make "this was not what we thought" silently
 * destroy the record of having checked. `liftHold` is the explicit second act.
 */
export async function clearQuarantine(input: {
	workId: number;
	actorId: number;
	note?: string;
}): Promise<{ objectsRestored: number; visibility: string }> {
	const rows = await db
		.select()
		.from(mediaQuarantine)
		.where(and(eq(mediaQuarantine.workId, input.workId), isNull(mediaQuarantine.clearedAt)))
		.orderBy(desc(mediaQuarantine.placedAt));
	if (rows.length === 0) return { objectsRestored: 0, visibility: "" };

	let restored = 0;
	for (const row of rows) {
		if (await storage.move(row.quarantineKey, originalKeyFor(row.quarantineKey))) restored++;
	}

	// The oldest surviving row carries what the creator had chosen — later rows from a
	// repeat quarantine record an empty string rather than overwriting it.
	const prior =
		rows
			.map((r) => r.priorVisibility)
			.filter(Boolean)
			.at(-1) ?? "private";

	await db.transaction(async (tx) => {
		await tx
			.update(works)
			.set({ quarantineStatus: "none", visibility: prior })
			.where(eq(works.id, input.workId));

		await tx
			.update(mediaQuarantine)
			.set({ clearedAt: new Date(), clearedBy: input.actorId, note: input.note ?? "" })
			.where(
				inArray(
					mediaQuarantine.id,
					rows.map((r) => r.id),
				),
			);

		await tx.insert(moderationActions).values({
			subjectType: "work",
			subjectId: input.workId,
			action: "restore" satisfies ModerationActionType,
			actorId: input.actorId,
			actorRole: "operator",
			reason: "",
			note: ["quarantine cleared", input.note].filter(Boolean).join(": "),
		});
	});

	return { objectsRestored: restored, visibility: prior };
}

/** What the console renders for one finding. Keys and metadata — never the material. */
export interface QuarantineFinding {
	id: number;
	workId: number | null;
	workTitle: string;
	uploaderId: number | null;
	originalKey: string;
	objectKind: string;
	source: string;
	classification: string;
	reportId: number | null;
	placedAt: string;
	clearedAt: string | null;
	note: string;
}

/**
 * The operator's list.
 *
 * 🚨 **`vendorMatch` is deliberately not selected here**, and that is a second omission on
 * top of the one below. A vendor's Match Data is license-restricted — Shield's terms forbid
 * using it as input to generative AI — and this list is the surface most likely to be read
 * by, screenshotted into, or pasted at an agent. Our own determination is enough to work
 * the queue; reading the vendor's answer should take a deliberate second step rather than
 * arriving in every listing.
 *
 * 🚨 There is no `thumbnail`, no `url` and no `preview` on the row this returns, and there
 * must not be. § 5.2 of 60.13 commits Anthers to an operator surface that shows the
 * finding and never the material — so adding one would be a policy amendment rather than
 * a feature. The keys are here because a key is what a CyberTipline report cites.
 */
export async function loadQuarantineFindings(
	opts: { includeCleared?: boolean; limit?: number } = {},
): Promise<QuarantineFinding[]> {
	const rows = await db
		.select({
			id: mediaQuarantine.id,
			workId: mediaQuarantine.workId,
			workTitle: works.title,
			uploaderId: mediaQuarantine.uploaderId,
			originalKey: mediaQuarantine.originalKey,
			objectKind: mediaQuarantine.objectKind,
			source: mediaQuarantine.source,
			classification: mediaQuarantine.classification,
			reportId: mediaQuarantine.reportId,
			placedAt: mediaQuarantine.placedAt,
			clearedAt: mediaQuarantine.clearedAt,
			note: mediaQuarantine.note,
		})
		.from(mediaQuarantine)
		.leftJoin(works, eq(mediaQuarantine.workId, works.id))
		.where(opts.includeCleared ? undefined : isNull(mediaQuarantine.clearedAt))
		.orderBy(desc(mediaQuarantine.placedAt))
		.limit(opts.limit ?? 200);

	return rows.map((r) => ({
		id: r.id,
		workId: r.workId,
		workTitle: r.workTitle ?? "",
		uploaderId: r.uploaderId,
		originalKey: r.originalKey,
		objectKind: r.objectKind,
		source: r.source,
		classification: r.classification,
		reportId: r.reportId,
		placedAt: r.placedAt.toISOString(),
		clearedAt: r.clearedAt?.toISOString() ?? null,
		note: r.note,
	}));
}

/** How many findings are open. For the console's headline row. */
export async function quarantineSummary(): Promise<{ openFindings: number; works: number }> {
	const rows = await db
		.select({ workId: mediaQuarantine.workId })
		.from(mediaQuarantine)
		.where(isNull(mediaQuarantine.clearedAt));
	return {
		openFindings: rows.length,
		works: new Set(rows.map((r) => r.workId)).size,
	};
}
