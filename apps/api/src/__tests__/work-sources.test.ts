// SPDX-License-Identifier: Apache-2.0
/**
 * A paged Work's source set — the multi-PDF ruling's routes and their invariants
 * (Parker, 2026-10-10: one PDF or several, each file's pages a contiguous run in the
 * creator's arrangement) — and, in its second describe, the image kind's set (2026-10-18),
 * whose rows are the gallery the Work displays.
 *
 * The properties under test, one spec each:
 * - **The legacy attach syncs**: a `source_key` PATCH on a comic — the shape the Upload
 *   form's first upload uses — becomes the set's one row, so the table is the row-level
 *   truth for the paged kinds and no Work can carry both a column and a set in disagreement.
 * - **The set mutates as rows**: append at the end (dense positions, the legacy column
 *   following the newest file), remove with renumber, reorder as a whole list. Every
 *   mutation enqueues exactly one more rasterize.
 * - **A foreign file is refused**, the storage-ownership rule (`isOwnStorageRef`) applied
 *   like the assets route applies it — a set row signs its key for the Work's owner, so a
 *   row naming another creator's private original would hand it over.
 * - **A released Work's set is closed** — the pages its readers hold came from it, and
 *   mutating under them makes the release gate's answer a lie.
 * - **A stale order is refused wholesale**, because a partial renumber is the one way the
 *   dense-position invariant can be broken by a valid request.
 *
 * ⚠️ Storage objects: the local-storage test session holds real files where the suite
 * writes them, so removal's sweep is exercised for real (see `deletion-sweeps-storage.test.ts`
 * for the pattern) rather than mocked into a promise of a sweep.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { storage } from "../services/storage";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

let creator = { id: 0, cookie: "" };
let other = { id: 0, cookie: "" };
const workIds: number[] = [];
let sendSpy: ReturnType<typeof spyOn>;

/** An owned key the local storage can actually sign: it exists after `putKey` writes it. */
async function putKey(creatorId: number, name: string): Promise<string> {
	const key = `creators/${creatorId}/assets/${name}.pdf`;
	await storage.upload(
		key,
		Buffer.from("%PDF-1.4\ntrailer << /Root 1 0 R >>\n%%EOF\n"),
		"application/pdf",
		"private",
	);
	return key;
}

/** A file under ANOTHER creator's prefix — the foreign-refusal rail's bait. */
function foreignKey(creatorId: number, otherId: number): string {
	return `creators/${otherId}/assets/not-your-${creatorId}.pdf`;
}

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

interface SetRow {
	id: number;
	position: number;
	file: string;
	filename: string;
	fileSize: number | null;
}

async function readSet(id: number): Promise<SetRow[]> {
	const res = await call("GET", `/api/content/works/${id}/source-files`, creator.cookie);
	expect(res.status).toBe(200);
	const { files } = (await res.json()) as { files: SetRow[] };
	return files;
}

beforeAll(async () => {
	for (const [name, set] of [
		[`sources_creator_${run}`, (v: typeof creator) => (creator = v)],
		[`sources_other_${run}`, (v: typeof other) => (other = v)],
	] as const) {
		const account = await createAccount(name);
		set({ id: account.userId as number, cookie: account.cookie });
	}
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
});

describe("a paged Work's source set", () => {
	it("syncs a legacy source_key attach into the set's one row", async () => {
		const key = await putKey(creator.id, "legacy-first");
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: "",
		});
		workIds.push(work.id);

		const res = await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, {
			sourceKey: key,
		});
		expect(res.status).toBe(200);

		const files = await readSet(work.id);
		expect(files).toHaveLength(1);
		expect(files[0].position).toBe(0);
		expect(files[0].file).toBe(key);
	});

	it("appends at the end with dense positions and follows the legacy column", async () => {
		const first = await putKey(creator.id, "first");
		const second = await putKey(creator.id, "second");
		const third = await putKey(creator.id, "third");
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: first,
		});
		workIds.push(work.id);
		await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, { sourceKey: first });

		const add = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: second,
			filename: "second.pdf",
			fileSize: 123,
		});
		expect(add.status).toBe(201);
		const added = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: third,
			filename: "third.pdf",
		});
		expect(added.status).toBe(201);

		const files = await readSet(work.id);
		expect(files.map((f) => f.position)).toEqual([0, 1, 2]);
		expect(files.map((f) => f.filename)).toEqual([expect.any(String), "second.pdf", "third.pdf"]);
		// The legacy column follows the set's newest file, so the old readers never read
		// a paged Work's column as empty while its set stands.
		const [row] = await db
			.select({ sourceKey: works.sourceKey })
			.from(works)
			.where(eq(works.id, work.id));
		expect(row.sourceKey).toBe(third);

		// Size round-trips: a per-page file's bytes are the account's catalog total.
		expect(files[1].fileSize).toBe(123);

		// Exactly one re-render per mutation: the legacy sync was one, each append one.
		const rasterizeCalls = (sendSpy.mock.calls as Array<[unknown, unknown]>).filter(
			([q]) => q === QUEUES.RENDER_PAGED,
		).length;
		expect(rasterizeCalls).toBe(3);
	});

	it("removes with a renumber and sweeps the file's object", async () => {
		const one = await putKey(creator.id, "rem-one");
		const two = await putKey(creator.id, "rem-two");
		const three = await putKey(creator.id, "rem-three");
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: one,
		});
		workIds.push(work.id);
		await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, { file: two });
		const added = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: three,
		});
		const { files: afterAdd } = (await added.json()) as { files: SetRow[] };
		expect(afterAdd).toHaveLength(3);

		const res = await call(
			"DELETE",
			`/api/content/works/${work.id}/source-files/${afterAdd[1].id}`,
			creator.cookie,
		);
		expect(res.status).toBe(200);
		const files = await readSet(work.id);
		expect(files.map((f) => f.position)).toEqual([0, 1]);
		expect(files.map((f) => f.file)).toEqual([one, three]);
		// The removed file's object is gone from storage, not merely from the list.
		expect(await storage.exists(afterAdd[1].file)).toBe(false);
	});

	it("reorders as a whole list", async () => {
		const one = await putKey(creator.id, "ord-one");
		const two = await putKey(creator.id, "ord-two");
		const three = await putKey(creator.id, "ord-three");
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: one,
		});
		workIds.push(work.id);
		await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, { file: two });
		const { files: rows } = (await (
			await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
				file: three,
			})
		).json()) as { files: SetRow[] };

		const res = await call("PATCH", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			order: [rows[2].id, rows[0].id, rows[1].id],
		});
		expect(res.status).toBe(200);
		const files = await readSet(work.id);
		expect(files.map((f) => f.position)).toEqual([0, 1, 2]);
		expect(files.map((f) => f.file)).toEqual([three, one, two]);
	});

	it("refuses a stale order wholesale", async () => {
		const one = await putKey(creator.id, "stale-one");
		const two = await putKey(creator.id, "stale-two");
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: one,
		});
		workIds.push(work.id);
		const added = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: two,
		});
		const { files: rows } = (await added.json()) as { files: SetRow[] };
		expect(rows).toHaveLength(2);

		// An order naming an id the set no longer holds — the client raced a removal.
		const res = await call("PATCH", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			order: [424242, rows[1].id],
		});
		expect(res.status).toBe(400);
		// And nothing was written: the set stands exactly as the removal-racing client left it.
		const files = await readSet(work.id);
		expect(files.map((f) => f.position)).toEqual([0, 1]);
	});

	it("refuses a file under another creator's prefix", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: await putKey(creator.id, "foreign-guard"),
		});
		workIds.push(work.id);
		const res = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: foreignKey(creator.id, other.id),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string; error?: string };
		// The storage-ownership refusal's own words, as the assets route states it.
		expect(body.code).toBe("foreign_file");
		expect(body.error).toContain("one of your uploads");
	});

	it("refuses the set on a released Work and on a Work of a kind that is not set-bearing", async () => {
		const released = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "released",
			sourceKey: await putKey(creator.id, "released-set"),
		});
		workIds.push(released.id);
		const releasedRes = await call(
			"POST",
			`/api/content/works/${released.id}/source-files`,
			creator.cookie,
			{ file: await putKey(creator.id, "released-add") },
		);
		expect(releasedRes.status).toBe(409);
		expect(((await releasedRes.json()) as { code?: string }).code).toBe("sources_not_private");

		const video = await insertWork({
			creatorId: creator.id,
			type: "video",
			visibility: "private",
			sourceKey: await putKey(creator.id, "video-set"),
		});
		workIds.push(video.id);
		const videoRes = await call(
			"POST",
			`/api/content/works/${video.id}/source-files`,
			creator.cookie,
			{
				file: await putKey(creator.id, "video-add"),
			},
		);
		expect(videoRes.status).toBe(400);
		expect(((await videoRes.json()) as { error?: string }).error).toContain("set of files");
	});

	it("refuses the set for a work that is not yours, with a 404", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: await putKey(creator.id, "private-set"),
		});
		workIds.push(work.id);
		const res = await call("POST", `/api/content/works/${work.id}/source-files`, other.cookie, {
			file: foreignKey(other.id, other.id),
		});
		expect(res.status).toBe(404);
	});
});

/**
 * The image kind's set (2026-10-18): the gallery the Work displays. The mutation invariants
 * are the routes' own; what this describe pins is what makes the image family DIFFERENT —
 * the legacy column follows the set's FIRST file rather than its newest, because for an
 * image Work the column IS the cover (the thumbnail, the listing image, the release gate's
 * media presence), and the set admits only images.
 */
describe("an image Work's set", () => {
	/** A display URL the local storage can actually sign, matching what a direct upload returns. */
	async function putImage(creatorId: number, name: string): Promise<string> {
		const key = `creators/${creatorId}/gallery/${name}.png`;
		await storage.upload(key, Buffer.from("fake image bytes"), "image/png", "public");
		return storage.getUrl(key);
	}

	/** A PDF under the owner's own prefix — the image-only guard's bait. */
	async function putPdf(creatorId: number, name: string): Promise<string> {
		const key = `creators/${creatorId}/assets/${name}.pdf`;
		await storage.upload(
			key,
			Buffer.from("%PDF-1.4\ntrailer << /Root 1 0 R >>\n%%EOF\n"),
			"application/pdf",
			"private",
		);
		return key;
	}

	async function sourceKeyOf(id: number): Promise<string> {
		const [row] = await db.select({ v: works.sourceKey }).from(works).where(eq(works.id, id));
		return row.v ?? "";
	}

	it("syncs a legacy source_key attach into the set's one row, column first", async () => {
		const work = await insertWork({ creatorId: creator.id, type: "image", visibility: "private" });
		workIds.push(work.id);
		const cover = await putImage(creator.id, "sync-cover");

		const res = await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, {
			sourceKey: cover,
		});
		expect(res.status).toBe(200);

		const files = await readSet(work.id);
		expect(files).toHaveLength(1);
		expect(files[0].position).toBe(0);
		// The row stores the display URL the image kind has always stored, not a bare key.
		expect(files[0].file).toBe(cover);
		expect(await sourceKeyOf(work.id)).toBe(cover);
	});

	it("appends at the end and leaves the column on the FIRST image", async () => {
		const cover = await putImage(creator.id, "append-cover");
		const second = await putImage(creator.id, "append-second");
		const work = await insertWork({ creatorId: creator.id, type: "image", visibility: "private" });
		workIds.push(work.id);
		await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, { sourceKey: cover });

		const res = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: second,
			filename: "second.png",
			fileSize: 123,
			mimeType: "image/png",
		});
		expect(res.status).toBe(201);

		const files = await readSet(work.id);
		expect(files.map((f) => f.position)).toEqual([0, 1]);
		expect(files.map((f) => f.file)).toEqual([cover, second]);
		// 🚨 The load-bearing difference from the paged kinds: the column IS the cover.
		expect(await sourceKeyOf(work.id)).toBe(cover);
	});

	it("refuses a file that is not an image, and writes nothing", async () => {
		const cover = await putImage(creator.id, "guard-cover");
		const pdf = await putPdf(creator.id, "guard-not-image");
		const work = await insertWork({ creatorId: creator.id, type: "image", visibility: "private" });
		workIds.push(work.id);
		await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, { sourceKey: cover });

		const res = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: pdf,
			filename: "not-a-picture.pdf",
			mimeType: "application/pdf",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("sources_not_images");
		// The refusal leaves the set exactly as it was: one row, cover in the column.
		const files = await readSet(work.id);
		expect(files.map((f) => f.file)).toEqual([cover]);
		expect(await sourceKeyOf(work.id)).toBe(cover);
	});

	it("reorders, and the cover follows the image that arrives first", async () => {
		const one = await putImage(creator.id, "order-one");
		const two = await putImage(creator.id, "order-two");
		const work = await insertWork({ creatorId: creator.id, type: "image", visibility: "private" });
		workIds.push(work.id);
		await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, { sourceKey: one });
		await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: two,
			mimeType: "image/png",
		});
		const rows = await readSet(work.id);
		// The second image moves to the front, and the column moves with it.
		const res = await call("PATCH", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			order: [rows[1].id, rows[0].id],
		});
		expect(res.status).toBe(200);
		const files = await readSet(work.id);
		expect(files.map((f) => f.file)).toEqual([two, one]);
		expect(await sourceKeyOf(work.id)).toBe(two);
	});

	it("removes the first image and the cover follows; removing the last empties it", async () => {
		const one = await putImage(creator.id, "rm-cover");
		const two = await putImage(creator.id, "rm-second");
		const work = await insertWork({ creatorId: creator.id, type: "image", visibility: "private" });
		workIds.push(work.id);
		await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, { sourceKey: one });
		const added = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: two,
			mimeType: "image/png",
		});
		const { files: rows } = (await added.json()) as { files: Array<{ id: number; file: string }> };

		// Removing the FIRST image moves the cover to the set's new first — not to the
		// newest, and not to nothing.
		await call(
			"DELETE",
			`/api/content/works/${work.id}/source-files/${rows.find((r) => r.file === one)!.id}`,
			creator.cookie,
		);
		expect(await sourceKeyOf(work.id)).toBe(two);
		expect(await storage.exists(one)).toBe(false);

		// Removing the last image leaves the Work with no media again, column included.
		const files = await readSet(work.id);
		await call(
			"DELETE",
			`/api/content/works/${work.id}/source-files/${files[0].id}`,
			creator.cookie,
		);
		expect(await sourceKeyOf(work.id)).toBe("");
	});

	it("refuses the set on a released image Work", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "image",
			visibility: "released",
			sourceKey: await putImage(creator.id, "released-gal"),
		});
		workIds.push(work.id);
		const res = await call("POST", `/api/content/works/${work.id}/source-files`, creator.cookie, {
			file: await putImage(creator.id, "released-gal-add"),
			mimeType: "image/png",
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code?: string }).code).toBe("sources_not_private");
	});
});
