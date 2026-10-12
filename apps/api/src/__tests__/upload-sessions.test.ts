// SPDX-License-Identifier: Apache-2.0
/**
 * The multipart upload session, service level — the plan, the completion gate, and the
 * sweeper's grace.
 *
 * ⚠️ **The backend is spied, deliberately.** The session service's contract is what a
 * COMPLETION must prove before assembly is requested — coverage exact, every part
 * carrying the ETag its own upload answered — and an in-memory stand-in expresses that
 * contract better than live storage would, in a suite with no process boundary. The
 * storage layer's own multipart legs (command shapes, ETag plumbing) are the S3
 * implementation's business; the flow here is the rules that make a completion mean
 * something.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { mediaUploadSessions } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type * as storageModule from "../services/storage/index.js";
import { storage } from "../services/storage/index.js";
import {
	abortUploadSession,
	completeUploadSession,
	startUploadSession,
	sweepAbandonedUploadSessions,
	UPLOAD_PART_SIZE,
} from "../services/upload-sessions.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

/** The backend the suite spies into: real multipart semantics as a tiny map. */
const heldParts = new Map<string, Map<number, string>>();
const spied = {
	uploadIds: 0,
};
type StorageSpy = {
	create: ReturnType<typeof spyOn>;
	partUrl: ReturnType<typeof spyOn>;
	listParts: ReturnType<typeof spyOn>;
	complete: ReturnType<typeof spyOn>;
	abort: ReturnType<typeof spyOn>;
};

let spy: StorageSpy;

/** The row's key, from the outside — the stand-in keys its map by (key, uploadId). */
const keyOfUploadId = new Map<string, string>();

function installSpies(): StorageSpy {
	const s = storage as unknown as storageModule.StorageService;
	const spiedObject = {
		create: spyOn(s, "createMultipartUpload").mockImplementation(async (key: string) => {
			spied.uploadIds += 1;
			const uploadId = `up_${spied.uploadIds}`;
			heldParts.set(uploadId, new Map());
			keyOfUploadId.set(uploadId, key);
			return { uploadId };
		}),
		partUrl: spyOn(s, "getPresignedPartUrl").mockImplementation(
			async (key: string, uploadId: string, partNumber: number) =>
				`https://storage.test/part?key=${key}&n=${partNumber}&id=${uploadId}`,
		),
		listParts: spyOn(s, "listMultipartParts").mockImplementation(
			async (_key: string, uploadId: string) => {
				const held = heldParts.get(uploadId) ?? new Map<number, string>();
				return [...held].map(([number, etag]) => ({ number, etag }));
			},
		),
		complete: spyOn(s, "completeMultipartUpload").mockImplementation(async () => {}),
		abort: spyOn(s, "abortMultipartUpload").mockImplementation(async () => {}),
	};
	return spiedObject as StorageSpy;
}

beforeAll(() => {
	spy = installSpies();
});
afterAll(() => {
	for (const fn of [spy?.complete, spy?.abort, spy?.listParts, spy?.partUrl, spy?.create]) {
		fn?.mockRestore();
	}
});

/** Simulate the client having PUT one part — recorded by an ETag the suite knows. */
function stagePart(uploadId: string, number: number, etag: string): void {
	heldParts.get(uploadId)?.set(number, etag);
}

async function openSession(creatorId: number, size = UPLOAD_PART_SIZE * 3) {
	const { sessionId, key } = await startUploadSession(creatorId, {
		filename: "take.mp4",
		contentType: "video/mp4",
		mediaType: "video",
		size,
	});
	const [row] = await db
		.select()
		.from(mediaUploadSessions)
		.where(eq(mediaUploadSessions.id, sessionId));
	return { sessionId, key, row };
}

describe("an upload session's plan", () => {
	let creatorId: number;
	let creatorIdB: number;

	beforeAll(async () => {
		creatorId = (await createAccount(`upsess_a_${Date.now().toString(36)}`)).userId;
		creatorIdB = (await createAccount(`upsess_b_${Date.now().toString(36)}`)).userId;
	});

	it("splits size into parts at the declared part size, in the creator's prefix", async () => {
		const { sessionId, key } = await startUploadSession(creatorId, {
			filename: "a-film.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size: UPLOAD_PART_SIZE * 2 + 1024,
		});
		expect(key).toMatch(new RegExp(`^creators/${creatorId}/videos/originals/.*\\.mp4$`));
		expect(spy.partUrl).toHaveBeenCalled();
		const [row] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, sessionId));
		expect(row.status).toBe("open");
		expect(row.partSize).toBe(UPLOAD_PART_SIZE);
		expect(row.partCount).toBe(3);
	});

	it("completes exactly the plan it named, and records the carried digest", async () => {
		const { sessionId, key, row } = await openSession(creatorId);
		const uploadId = row.uploadId;
		for (const n of [1, 2, 3]) stagePart(uploadId, n, `etag-${n}`);

		const result = await completeUploadSession(
			creatorId,
			sessionId,
			[2, 1, 3].map((number) => ({ number, etag: `etag-${number}` })),
			`sha-${"a".repeat(60)}`,
		);
		expect(result.key).toBe(key);
		expect(spy.complete).toHaveBeenCalled();

		const [after] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, sessionId));
		expect(after.status).toBe("completed");
		expect(after.clientSha256).toBe(`sha-${"a".repeat(60)}`);
		expect(after.completedAt).not.toBeNull();
	});

	it("refuses a part carrying an ETag its upload never answered", async () => {
		const { sessionId, row } = await openSession(creatorId);
		for (const n of [1, 2, 3]) stagePart(row.uploadId, n, `etag-${n}`);
		await expect(
			completeUploadSession(creatorId, sessionId, [
				{ number: 1, etag: "etag-1" },
				{ number: 2, etag: "something-else" },
				{ number: 3, etag: "etag-3" },
			]),
		).rejects.toMatchObject({ status: 409 });
		// And the session stays open — a refused completion is not an ended one.
		const [after] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, sessionId));
		expect(after.status).toBe("open");
	});

	it("refuses a plan that misses a part — a hole is not a video", async () => {
		const { sessionId, row } = await openSession(creatorId);
		for (const n of [1, 2, 3]) stagePart(row.uploadId, n, `etag-${n}`);
		await expect(
			completeUploadSession(creatorId, sessionId, [
				{ number: 1, etag: "etag-1" },
				{ number: 3, etag: "etag-3" },
			]),
		).rejects.toMatchObject({ status: 409 });
	});

	it("an unknown session is a 404 that says nothing else", async () => {
		await expect(
			completeUploadSession(creatorId, crypto.randomUUID(), [{ number: 1, etag: "e" }]),
		).rejects.toMatchObject({ status: 404 });
	});

	it("another creator's session is just as unknown", async () => {
		const { sessionId, row } = await openSession(creatorId);
		for (const n of [1, 2, 3]) stagePart(row.uploadId, n, `etag-${n}`);
		await expect(
			completeUploadSession(creatorIdB, sessionId, [
				{ number: 1, etag: "etag-1" },
				{ number: 2, etag: "etag-2" },
				{ number: 3, etag: "etag-3" },
			]),
		).rejects.toMatchObject({ status: 404 });
	});

	it("an already-completed session cannot complete again — and a creator's own abort is free", async () => {
		const { sessionId, key } = await startUploadSession(creatorId, {
			filename: "x.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size: UPLOAD_PART_SIZE,
		});
		const [row] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, sessionId));
		stagePart(row.uploadId, 1, "etag-1");
		await completeUploadSession(creatorId, sessionId, [{ number: 1, etag: "etag-1" }]);
		await expect(
			completeUploadSession(creatorId, sessionId, [{ number: 1, etag: "etag-1" }]),
		).rejects.toMatchObject({ status: 409 });

		void key;
		const second = await startUploadSession(creatorId, {
			filename: "y.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size: UPLOAD_PART_SIZE,
		});
		await abortUploadSession(creatorId, second.sessionId);
		const [aborted] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, second.sessionId));
		expect(aborted.status).toBe("aborted");
		// An abort is idempotent: a second one is a no-op, not an error.
		await abortUploadSession(creatorId, second.sessionId);
	});
});

describe("resume by digest — the byte-level leg", () => {
	const DIGEST = `sha-${"c".repeat(64)}`;
	const SIZE = UPLOAD_PART_SIZE * 2 + 1024;

	function open(creatorId: number, digest: string | null, size = SIZE) {
		return startUploadSession(creatorId, {
			filename: "take.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size,
			...(digest ? { clientSha256: digest } : {}),
		});
	}

	async function uploadIdOf(sessionId: string): Promise<string> {
		const [row] = await db.select().from(mediaUploadSessions).where(eq(mediaUploadSessions.id, sessionId));
		return row.uploadId;
	}

	it("a start naming an open session's digest hands back that session, its held parts named", async () => {
		const resumeCreator = (await createAccount(`upsess_res_${Date.now().toString(36)}`)).userId;
		const first = await open(resumeCreator, DIGEST);
		// The relaunch PUT part 1 before dying; the digest is all the retry knows.
		stagePart(await uploadIdOf(first.sessionId), 1, "etag-1");

		const resumed = await open(resumeCreator, DIGEST);
		expect(resumed.sessionId).toBe(first.sessionId);
		expect(resumed.held).toEqual([1]);
		expect(resumed.key).toBe(first.key);
		// The plan is the resumed session's own — part count and fresh addresses —
		// re-asked rather than carried (a stale list's life is a day).
		expect(resumed.parts).toHaveLength(3);
	});

	it("a digest with no open session of its own starts a fresh one — even completed, aborted, or another creator's", async () => {
		const c1 = (await createAccount(`upsess_re2_${Date.now().toString(36)}`)).userId;
		const c2 = (await createAccount(`upsess_re3_${Date.now().toString(36)}`)).userId;
		const settled = await open(c1, DIGEST, UPLOAD_PART_SIZE);
		stagePart(await uploadIdOf(settled.sessionId), 1, "etag-1");
		await completeUploadSession(c1, settled.sessionId, [{ number: 1, etag: "etag-1" }], DIGEST);

		const fresh = await open(c1, DIGEST);
		expect(fresh.sessionId).not.toBe(settled.sessionId);
		expect(fresh.held).toEqual([]);
		expect(fresh.key).not.toBe(settled.key);

		// A foreign creator naming c1's digest starts their own session, and their keys
		// never meet: the resume lookup is the creator's own rows, and so is the key.
		const foreign = await open(c2, DIGEST);
		expect(foreign.sessionId).not.toBe(settled.sessionId);
		expect(foreign.key).toMatch(new RegExp(`^creators/${c2}/`));
	});

	it("a digest whose session's plan cannot hold the named size starts fresh rather than hijacking parts", async () => {
		const shrinkCreator = (await createAccount(`upsess_re4_${Date.now().toString(36)}`)).userId;
		const kept = await open(shrinkCreator, DIGEST);
		// Three parts' window will not take a file four parts would call its own.
		const tooBig = await open(shrinkCreator, DIGEST, UPLOAD_PART_SIZE * 4);
		expect(tooBig.held).toEqual([]);
		expect(tooBig.sessionId).not.toBe(kept.sessionId);
	});

	it("a completion naming a digest other than the one the session was opened with is refused, and the session stays open", async () => {
		const mismatchCreator = (await createAccount(`upsess_re5_${Date.now().toString(36)}`)).userId;
		const session = await open(mismatchCreator, DIGEST, UPLOAD_PART_SIZE);
		stagePart(await uploadIdOf(session.sessionId), 1, "etag-1");
		await expect(
			completeUploadSession(mismatchCreator, session.sessionId, [{ number: 1, etag: "etag-1" }], `sha-${"d".repeat(64)}`),
		).rejects.toMatchObject({ status: 409 });
		const [row] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, session.sessionId));
		expect(row.status).toBe("open");

		// The session's own digest completes it, and the row carries it (already set —
		// the same value, confirmed rather than changed).
		await completeUploadSession(mismatchCreator, session.sessionId, [{ number: 1, etag: "etag-1" }], DIGEST);
		const [after] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, session.sessionId));
		expect(after.status).toBe("completed");
		expect(after.clientSha256).toBe(DIGEST);
	});
});

describe("the abandonment sweeper", () => {
	let sweepCreatorId: number;

	it("aborts sessions open past the grace, and only those", async () => {
		// Spies are already standing (installed at file scope); the sweeper's creator
		// is its own so the plan's rows never read ambiguous.
		sweepCreatorId = (await createAccount(`upsess_s_${Date.now().toString(36)}`)).userId;
		// old + open → swept; new + open → kept; old + completed → kept.
		const old = await startUploadSession(sweepCreatorId, {
			filename: "old.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size: UPLOAD_PART_SIZE,
		});
		await db
			.update(mediaUploadSessions)
			.set({ createdAt: new Date(Date.now() - 4 * 86_400_000) })
			.where(eq(mediaUploadSessions.id, old.sessionId));

		const fresh = await startUploadSession(sweepCreatorId, {
			filename: "fresh.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size: UPLOAD_PART_SIZE,
		});
		const completed = await startUploadSession(sweepCreatorId, {
			filename: "done.mp4",
			contentType: "video/mp4",
			mediaType: "video",
			size: UPLOAD_PART_SIZE,
		});
		const [doneRow] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, completed.sessionId));
		stagePart(doneRow.uploadId, 1, "etag-1");
		await completeUploadSession(sweepCreatorId, completed.sessionId, [
			{ number: 1, etag: "etag-1" },
		]);

		const swept = await sweepAbandonedUploadSessions();
		expect(swept).toBeGreaterThanOrEqual(1);

		const [oldRow] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, old.sessionId));
		expect(oldRow.status).toBe("aborted");
		const [freshRow] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, fresh.sessionId));
		expect(freshRow.status).toBe("open");
		const [doneAfter] = await db
			.select()
			.from(mediaUploadSessions)
			.where(eq(mediaUploadSessions.id, completed.sessionId));
		expect(doneAfter.status).toBe("completed");
	});
});
