// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeping a creator's post and project records in step with the rows they describe.
 *
 * This module reads the rows and remembers where their records went; `record-sync.ts` does the
 * planning and writing that every kind shares. It is the only writer of `posts.atproto_uri` and
 * `projects.atproto_uri`, and it re-reads a row rather than being told what changed, for the
 * reason that module gives.
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
} from "./atproto-record-plan.js";
import { type RepoWriter, rkeyFromAtUri } from "./atproto-repo.js";
import { queueRecordSync, type RecordSyncResult, syncOwnedRecord } from "./record-sync.js";

/** What syncing one creator record did. */
export type CreatorRecordSyncResult<R> = RecordSyncResult<R, UnpublishableCreatorReason>;

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

	return syncOwnedRecord({
		ownerId: post.creatorId,
		kind: POST_KIND,
		input: post,
		existingUri: post.atprotoUri,
		storeUri: async (uri) => {
			await db.update(posts).set({ atprotoUri: uri }).where(eq(posts.id, postId));
		},
		fetchImpl: opts.fetchImpl,
	});
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

	return syncOwnedRecord({
		ownerId: project.creatorId,
		kind: PROJECT_KIND,
		input: project,
		existingUri: project.atprotoUri,
		storeUri: async (uri) => {
			await db.update(projects).set({ atprotoUri: uri }).where(eq(projects.id, projectId));
		},
		fetchImpl: opts.fetchImpl,
	});
}

/**
 * Ask for every one of a creator's posts and projects to be reconsidered.
 *
 * ⭐ **What granting permission should look like is the whole catalog appearing**, the same
 * reasoning `queueAllListingsFor` gives for Works. Each row still decides for itself, so drafts
 * cost a read and nothing else. Returns how many rows were queued, not how many records result.
 */
export async function queueAllCreatorRecordsFor(creatorId: number): Promise<number> {
	const [postRows, projectRows] = await Promise.all([
		db.select({ id: posts.id }).from(posts).where(eq(posts.creatorId, creatorId)),
		db.select({ id: projects.id }).from(projects).where(eq(projects.creatorId, creatorId)),
	]);
	for (const row of postRows) await queueRecordSync("post", row.id);
	for (const row of projectRows) await queueRecordSync("project", row.id);
	return postRows.length + projectRows.length;
}

/** Which of a creator's two record types a sync is for. */
export type CreatorRecordKind = "post" | "project";

/** The collection a creator record of this kind lives in. */
export function creatorRecordCollection(kind: CreatorRecordKind): string {
	return kind === "post" ? POST_COLLECTION : PROJECT_COLLECTION;
}

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
	const collection = creatorRecordCollection(record.kind);
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

/** Turn a thrown thing into something a job log can carry. */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
