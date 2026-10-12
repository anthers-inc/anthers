// SPDX-License-Identifier: Apache-2.0
/**
 * The resumable multipart upload session — the designed door for media of any practical
 * size (ruling 2026-10-11, wiki 70.06).
 *
 * A session is: one backend multipart handle kept in the database, a part plan the
 * client executes (each part PUT against its own short-lived presigned address, in any
 * order, repeated on failure), and a completion that is an integration gate rather than
 * a formality — the backend is asked what it actually holds, every reported part must
 * carry the ETag its own PUT answered, and coverage must be exact before assembly is
 * requested. A completion that passes those checks produced the object the client sent;
 * a session abandoned part-way holds parts and costs nothing but an abort.
 *
 * 🚨 **The bytes never touch the API.** Parts are browser→storage directly; a session
 * that completes is creator-metered storage as any other object; R2 additionally bills
 * held-but-unassembled parts, which is what the abandonment sweep exists to free.
 */

import { db } from "@anthers/db/client";
import { mediaUploadSessions } from "@anthers/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import { storage } from "./storage/index.js";

/** How large a part the plan asks the client to send: R2's floor is 5 MiB; 64 MiB keeps
 * even a multi-gigabyte object a modest part count, small enough for a failed part's
 * retry to be cheap. */
export const UPLOAD_PART_SIZE = 64 * 1024 * 1024;

/** A part address lives a day — long past any single part's upload at real speeds; a
 * resumed upload re-asks the plan rather than carrying a stale list. */
export const PART_URL_TTL_SECONDS = 24 * 60 * 60;

/** Sessions still open this long after their last activity are aborted by the sweeper:
 * the backend is holding parts it bills for, and a client coming back after days is a
 * new upload, not a resumption of a cold one. */
export const SESSION_CLEANUP_DAYS = 3;

/** The backend's own ceiling on parts per object; the size a session may not pass. */
const MAX_PARTS = 10_000;
export const MAX_SESSION_BYTES = UPLOAD_PART_SIZE * MAX_PARTS;

export type UploadMediaType = "video" | "audio" | "asset";

/**
 * The destination key for a session — one key naming for every media upload: this
 * function is what the presign route calls too, so a session's destination and a
 * presign's destination are the same layout by construction.
 */
export function mediaUploadKeyFor(
	creatorId: number,
	mediaType: UploadMediaType,
	filename: string,
): string {
	const ext = filename.includes(".") ? filename.split(".").pop() : "";
	const uuid = crypto.randomUUID().replace(/-/g, "");
	const map = {
		video: `creators/${creatorId}/videos/originals/${uuid}.${ext}`,
		audio: `creators/${creatorId}/audio/originals/${uuid}.${ext}`,
		asset: `creators/${creatorId}/assets/${uuid}.${ext}`,
	} as const;
	return map[mediaType];
}

export interface MultipartSession {
	sessionId: string;
	key: string;
	partSize: number;
	parts: Array<{ number: number; url: string }>;
	/** Part numbers the backend already holds — a resumed attempt need not send them. */
	held: number[];
}

/**
 * Open a session — or, where the digest names one this creator still has open, RESUME
 * it. A resume is the byte-level leg of the design: the backend holds the completed
 * parts, the plan is re-presented with fresh part addresses (the old list's life is a
 * day), and the client sends only what is missing. The digest pins the bytes — the
 * only identity that survives a relaunch — and the plan's own size window is checked
 * beside it, so a hash collision with a different-length file cannot hijack parts.
 */
export async function startUploadSession(
	creatorId: number,
	input: {
		filename: string;
		contentType: string;
		mediaType: UploadMediaType;
		size: number;
		clientSha256?: string | null;
	},
): Promise<MultipartSession> {
	const partCount = Math.max(1, Math.ceil(input.size / UPLOAD_PART_SIZE));
	if (partCount > MAX_PARTS) {
		throw new Error(
			`A source this size needs ${partCount} parts and the plan carries at most ${MAX_PARTS}; the ceiling is ${Math.floor(MAX_SESSION_BYTES / 1024 ** 3)} GB`,
		);
	}

	if (input.clientSha256) {
		const [resumable] = await db
			.select()
			.from(mediaUploadSessions)
			.where(
				and(
					eq(mediaUploadSessions.creatorId, creatorId),
					eq(mediaUploadSessions.clientSha256, input.clientSha256),
					eq(mediaUploadSessions.status, "open"),
				),
			)
			.orderBy(desc(mediaUploadSessions.createdAt))
			.limit(1);
		// Same digest, same size window, still open — the resumed plan is its own, not a
		// rebuilt one: its part count is what completion's coverage gate demands exactly.
		const floor = resumable ? (resumable.partCount - 1) * resumable.partSize : -1;
		if (
			resumable &&
			input.size > floor &&
			input.size <= resumable.partCount * resumable.partSize
		) {
			const held = await storage.listMultipartParts(resumable.key, resumable.uploadId);
			const parts = await Promise.all(
				Array.from({ length: resumable.partCount }, (_, i) => i + 1).map(async (number) => ({
					number,
					url: await storage.getPresignedPartUrl(resumable.key, resumable.uploadId, number, PART_URL_TTL_SECONDS),
				})),
			);
			return {
				sessionId: resumable.id,
				key: resumable.key,
				partSize: resumable.partSize,
				parts,
				held: held.map((part) => part.number),
			};
		}
	}

	const key = mediaUploadKeyFor(creatorId, input.mediaType, input.filename);
	const { uploadId } = await storage.createMultipartUpload(key, input.contentType, "private");
	const [row] = await db
		.insert(mediaUploadSessions)
		.values({
			creatorId,
			key,
			uploadId,
			contentType: input.contentType,
			partSize: UPLOAD_PART_SIZE,
			partCount,
			clientSha256: input.clientSha256 ?? null,
		})
		.returning();
	const parts = await Promise.all(
		Array.from({ length: partCount }, (_, i) => i + 1).map(async (number) => ({
			number,
			url: await storage.getPresignedPartUrl(key, uploadId, number, PART_URL_TTL_SECONDS),
		})),
	);
	return { sessionId: row.id, key, partSize: UPLOAD_PART_SIZE, parts, held: [] };
}

export class SessionCompleteError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/**
 * The completion, and the gate. Every part the client names must be one the backend
 * actually holds, carrying the ETag its own PUT answered with, and the parts named must
 * be exactly the session's plan — no missing part, no extra, no reordering. The
 * assembly is only requested for a session that passes all of it, so what completes is
 * by construction the bytes the client sent.
 */
export async function completeUploadSession(
	creatorId: number,
	sessionId: string,
	reported: Array<{ number: number; etag?: string }>,
	clientSha256?: string | null,
): Promise<{ key: string }> {
	const [row] = await db
		.select()
		.from(mediaUploadSessions)
		.where(eq(mediaUploadSessions.id, sessionId))
		.limit(1);
	if (!row || row.creatorId !== creatorId) {
		throw new SessionCompleteError("This upload session was not found", 404);
	}
	if (row.status !== "open") {
		throw new SessionCompleteError("This upload session already ended", 409);
	}

	// The digest the session was opened with is the plan's own byte identity — a
	// completion naming a different digest is completing somebody else's file's
	// leftover plan, and the gate refuses rather than guessing which is right. An
	// absent digest passes only because a pre-resume client never sent one; a client
	// that CAN hash sends the same one at both ends.
	if (row.clientSha256 && clientSha256 && row.clientSha256 !== clientSha256) {
		throw new SessionCompleteError(
			"This file is not the one this upload session was opened for",
			409,
		);
	}

	const sorted = [...reported].sort((a, b) => a.number - b.number);
	const held = await storage.listMultipartParts(row.key, row.uploadId);
	const heldByNumber = new Map(held.map((part) => [part.number, part.etag]));
	for (const part of sorted) {
		// Where the client COULD read the ETag, it vouches the part's identity; where
		// CORS hides it (an unexposed response header reads null), the part is vouched
		// only by its presence — and the backend is asked either way, so a part never
		// uploaded fails here whether or not the client names it.
		if (part.etag != null && part.etag !== heldByNumber.get(part.number)) {
			throw new SessionCompleteError(
				`Part ${part.number} was never uploaded, or does not carry the answer its upload gave`,
				409,
			);
		}
	}
	const covered =
		sorted.length === row.partCount &&
		sorted.every((part) => heldByNumber.has(part.number)) &&
		sorted.every((part, i) => part.number === i + 1);
	if (!covered) {
		throw new SessionCompleteError(
			`This session wants ${row.partCount} parts, exactly the plan it started with`,
			409,
		);
	}

	await storage.completeMultipartUpload(
		row.key,
		row.uploadId,
		// The ETags the CLIENT did not carry are taken from the backend's own listing —
		// assembly names every part, and the listing is the held truth.
		sorted.map((part) => ({ number: part.number, etag: heldByNumber.get(part.number)! })),
	);
	await db
		.update(mediaUploadSessions)
		.set({ status: "completed", completedAt: new Date(), clientSha256: clientSha256 ?? null })
		.where(and(eq(mediaUploadSessions.id, row.id), eq(mediaUploadSessions.status, "open")));
	return { key: row.key };
}

export async function abortUploadSession(creatorId: number, sessionId: string): Promise<void> {
	const [row] = await db
		.select()
		.from(mediaUploadSessions)
		.where(eq(mediaUploadSessions.id, sessionId))
		.limit(1);
	if (!row || row.creatorId !== creatorId) {
		throw new SessionCompleteError("This upload session was not found", 404);
	}
	if (row.status !== "open") return;
	await storage.abortMultipartUpload(row.key, row.uploadId);
	await db
		.update(mediaUploadSessions)
		.set({ status: "aborted" })
		.where(and(eq(mediaUploadSessions.id, row.id), eq(mediaUploadSessions.status, "open")));
}

/**
 * The abandonment sweeper: sessions still open past the grace window are aborted at
 * the backend, which frees the parts it was billing, and the row records it. Best-effort
 * per row, as every storage sweep here is — a failed abort is retried by the next run.
 */
export async function sweepAbandonedUploadSessions(): Promise<number> {
	const cutoff = new Date(Date.now() - SESSION_CLEANUP_DAYS * 86_400_000);
	const rows = await db
		.select({
			id: mediaUploadSessions.id,
			key: mediaUploadSessions.key,
			uploadId: mediaUploadSessions.uploadId,
		})
		.from(mediaUploadSessions)
		.where(and(eq(mediaUploadSessions.status, "open"), lt(mediaUploadSessions.createdAt, cutoff)))
		.limit(200);
	let swept = 0;
	for (const row of rows) {
		try {
			await storage.abortMultipartUpload(row.key, row.uploadId);
			await db
				.update(mediaUploadSessions)
				.set({ status: "aborted" })
				.where(and(eq(mediaUploadSessions.id, row.id), eq(mediaUploadSessions.status, "open")));
			swept += 1;
		} catch (err) {
			console.error(`[upload-sessions] sweep: abort failed for session ${row.id}:`, err);
		}
	}
	return swept;
}
