// SPDX-License-Identifier: Apache-2.0
/**
 * A Work exists before its file does, and release waits for the file.
 *
 * The Studio creates a Work the moment its file is picked and uploads into it while the creator
 * fills in the rest (Parker, 2026-09-16), so a video with no `sourceKey` is an ordinary state
 * rather than a malformed one. What makes that safe is the refusal this suite is about:
 * `unreadyWorks` reads only transcoding jobs, and a Work whose file never arrived has none, so
 * without `media_missing` it would read as ready and release as a page with nothing on it.
 *
 * ⚠️ **`queue.send` is replaced for the duration.** Attaching a file enqueues a transcode and a
 * scan, pg-boss is not running under the test runner, and what is under test is that the route
 * asks for them rather than that a worker answers.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { mediaScans, transcodingJobs, workPages, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { CREATED_CREDIT } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const creatorName = `filearr_${id}`;
/**
 * Every key this suite writes carries the run id, so teardown can find its own, and sits under
 * the creator's own prefix, because the routes refuse a file another account uploaded.
 */
const KEY = (name: string) => `creators/${creatorId}/media/filearr-${id}-${name}`;

let cookie = "";
let creatorId = 0;
const workIds: number[] = [];
let sent: Array<{ name: string; data: Record<string, unknown> }> = [];
let sendSpy: ReturnType<typeof spyOn>;

function call(method: string, path: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** Create a Work the way the Upload page does: a type and a title, and no file yet. */
async function createWithoutFile(type: string): Promise<number> {
	const res = await call("POST", "/api/content/works", { type, title: `File arrival ${id}` });
	expect(res.status).toBe(201);
	const { work } = await res.json();
	workIds.push(work.id);
	return work.id;
}

function release(workId: number) {
	return call("PATCH", `/api/content/works/${workId}`, {
		visibility: "released",
		maturityRows: rowsRatedAs("general"),
		// A human in the credits, so `credits_creator_required` is not the refusal under test.
		credits: CREATED_CREDIT,
	});
}

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE email = ${`${creatorName}@example.com`}`);
	const account = await createAccount(creatorName);
	cookie = account.cookie;
	creatorId = account.userId as number;
	await enablePayouts(creatorName);
	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
}, DB_SETUP_TIMEOUT);

// By id rather than by creator: the account purge sets `works.creator_id` null when it runs
// first, which would leave a creator-scoped delete finding nothing.
afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	await db.delete(mediaScans).where(sql`${mediaScans.storageKey} LIKE ${`%filearr-${id}-%`}`);
});

describe("a video Work whose file has not arrived", () => {
	let workId = 0;
	// Built on use, because the creator — and so the key's prefix — exists only after `beforeAll`.
	const sourceKey = () => KEY("clip.mp4");

	it("is created private and unrated, with no media work queued", async () => {
		sent = [];
		workId = await createWithoutFile("video");
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.visibility).toBe("private");
		expect(row.maturity).toBe("unrated");
		expect(row.sourceKey).toBe("");
		// The listing sync is the creator-space draft write and belongs on every creation; what
		// must not happen before a file arrives is a transcode or a scan of bytes nobody sent.
		expect(sent.filter((job) => job.name !== QUEUES.SYNC_WORK_LISTING)).toEqual([]);
	});

	it("cannot be released, and keeps the rating declared in the same request", async () => {
		const res = await release(workId);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("media_missing");
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.visibility).toBe("private");
		expect(row.maturity).toBe("general");
	});

	it("queues processing and a scan when the file arrives", async () => {
		sent = [];
		const res = await call("PATCH", `/api/content/works/${workId}`, { sourceKey: sourceKey() });
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.sourceKey).toBe(sourceKey());
		expect(work.transcoding?.status).toBe("pending");
		expect(sent.map((s) => s.name)).toContain(QUEUES.TRANSCODE_VIDEO);
		expect(sent.filter((s) => s.name === QUEUES.SCAN_MEDIA).map((s) => s.data)).toEqual([
			{ storageKey: sourceKey(), workId, kind: "video" },
		]);
	});

	it("then waits on processing rather than on the file", async () => {
		const res = await release(workId);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("media_not_ready");
	});

	it("does not ask for a thumbnail once processing has finished", async () => {
		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100 })
			.where(eq(transcodingJobs.workId, workId));
		// Nothing took one on the creator's behalf, and release no longer asks for one: a Work
		// with no thumbnail shows its kind's poster instead (Parker, 2026-10-24). What is still
		// owed is the scan of the video's own bytes.
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.thumbnail ?? "").toBe("");
		const res = await release(workId);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("scan_pending");
	});

	it("releases once the scans have answered", async () => {
		await db.insert(mediaScans).values({
			storageKey: sourceKey(),
			workId,
			determination: "clean",
			scannedAt: new Date(),
		});
		const res = await release(workId);
		expect(res.status).toBe(200);
		expect((await res.json()).work.visibility).toBe("released");
	});
});

/**
 * `music` and `comic` reach the pipelines of `audio` and `ebook` through `processingFor`, so a type
 * that fell out of it would upload a file nothing ever processes, and would then release without
 * waiting for it.
 */
describe("each kind with a file is processed by its medium's pipeline", () => {
	// Each medium's pipeline names its own lane; the assert that matters is that the
	// SEND happened into a queue whose handler routes the row by mediaType, rather than
	// into a queue nothing works.
	for (const [type, mediaType, queueName] of [
		["music", "audio", QUEUES.PROCESS_AUDIO],
		["audio", "audio", QUEUES.PROCESS_AUDIO],
		["comic", "ebook", QUEUES.RENDER_PAGED],
		["ebook", "ebook", QUEUES.RENDER_PAGED],
	] as const) {
		it(`sends a ${type} Work's file to ${queueName}, and waits for it before release`, async () => {
			const workId = await createWithoutFile(type);
			sent = [];
			const res = await call("PATCH", `/api/content/works/${workId}`, {
				sourceKey: KEY(`${type}-source`),
			});
			expect(res.status).toBe(200);
			const [job] = await db
				.select()
				.from(transcodingJobs)
				.where(eq(transcodingJobs.workId, workId));
			expect(job?.mediaType).toBe(mediaType);
			expect(sent.find((s) => s.name === queueName)?.data).toEqual({ jobId: job?.id });

			const refused = await release(workId);
			expect(refused.status).toBe(409);
			expect((await refused.json()).code).toBe("media_not_ready");
		});
	}
});

describe("the kinds with no file to wait for", () => {
	it("releases a game that has no file at all", async () => {
		const workId = await createWithoutFile("game");
		const res = await release(workId);
		expect(res.status).toBe(200);
	});
});

/**
 * Panel guidance is additive, never a precondition: a comic's pages are a complete Work
 * the moment they render. Detection proposes regions on every page, and none of that is a
 * confirmation the creator owes — so a processed comic whose pages carry only proposals,
 * with guided view off, releases like any other Work.
 */
describe("a comic's pages do not wait on panel work", () => {
	it("releases a processed comic whose pages carry only unconfirmed proposals", async () => {
		const workId = await createWithoutFile("comic");
		sent = [];
		expect(
			(await call("PATCH", `/api/content/works/${workId}`, { sourceKey: KEY("no-panels.png") }))
				.status,
		).toBe(200);
		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100 })
			.where(eq(transcodingJobs.workId, workId));
		const [page] = await db
			.insert(workPages)
			.values({
				workId,
				pageNumber: 1,
				file: KEY("no-panels-page-0001.jpg"),
				width: 100,
				height: 150,
			})
			.returning({ id: workPages.id, guidedView: workPages.guidedView });
		// Exactly what `render-paged` writes: proposals marked `auto`, with the page's
		// opt-in left off.
		expect(page?.guidedView).toBe(false);
		await db
			.update(workPages)
			.set({
				panels: [
					{ panelNumber: 1, x: 0, y: 0, width: 1, height: 0.5, auto: true },
					{ panelNumber: 2, x: 0, y: 0.5, width: 1, height: 0.5, auto: true },
				],
			})
			.where(eq(workPages.id, page?.id as number));

		const res = await release(workId);
		expect(res.status).toBe(200);
		expect((await res.json()).work.visibility).toBe("released");
	});
});

/**
 * An image is its own thumbnail and takes no other (Parker, 2026-09-18): the Work and its
 * thumbnail are the same picture, so the Work's rating decides how both are shown.
 */
describe("an image, which is its own thumbnail", () => {
	it("becomes its thumbnail when its file arrives, and again when the file is replaced", async () => {
		const workId = await createWithoutFile("image");
		const first = KEY("picture.png");
		expect((await call("PATCH", `/api/content/works/${workId}`, { sourceKey: first })).status).toBe(
			200,
		);
		expect((await db.select().from(works).where(eq(works.id, workId)))[0].thumbnail).toBe(first);

		const second = KEY("replacement.png");
		expect(
			(await call("PATCH", `/api/content/works/${workId}`, { sourceKey: second })).status,
		).toBe(200);
		expect((await db.select().from(works).where(eq(works.id, workId)))[0].thumbnail).toBe(second);
	});

	it("refuses another thumbnail, on create and afterwards, and stores nothing", async () => {
		const created = await call("POST", "/api/content/works", {
			type: "image",
			title: `File arrival ${id}`,
			thumbnail: KEY("other-on-create.png"),
		});
		expect(created.status).toBe(400);
		expect((await created.json()).code).toBe("image_is_its_thumbnail");

		const workId = await createWithoutFile("image");
		const res = await call("PATCH", `/api/content/works/${workId}`, {
			thumbnail: KEY("other.png"),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("image_is_its_thumbnail");
		expect((await db.select().from(works).where(eq(works.id, workId)))[0].thumbnail ?? "").toBe("");
	});
});

describe("a piece of writing, which is its body the way a video is its file", () => {
	it("cannot be released while it is empty, and says so as the creator's to fix", async () => {
		const workId = await createWithoutFile("text");
		const res = await release(workId);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("text_missing");
		// Markup with no words in it is still nothing to read.
		const blank = await call("PATCH", `/api/content/works/${workId}`, {
			bodyHtml: "<p> </p><p>&nbsp;</p>",
			visibility: "released",
			maturityRows: rowsRatedAs("general"),
		});
		expect((await blank.json()).code).toBe("text_missing");
	});

	it("releases when it is written and released in the same save", async () => {
		// The Edit page sends the body and the release together, so the release has to be asked
		// about the body this request writes rather than the empty one it found.
		const workId = await createWithoutFile("text");
		const res = await call("PATCH", `/api/content/works/${workId}`, {
			bodyHtml: "<p>The first hard frost came early this year.</p>",
			body: "The first hard frost came early this year.",
			visibility: "released",
			maturityRows: rowsRatedAs("general"),
			credits: CREATED_CREDIT,
		});
		expect(res.status).toBe(200);
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.visibility).toBe("released");
		expect(row.estimatedReadMinutes).toBeGreaterThan(0);
	});

	it("cannot be scheduled while it is empty, since nothing will fill it on its own", async () => {
		const workId = await createWithoutFile("text");
		const res = await call("PATCH", `/api/content/works/${workId}`, {
			maturityRows: rowsRatedAs("general"),
			scheduledReleaseAt: new Date(Date.now() + 86_400_000).toISOString(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("text_missing");
	});
});
