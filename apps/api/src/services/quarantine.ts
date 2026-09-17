// SPDX-License-Identifier: Apache-2.0
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
 * The wiki's *Moderation & Reporting* refuses a `user` subject with `400 not_moderatable` because suspension has
 * unanswered consequences for Works, purchases, support in flight and payouts, and
 * Child Safety Incident Runbook's Step 6 tells an operator not to invent one during an incident. Denying delivery
 * is this module; suspending a person is a decision that has not been taken.
 */

import { db } from "@anthers/db/client";
import type { VendorMatch } from "@anthers/db/schema";
import {
	adminAccounts,
	assets,
	mediaQuarantine,
	moderationActions,
	moderationReports,
	transcodingJobs,
	users,
	works,
} from "@anthers/db/schema";
import type { ModerationActionType } from "@anthers/shared/moderation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { placeHold, preservationExpiry } from "./legal-hold.js";
import { restoreStickersOnSubject, voidStickersOnSubject } from "./sticker-void.js";
import { originalKeyFor, quarantineKeyFor } from "./storage/acl.js";
import { storage } from "./storage/index.js";
import { urlToKey } from "./storage/keys.js";
import { queueWorkListingSync } from "./work-listing.js";

/** How a finding arrived. A hash match and a classifier hunch may never collapse into one. */
export type QuarantineSource = "report" | "scan" | "operator";

/** Which of a Work's objects a row names, for the operator and for the restore. */
export type WorkObjectKind = "source" | "thumbnail" | "asset" | "audio" | "hls";

/**
 * An object belonging to no Work — display chrome and badge art.
 *
 * ⭐ **These are the upload routes' own `mediaType` words**, deliberately, so an operator
 * reading a finding sees the same noun the uploader's request carried and nobody has to
 * maintain a translation. `gallery` is the key prefix that `image` and `screenshot` also
 * land in, so all three arrive here as `gallery`.
 */
export type ChromeObjectKind =
	| "avatar"
	| "header"
	| "cover"
	| "gallery"
	| "inline-image"
	| "badge"
	/** The direct route's catch-all bucket, for a `mediaType` it does not recognize. */
	| "upload";

/** Which object a row names, for the operator and for the restore. */
export type QuarantineObjectKind = WorkObjectKind | ChromeObjectKind;

export interface QuarantineInput {
	workId: number;
	source: QuarantineSource;
	/**
	 * **Our own determination** — what Anthers concluded this is, in our vocabulary.
	 *
	 * 🚨 Never a vendor's answer. § 7.6 of the Child Safety Reporting Policy: a detection vendor's data is an input to
	 * our determination and never a substitute for it, and Shield says outright that its
	 * classifications are not final determinations of legality. Pass the vendor's answer as
	 * `vendorMatch` instead, which is kept apart for retention and for the rule that it
	 * must never reach an agent.
	 */
	classification: string;
	/** What a detection vendor returned, when one did. See the schema note before reading it. */
	vendorMatch?: VendorMatch | null;
	/** The operator who acted, or null when a job did. */
	/** The admin account acting, or null when a scan did. */
	adminId?: number | null;
	/** The report that triggered this, when one did. */
	reportId?: number | null;
	note?: string;
}

export interface QuarantineResult {
	/** How many objects were moved out of reach. Zero is legitimate — see below. */
	objectsMoved: number;
	/**
	 * Objects already out of reach before this call: under an earlier finding, or left parked by
	 * an earlier quarantine that failed before writing one, which this call then writes. Counted
	 * apart from `objectsMissing`, because "already parked" and "not in storage at all" send an
	 * operator in different directions.
	 */
	objectsAlreadyParked: number;
	/** Objects the database named that storage did not have. Recorded, never fatal. */
	objectsMissing: number;
	holdIds: number[];
}

/** The Work a quarantine named does not exist. Nothing was moved or written. */
export class QuarantineWorkNotFoundError extends Error {
	constructor(readonly workId: number) {
		super(`No such Work: ${workId}`);
	}
}

/** How far a quarantine got before it failed. */
export type QuarantineFailureStage = "moving" | "recording" | "holding";

/**
 * A quarantine that failed partway, carrying what it had already done.
 *
 * 🚨 **The keys are the point.** A failure after some objects moved leaves them out of reach
 * with no finding naming them, and an operator told only "it failed" cannot tell whether the
 * material is still servable. `message` is written to be shown to that operator as it stands.
 */
export class QuarantinePlacementError extends Error {
	constructor(
		readonly workId: number,
		readonly stage: QuarantineFailureStage,
		/** Objects moved out of reach before the failure, whether or not a finding names them. */
		readonly movedKeys: string[],
		/** Holds placed before the failure. */
		readonly holdIds: number[],
		failure: unknown,
	) {
		// 🚨 **No `cause`, deliberately.** The failure is often a database error, whose message
		// carries the query's parameters, and on the scan path one of those is the detection
		// vendor's Match Data — which must never reach a log an agent reads, a job's stored error,
		// or an operator's screen. Its safe summary goes into the message instead.
		super(placementFailureMessage(workId, stage, movedKeys, holdIds, failure));
	}
}

/**
 * Why something failed, in a form safe to show and to log.
 *
 * 🚨 **A failed query is described by its SQLSTATE and nothing else.** Drizzle's message quotes
 * the parameters, and even Postgres's own message quotes a value for some refusals, so the code
 * is the only part guaranteed to carry none. Anything else is its first line.
 */
function safeReason(err: unknown): string {
	if (!(err instanceof Error)) return "an unknown error";
	const code = [err, err.cause]
		.map((e) => (e as { code?: unknown } | undefined)?.code)
		.find((c): c is string => typeof c === "string" && /^[0-9A-Z]{5}$/.test(c));
	if (code) return `the database refused it (SQLSTATE ${code})`;
	if (err.message.startsWith("Failed query")) return "the database refused it";
	return err.message.split("\n")[0].replace(/\.$/, "");
}

function placementFailureMessage(
	workId: number,
	stage: QuarantineFailureStage,
	movedKeys: string[],
	holdIds: number[],
	failure: unknown,
): string {
	const detail = ` The error was: ${safeReason(failure)}.`;
	if (stage === "holding") {
		return (
			`Work ${workId} is quarantined and its finding is recorded, but placing its preservation ` +
			`holds failed after ${holdIds.length} ${holdIds.length === 1 ? "hold" : "holds"}. ` +
			`Quarantine it again to place them; a second hold on a subject is harmless.${detail}`
		);
	}
	const during = stage === "moving" ? "while moving its objects" : "while writing its finding";
	if (movedKeys.length === 0) {
		return `Quarantining Work ${workId} failed ${during}, before any object was moved, so nothing changed.${detail}`;
	}
	return (
		`Quarantining Work ${workId} failed ${during}. ${movedKeys.length} ` +
		`${movedKeys.length === 1 ? "object was" : "objects were"} already moved out of reach and ` +
		`no finding names ${movedKeys.length === 1 ? "it" : "them"} yet: ${movedKeys.join(", ")}. ` +
		`${movedKeys.length === 1 ? "It stays" : "They stay"} out of reach. Quarantine the Work again ` +
		`to record ${movedKeys.length === 1 ? "it" : "them"} and move anything left behind.${detail}`
	);
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
	kind: WorkObjectKind;
}

/**
 * Every object of a Work's that could be delivered.
 *
 * ⚠️ **HLS renditions and processed audio are included even though they are derived**,
 * which is the opposite of the rule the child-safety coverage map, which is deliberately not public states for *scanning* — there, a transform of
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
	const add = (raw: string | null, kind: WorkObjectKind) => {
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
 * caller is an operator acting during an incident, and Child Safety Incident Runbook Step 2 is explicit that a
 * report is never delayed for want of tooling — so the button has to be safe to press
 * twice.
 *
 * 🚨 **Storage moves happen BEFORE the transaction, and the ordering is the design.** A
 * commit followed by a failed move leaves the database saying the material is out of
 * reach while it is still servable, which is the one lie this module cannot tell. Moving
 * first means the failure mode is an object already parked with no row explaining it —
 * unreachable, and recorded by the next quarantine of the same Work, which finds it parked
 * with no open finding and writes the finding it is owed.
 *
 * ⚠️ **A failure partway throws {@link QuarantinePlacementError}, naming what had moved.**
 * A missing Work throws {@link QuarantineWorkNotFoundError} before anything happens. Those two
 * are the only things this throws, so a caller can tell an operator which one they are in.
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
	if (!work) throw new QuarantineWorkNotFoundError(input.workId);

	/** Every object this call will write a finding for: moved now, or parked by a failed run. */
	const moved: (WorkObject & { quarantineKey: string })[] = [];
	let objectsMoved = 0;
	let objectsAlreadyParked = 0;
	let objectsMissing = 0;

	try {
		const [objects, openRows] = await Promise.all([
			objectsFor(input.workId),
			db
				.select({ originalKey: mediaQuarantine.originalKey })
				.from(mediaQuarantine)
				.where(and(eq(mediaQuarantine.workId, input.workId), isNull(mediaQuarantine.clearedAt))),
		]);
		const recorded = new Set(openRows.map((r) => r.originalKey));

		for (const object of objects) {
			const quarantineKey = quarantineKeyFor(object.key);
			if (await storage.move(object.key, quarantineKey)) {
				moved.push({ ...object, quarantineKey });
				objectsMoved++;
			} else if (await storage.exists(quarantineKey)) {
				// Already parked. Under an open finding that is an earlier quarantine's work; under
				// none it is an earlier quarantine that failed after moving it, and this is the
				// retry that owes it a finding.
				objectsAlreadyParked++;
				if (!recorded.has(object.key)) moved.push({ ...object, quarantineKey });
			} else {
				objectsMissing++;
			}
		}
	} catch (err) {
		throw new QuarantinePlacementError(input.workId, "moving", keysOf(moved), [], err);
	}

	// Only the first quarantine records what the creator had chosen. A second pass on an
	// already-delisted Work would otherwise overwrite `released` with `private` and lose
	// the way back.
	const priorVisibility =
		work.quarantineStatus === "quarantined" ? "" : (work.visibility ?? "private");

	try {
		await recordWorkQuarantine(input, work, moved, priorVisibility);
	} catch (err) {
		throw new QuarantinePlacementError(input.workId, "recording", keysOf(moved), [], err);
	}

	// 🚨 Placed AFTER the state is written, and never skipped. Everything quarantined is
	// under a preservation hold — quarantining without one moves material somewhere a
	// sweep can still reach, which is worse than leaving it where it was, because nothing
	// is watching the quarantine prefix.
	const expiresAt = preservationExpiry();
	const reason = `Quarantine of Work ${input.workId} (${input.source}), § 2258A(h) preservation`;
	const subjects: { subjectType: "work" | "user" | "report"; subjectId: number }[] = [
		{ subjectType: "work", subjectId: input.workId },
	];
	if (work.creatorId != null) subjects.push({ subjectType: "user", subjectId: work.creatorId });
	if (input.reportId != null) subjects.push({ subjectType: "report", subjectId: input.reportId });

	const holdIds: number[] = [];
	try {
		for (const subject of subjects) {
			holdIds.push(
				(await placeHold({ ...subject, reason, placedBy: input.adminId ?? null, expiresAt }))
					.holdId,
			);
		}
	} catch (err) {
		throw new QuarantinePlacementError(input.workId, "holding", keysOf(moved), holdIds, err);
	}

	return { objectsMoved, objectsAlreadyParked, objectsMissing, holdIds };
}

function keysOf(objects: { key: string }[]): string[] {
	return objects.map((o) => o.key);
}

/**
 * Delist the Work and write its findings, its log entry and everything that follows from them,
 * in one transaction.
 */
async function recordWorkQuarantine(
	input: QuarantineInput,
	work: { creatorId: number | null },
	moved: (WorkObject & { quarantineKey: string })[],
	priorVisibility: string,
): Promise<void> {
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
		// 🚨 The most urgent delete there is. A record carries the title and a URL onto a public
		// network with no way to un-publish; for quarantined material a listing is the finding
		// itself travelling further.
		void queueWorkListingSync(input.workId);

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
					placedBy: input.adminId ?? null,
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
			adminActorId: input.adminId ?? null,
			actorRole: input.adminId == null ? "automated" : "operator",
			reason: "quarantine",
			// Our determination only. A vendor's classification is Match Data and must not be
			// copied into the append-only log, which is permanent and read by agents.
			note: [input.source, input.classification, input.note].filter(Boolean).join(": "),
		});

		// Anthers removed this, so the Stickers on it and on its comments stop paying its creator
		// and go back to time-based distribution, in any cycle that has not settled.
		await voidStickersOnSubject("work", input.workId, tx);

		// Acting on the material answers any open report about it. Left open, the queue
		// would keep re-serving work that is done.
		await tx
			.update(moderationReports)
			.set({
				status: "resolved",
				resolvedAt: new Date(),
				resolvedByAdminId: input.adminId ?? null,
			})
			.where(
				and(
					eq(moderationReports.subjectType, "work"),
					eq(moderationReports.subjectId, input.workId),
					eq(moderationReports.status, "open"),
				),
			);
	});
}

export interface QuarantineObjectInput {
	/** The stored object to take out of reach. */
	storageKey: string;
	/** Who uploaded it. Null only where the uploader genuinely cannot be established. */
	uploaderId: number | null;
	/**
	 * Which kind of object this is, in the upload route's own vocabulary.
	 *
	 * ⚠️ **A `WorkObjectKind` is legitimate here and is not a mistake.** A thumbnail
	 * uploaded through `media-upload/direct` genuinely has no Work behind it yet — the key
	 * is minted before the Work row exists — so what selects this door is the *absence of a
	 * Work*, never the vocabulary the kind is drawn from.
	 */
	objectKind: QuarantineObjectKind;
	source: QuarantineSource;
	/** **Our own determination.** Never a vendor's — see {@link QuarantineInput}. */
	classification: string;
	vendorMatch?: VendorMatch | null;
	/** The admin account acting, or null when a scan did. */
	adminId?: number | null;
	reportId?: number | null;
	note?: string;
}

export interface QuarantineObjectResult {
	/** 1 when the object was moved, 0 when storage did not have it or it was already parked. */
	objectsMoved: number;
	/** The `media_quarantine` row, or null when this key already had an open finding. */
	findingId: number | null;
	holdIds: number[];
}

/**
 * Take a **Work-less** object out of reach and preserve it — badge art, an avatar, a
 * header, a cover, a gallery shot, an inline post image.
 *
 * 🚨 **This exists because § 2258A attaches on actual knowledge however that knowledge
 * arrives, and a scan we ran and recorded is knowledge.** Until this door existed, the same
 * person uploading the same bytes got a preserved finding if they attached them to a Work
 * and silence if they used them as a badge — the outcome turned on where the file was
 * going rather than on what it was.
 *
 * ⚠️ **It writes no `moderationActions` row, and that is the one place it diverges from
 * {@link quarantineWork}.** The log row exists there so an operator reading a *Work's*
 * history sees the quarantine beside the hides and the takedowns; a Work-less object has no
 * such history, and the only durable subject left is the uploader. Writing `user` there
 * would be worse than writing nothing: `loadModerationQueue` attaches the latest action to
 * a queue item by `(subject_type, subject_id)`, so a reported *person* would render as
 * hidden with reason `quarantine` when nothing whatever happened to their account — and
 * suspending a person is precisely the decision the wiki's *Moderation & Reporting* records as not taken. The
 * `media_quarantine` row is the record, and `GET /api/admin/quarantine` is where it surfaces.
 *
 * **Idempotent on the key**, on the same reasoning `quarantineWork` states: the realistic
 * caller is an operator during an incident, and the button has to be safe to press twice.
 *
 * 🚨 **The storage move happens BEFORE the row is written**, the same ordering and for the
 * same reason: a committed row and a failed move is the database claiming material is out
 * of reach while it is still servable, which is the one lie this module cannot tell.
 */
export async function quarantineObject(
	input: QuarantineObjectInput,
): Promise<QuarantineObjectResult> {
	const [existing] = await db
		.select({ id: mediaQuarantine.id })
		.from(mediaQuarantine)
		.where(
			and(eq(mediaQuarantine.originalKey, input.storageKey), isNull(mediaQuarantine.clearedAt)),
		)
		.limit(1);

	const quarantineKey = quarantineKeyFor(input.storageKey);
	const moved = await storage.move(input.storageKey, quarantineKey);

	// A second call on a key already under an open finding re-parks whatever is still in
	// place — a re-upload to the same key, say — and adds no second row.
	if (existing) return { objectsMoved: moved ? 1 : 0, findingId: existing.id, holdIds: [] };

	const [row] = await db
		.insert(mediaQuarantine)
		.values({
			// 🚨 Null on purpose, and the column has always allowed it. A finding about an
			// avatar is not a finding about a Work, and inventing one to hang it from would
			// put a Work into `quarantine_status` that no creator can see or clear.
			workId: null,
			uploaderId: input.uploaderId,
			originalKey: input.storageKey,
			quarantineKey,
			objectKind: input.objectKind,
			source: input.source,
			classification: input.classification,
			vendorMatch: input.vendorMatch ?? null,
			reportId: input.reportId ?? null,
			// There is no visibility to restore: the object is not a Work and was never
			// published on its own. Empty, which is what `clearQuarantine` already reads as
			// "nothing was recorded here".
			priorVisibility: "",
			placedBy: input.adminId ?? null,
			note: input.note ?? "",
		})
		.returning({ id: mediaQuarantine.id });

	// 🚨 Placed after the record and never skipped, exactly as for a Work: material parked
	// in the quarantine prefix with no hold is material a sweep can still reach, and
	// nothing watches that prefix.
	const expiresAt = preservationExpiry();
	const reason = `Quarantine of ${input.objectKind} ${input.storageKey} (${input.source}), § 2258A(h) preservation`;
	const holdIds: number[] = [];
	if (input.uploaderId != null) {
		holdIds.push(
			(
				await placeHold({
					subjectType: "user",
					subjectId: input.uploaderId,
					reason,
					placedBy: input.adminId ?? null,
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
					placedBy: input.adminId ?? null,
					expiresAt,
				})
			).holdId,
		);
	}

	return { objectsMoved: moved ? 1 : 0, findingId: row.id, holdIds };
}

/**
 * Put one Work-less object back, for a finding that turned out to be wrong.
 *
 * **The preservation hold is deliberately not lifted**, on the same reasoning
 * {@link clearQuarantine} gives: *the finding was wrong* and *the obligation to preserve
 * has ended* are different decisions taken by different people against different clocks.
 *
 * ⚠️ **Restoring the object does not restore whatever referenced it.** A badge upload is
 * refused before `creator_gates.art_key` is written, so there is nothing pointing at the
 * key to repair; an avatar refused the same way never reached the profile row either. The
 * object comes back where it was and the uploader re-uploads. Anything that would need a
 * row repaired belongs to a Work, and a Work goes through `clearQuarantine`.
 */
export async function clearObjectQuarantine(input: {
	findingId: number;
	/** The admin account acting. */
	adminId: number;
	note?: string;
}): Promise<{ cleared: boolean; objectsRestored: number; storageKey: string }> {
	const [row] = await db
		.select({
			id: mediaQuarantine.id,
			workId: mediaQuarantine.workId,
			originalKey: mediaQuarantine.originalKey,
			quarantineKey: mediaQuarantine.quarantineKey,
		})
		.from(mediaQuarantine)
		.where(and(eq(mediaQuarantine.id, input.findingId), isNull(mediaQuarantine.clearedAt)))
		.limit(1);
	// A finding that names a Work is `clearQuarantine`'s to close, because clearing it has
	// to restore the Work's visibility too. Refusing here rather than half-clearing it is
	// what keeps the two paths from leaving different state.
	if (!row || row.workId != null) return { cleared: false, objectsRestored: 0, storageKey: "" };

	const restored = (await storage.move(row.quarantineKey, originalKeyFor(row.quarantineKey)))
		? 1
		: 0;

	await db
		.update(mediaQuarantine)
		// The clearing note beside the placement note, never over it: for an object with no Work,
		// `note` is the only record of why the finding was placed.
		.set({ clearedAt: new Date(), clearedBy: input.adminId, clearedNote: input.note ?? "" })
		.where(eq(mediaQuarantine.id, row.id));

	// 🚨 **`cleared` and `objectsRestored` are two different facts and the caller needs
	// both.** A finding id that matches nothing clears nothing, and a finding whose object
	// storage no longer holds clears the row and restores nothing — telling those apart is
	// the same lesson the legal-hold console learned, where every integer was a valid
	// subject and a hold on a typo was indistinguishable from one that worked. The key is
	// returned so the operator is shown *what* they cleared rather than a tick.
	return { cleared: true, objectsRestored: restored, storageKey: row.originalKey };
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
	/** The admin account acting. */
	adminId: number;
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

		// Cleared, so whatever the Work's state now says should be listed, is.
		void queueWorkListingSync(input.workId);

		await tx
			.update(mediaQuarantine)
			.set({ clearedAt: new Date(), clearedBy: input.adminId, clearedNote: input.note ?? "" })
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
			adminActorId: input.adminId,
			actorRole: "operator",
			reason: "",
			note: ["quarantine cleared", input.note].filter(Boolean).join(": "),
		});

		// Through `tx`, which is the only place the Work already reads as cleared. A takedown that
		// still stands keeps its Stickers voided.
		await restoreStickersOnSubject("work", input.workId, tx);
	});

	return { objectsRestored: restored, visibility: prior };
}

/** What the console renders for one finding. Keys and metadata — never the material. */
export interface QuarantineFinding {
	id: number;
	workId: number | null;
	workTitle: string;
	uploaderId: number | null;
	/** The uploader's handle, or null when the account is gone. */
	uploaderName: string | null;
	originalKey: string;
	objectKind: string;
	source: string;
	classification: string;
	reportId: number | null;
	placedAt: string;
	/** The admin account that quarantined it, or null when a scan did. */
	placedBy: string | null;
	clearedAt: string | null;
	clearedBy: string | null;
	/** Why it was placed. */
	note: string;
	/** Why it was cleared, or empty while it is open. */
	clearedNote: string;
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
 * must not be. § 5.2 of the Child Safety Reporting Policy commits Anthers to an operator surface that shows the
 * finding and never the material — so adding one would be a policy amendment rather than
 * a feature. The keys are here because a key is what a CyberTipline report cites.
 */
export async function loadQuarantineFindings(
	opts: { includeCleared?: boolean; limit?: number } = {},
): Promise<QuarantineFinding[]> {
	const placer = alias(adminAccounts, "placer");
	const clearer = alias(adminAccounts, "clearer");
	const rows = await db
		.select({
			id: mediaQuarantine.id,
			workId: mediaQuarantine.workId,
			workTitle: works.title,
			uploaderId: mediaQuarantine.uploaderId,
			uploaderName: users.username,
			originalKey: mediaQuarantine.originalKey,
			objectKind: mediaQuarantine.objectKind,
			source: mediaQuarantine.source,
			classification: mediaQuarantine.classification,
			reportId: mediaQuarantine.reportId,
			placedAt: mediaQuarantine.placedAt,
			placedBy: placer.displayName,
			clearedAt: mediaQuarantine.clearedAt,
			clearedBy: clearer.displayName,
			note: mediaQuarantine.note,
			clearedNote: mediaQuarantine.clearedNote,
		})
		.from(mediaQuarantine)
		.leftJoin(works, eq(mediaQuarantine.workId, works.id))
		.leftJoin(users, eq(mediaQuarantine.uploaderId, users.id))
		.leftJoin(placer, eq(mediaQuarantine.placedBy, placer.id))
		.leftJoin(clearer, eq(mediaQuarantine.clearedBy, clearer.id))
		.where(opts.includeCleared ? undefined : isNull(mediaQuarantine.clearedAt))
		.orderBy(desc(mediaQuarantine.placedAt))
		.limit(opts.limit ?? 200);

	return rows.map((r) => ({
		id: r.id,
		workId: r.workId,
		workTitle: r.workTitle ?? "",
		uploaderId: r.uploaderId,
		uploaderName: r.uploaderName,
		originalKey: r.originalKey,
		objectKind: r.objectKind,
		source: r.source,
		classification: r.classification,
		reportId: r.reportId,
		placedAt: r.placedAt.toISOString(),
		placedBy: r.placedBy,
		clearedAt: r.clearedAt?.toISOString() ?? null,
		clearedBy: r.clearedBy,
		note: r.note,
		clearedNote: r.clearedNote,
	}));
}

/**
 * How many findings are open. For the console's headline row.
 *
 * ⚠️ **`works` counts Works and a Work-less finding is not one.** Badge art, avatars and
 * covers belong to no Work and carry `work_id = null`, so folding those rows in would
 * collapse every one of them into a single phantom Work and report a count that is wrong in
 * both directions at once. They are counted as `objects` instead, which is the number an
 * operator actually needs: `openFindings` is rows, and the two subject counts say what
 * those rows are about.
 */
export async function quarantineSummary(): Promise<{
	openFindings: number;
	works: number;
	objects: number;
}> {
	const rows = await db
		.select({ workId: mediaQuarantine.workId })
		.from(mediaQuarantine)
		.where(isNull(mediaQuarantine.clearedAt));
	const workIds = rows.map((r) => r.workId).filter((id): id is number => id != null);
	return {
		openFindings: rows.length,
		works: new Set(workIds).size,
		objects: rows.length - workIds.length,
	};
}
