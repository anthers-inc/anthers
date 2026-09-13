// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeping a creator's post and project records in step with the rows they describe.
 *
 * `atproto-record-plan.ts` decides what should happen and carries it out against any
 * repository; this module connects that to an actual row, an actual creator, and the column
 * that remembers where the record went. It is the only writer of `posts.atproto_uri` and
 * `projects.atproto_uri`.
 *
 * 🚨 **It re-reads the row rather than being told what changed, and that is the design.**
 * Publishability turns on state several services write — a post is published, unpublished,
 * scheduled, or its creator's account is erased — and a version taking "what happened" as an
 * argument would need every one of those call sites to describe its transition correctly and
 * for ever. Reading current state makes every call idempotent: running it twice is harmless,
 * running it late still converges, and a caller firing it for the wrong reason costs nothing.
 * **The enqueue is a hint that something moved, never a description of what.** The same
 * reasoning, and the same wording, as `work-listing.ts`.
 *
 * 🚨 **A record that outlives the thing it describes is the failure this is shaped around.**
 * A record is public the moment it lands, and deleting it afterwards broadcasts only the
 * deletion — so the delete path matters more than the create path. A post that stops being
 * published must have its record REMOVED rather than merely skipped.
 */
import { db } from "@anthers/db";
import { posts, projects } from "@anthers/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type {
	PostRecord,
	ProjectRecord,
	UnpublishableCreatorReason,
} from "./atproto-creator-records.js";
import {
	POST_COLLECTION,
	POST_KIND,
	PROJECT_COLLECTION,
	PROJECT_KIND,
	type RecordPlan,
	syncRecord,
} from "./atproto-record-plan.js";
import { RepoAuthError, type RepoWriter, rkeyFromAtUri } from "./atproto-repo.js";
import { type NoCreatorWriterReason, writerForCreator } from "./repo-writer.js";

/** What syncing one creator record did. */
export type CreatorRecordSyncResult<R> =
	/** The record was created, replaced, deleted, or correctly left alone. */
	| { status: "synced"; plan: RecordPlan<R, UnpublishableCreatorReason>; uri: string | null }
	/** No record is possible or needed, for a reason that is nobody's fault. */
	| { status: "skipped"; reason: NoCreatorWriterReason | "no_row" | "no_creator" }
	/** Something worth retrying went wrong. The job wrapper decides what to do about it. */
	| { status: "failed"; error: string };

/**
 * Bring one post's record into line with the post.
 *
 * ⚠️ **The row is read inside this call rather than passed in**, for the reason in the module
 * note: a stale snapshot is exactly how an unpublished post keeps its record.
 */
export async function syncPostRecord(
	postId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<CreatorRecordSyncResult<PostRecord>> {
	const [post] = await db
		.select({
			creatorId: posts.creatorId,
			slug: posts.slug,
			publicId: posts.publicId,
			// Both, and the mapper needs both: a retracted post keeps its `published_at`.
			isPublished: posts.isPublished,
			publishedAt: posts.publishedAt,
			atprotoUri: posts.atprotoUri,
		})
		.from(posts)
		.where(eq(posts.id, postId))
		.limit(1);
	if (!post) return { status: "skipped", reason: "no_row" };
	if (post.creatorId === null) return { status: "skipped", reason: "no_creator" };

	const writer = await writerForCreator(post.creatorId, opts);
	if (!writer.writer) return { status: "skipped", reason: writer.reason };

	try {
		const outcome = await syncRecord(writer.writer, POST_KIND, post, post.atprotoUri);
		if (outcome.uri !== post.atprotoUri) {
			await db.update(posts).set({ atprotoUri: outcome.uri }).where(eq(posts.id, postId));
		}
		return { status: "synced", plan: outcome.plan, uri: outcome.uri };
	} catch (error) {
		return { status: "failed", error: describe(error) };
	}
}

/** Bring one project's record into line with the project. */
export async function syncProjectRecord(
	projectId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<CreatorRecordSyncResult<ProjectRecord>> {
	const [project] = await db
		.select({
			creatorId: projects.creatorId,
			slug: projects.slug,
			title: projects.title,
			description: projects.description,
			isPublished: projects.isPublished,
			atprotoUri: projects.atprotoUri,
		})
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!project) return { status: "skipped", reason: "no_row" };
	if (project.creatorId === null) return { status: "skipped", reason: "no_creator" };

	const writer = await writerForCreator(project.creatorId, opts);
	if (!writer.writer) return { status: "skipped", reason: writer.reason };

	try {
		const outcome = await syncRecord(writer.writer, PROJECT_KIND, project, project.atprotoUri);
		if (outcome.uri !== project.atprotoUri) {
			await db.update(projects).set({ atprotoUri: outcome.uri }).where(eq(projects.id, projectId));
		}
		return { status: "synced", plan: outcome.plan, uri: outcome.uri };
	} catch (error) {
		return { status: "failed", error: describe(error) };
	}
}

/** Which of a creator's two record types a sync is for. */
export type CreatorRecordKind = "post" | "project";

/** A record Anthers has written and still knows the address of. */
export interface PublishedCreatorRecord {
	kind: CreatorRecordKind;
	id: number;
	uri: string;
}

/**
 * Every post and project record Anthers knows the address of, for one creator.
 *
 * ⚠️ **Only what the columns remember.** A record written by something else, or one whose column
 * was lost, is not reachable from here — the same limit `stopPublishingFor` states about Works,
 * and for the same reason: `atproto_uri` is the entire memory of where records went.
 */
export async function publishedCreatorRecords(
	creatorId: number,
): Promise<PublishedCreatorRecord[]> {
	const [postRows, projectRows] = await Promise.all([
		db
			.select({ id: posts.id, uri: posts.atprotoUri })
			.from(posts)
			.where(and(eq(posts.creatorId, creatorId), isNotNull(posts.atprotoUri))),
		db
			.select({ id: projects.id, uri: projects.atprotoUri })
			.from(projects)
			.where(and(eq(projects.creatorId, creatorId), isNotNull(projects.atprotoUri))),
	]);
	return [
		...postRows.map((r) => ({ kind: "post" as const, id: r.id, uri: r.uri as string })),
		...projectRows.map((r) => ({ kind: "project" as const, id: r.id, uri: r.uri as string })),
	];
}

/**
 * Take one known record down and forget where it was. False when it is still up there.
 *
 * ⚠️ **The column is cleared only after the delete lands**, so a failure leaves the address
 * behind. Forgetting it would strand the record permanently; keeping it means a retry, or a
 * later sync, can still reach the thing.
 */
export async function removePublishedCreatorRecord(
	writer: RepoWriter,
	record: PublishedCreatorRecord,
): Promise<boolean> {
	const collection = record.kind === "post" ? POST_COLLECTION : PROJECT_COLLECTION;
	const rkey = rkeyFromAtUri(record.uri, collection);
	// An unreadable URI counts as still-up rather than as nothing to do: something is on the
	// network that this column was meant to be able to find.
	if (!rkey) return false;

	try {
		await writer.deleteRecord(collection, rkey);
	} catch (error) {
		console.error(
			`[creator-record] could not remove the record for ${record.kind} ${record.id}: ` +
				`${describe(error)}`,
		);
		return false;
	}

	if (record.kind === "post") {
		await db.update(posts).set({ atprotoUri: null }).where(eq(posts.id, record.id));
	} else {
		await db.update(projects).set({ atprotoUri: null }).where(eq(projects.id, record.id));
	}
	return true;
}

/**
 * Ask for a post's or a project's record to be brought back into line, soon.
 *
 * ⭐ **Call this whenever publishability MIGHT have moved, without working out whether it did.**
 * The job re-reads and decides, so a spurious enqueue costs one database read and a duplicate
 * costs nothing. Under-calling is the expensive mistake here, not over-calling — the same trade
 * `queueWorkListingSync` makes, for the same reason.
 *
 * ⚠️ **Never throws.** Every caller is in the middle of something a creator asked for, and
 * publishing a post must not fail because a queue was briefly unavailable. A missed enqueue is
 * caught by the reconciling sweep; a publish that failed because of one is a creator's afternoon.
 */
export async function queueCreatorRecordSync(kind: CreatorRecordKind, id: number): Promise<void> {
	try {
		const { queue, QUEUES, JOB_OPTIONS } = await import("../jobs/queue.js");
		await queue.send(
			QUEUES.SYNC_CREATOR_RECORD,
			{ kind, id },
			JOB_OPTIONS[QUEUES.SYNC_CREATOR_RECORD],
		);
	} catch (error) {
		console.error(
			`[creator-record] could not enqueue a sync for ${kind} ${id}: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Turn a thrown thing into something a job log can carry.
 *
 * 🚨 **A withdrawn permission is named rather than blurred into "it failed".** Every other way
 * a write can go wrong is answered by trying again; this one is answered by asking the creator
 * again, and a retry loop against a revoked grant achieves nothing except hiding the
 * revocation from the person who could fix it.
 */
function describe(error: unknown): string {
	if (error instanceof RepoAuthError) return `permission withdrawn for ${error.did}`;
	return error instanceof Error ? error.message : String(error);
}
