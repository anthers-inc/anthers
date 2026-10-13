// SPDX-License-Identifier: Apache-2.0
/**
 * Taking a thumbnail from the video's paused moment — on the server.
 *
 * The route answers the Studio's *Use This Frame*: the creator pauses their video somewhere
 * and the client sends that moment (`atSeconds`), and the server extracts one JPEG from the
 * stored original and stores it exactly as an uploaded thumbnail would be — the creator's
 * thumbnails prefix, the public chrome ACL, its own scan. The suite exercises REAL ffmpeg
 * against a real file in the session's storage, because the claims under test are the
 * extraction's: the stored thumbnail is byte-for-byte what a direct extraction of the asked
 * moment produces (not frame zero, which is what the degraded browser path used to hand
 * back); a moment past the end is clamped inside the file; and the scan is owed, because the
 * result is new image bytes on the Work even though they derive from a cleaned source.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { mediaScans, works } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { ffmpegCommand } from "../lib/ffmpeg";
import { storage } from "../services/storage";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const creatorName = `framethumb_${id}`;

let cookie = "";
let otherCookie = "";
let creatorId = 0;
const workIds: number[] = [];
let sent: Array<{ name: string; data: Record<string, unknown> }> = [];
let sendSpy: ReturnType<typeof spyOn>;

function callWith(whoCookie: string, method: string, path: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: whoCookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}
const call = (method: string, path: string, body?: unknown) => callWith(cookie, method, path, body);

/** A synthetic video with a changing picture — the fixture the scan suites use. */
async function makeVideo(seconds: number): Promise<Buffer> {
	const path = join(tmpdir(), `ft_${crypto.randomUUID()}.mp4`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc=duration=${seconds}:size=320x180:rate=10`,
			"-pix_fmt",
			"yuv420p",
			path,
			"-y",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(await proc.exited).toBe(0);
	const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
	await rm(path).catch(() => {});
	return bytes;
}

/** One frame of a stored source at a moment, by the route's own construction — the
 *  reference extraction the stored thumbnail is compared against byte for byte. */
async function referenceFrame(key: string, atSeconds: string): Promise<Buffer> {
	const input = await storage.readableInput(key);
	const proc = Bun.spawn(
		ffmpegCommand(
			input,
			["-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
			["-v", "error", "-ss", atSeconds],
		),
		{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
	);
	const bytes = Buffer.from(await new Response(proc.stdout).arrayBuffer());
	await proc.exited;
	return bytes;
}

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE email = ${`${creatorName}@example.com`}`);
	const account = await createAccount(creatorName);
	cookie = account.cookie;
	creatorId = account.userId as number;
	const other = await createAccount(`framethumbOther_${id}`);
	otherCookie = other.cookie;
	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	await db.delete(mediaScans).where(sql`${mediaScans.storageKey} LIKE ${`%framethumb-${id}-%`}`);
	// The storage objects themselves need no sweep: this suite's session owns its content
	// directory and the next session starts empty.
});

/** Create a video Work and give it a real file, the way the Upload page's land does. */
async function videoWorkWithFile(seconds: number): Promise<number> {
	const res = await call("POST", "/api/content/works", { type: "video", title: `Frame ${id}` });
	expect(res.status).toBe(201);
	const { work } = (await res.json()) as { work: { id: number } };
	workIds.push(work.id);
	const sourceKey = `creators/${creatorId}/videos/originals/framethumb-${id}.mp4`;
	await storage.upload(sourceKey, await makeVideo(seconds), "video/mp4");
	const attach = await call("PATCH", `/api/content/works/${work.id}`, { sourceKey });
	expect(attach.status).toBe(200);
	return work.id;
}

describe("POST /works/:id/thumbnail-frame", () => {
	it("refuses a Work that is not its creator's, existence unchanged", async () => {
		const workId = await videoWorkWithFile(3);
		const res = await callWith(
			otherCookie,
			"POST",
			`/api/content/works/${workId}/thumbnail-frame`,
			{ atSeconds: 1 },
		);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Work not found");
	});

	it("refuses a non-video Work", async () => {
		const res = await call("POST", "/api/content/works", { type: "image", title: `not v ${id}` });
		const { work } = (await res.json()) as { work: { id: number } };
		workIds.push(work.id);
		const refused = await call("POST", `/api/content/works/${work.id}/thumbnail-frame`, {
			atSeconds: 1,
		});
		expect(refused.status).toBe(400);
		expect((await refused.json()).code).toBe("thumbnail_frame_not_video");
	});

	it("refuses a video with no file yet", async () => {
		const res = await call("POST", "/api/content/works", { type: "video", title: `empty ${id}` });
		const { work } = (await res.json()) as { work: { id: number } };
		workIds.push(work.id);
		const refused = await call("POST", `/api/content/works/${work.id}/thumbnail-frame`, {
			atSeconds: 1,
		});
		expect(refused.status).toBe(409);
		expect((await refused.json()).code).toBe("thumbnail_frame_no_media");
	});

	it("extracts the frame at the asked moment, stores it as the thumbnail, and owes its scan", async () => {
		sent = [];
		const workId = await videoWorkWithFile(5);
		const sourceKey = `creators/${creatorId}/videos/originals/framethumb-${id}.mp4`;
		const res = await call("POST", `/api/content/works/${workId}/thumbnail-frame`, {
			atSeconds: 4.2,
		});
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as { work: { thumbnail: string } };

		// Stored as the creator's own thumbnails object for this Work, addressable by URL.
		expect(work.thumbnail).toContain(`/thumbnails/${workId}/`);
		expect(work.thumbnail).toMatch(/^https?:\/\//);
		// Served bytes equal the reference extraction of the same moment — the honest
		// version of "the frame AT the moment". The test session's own content storage is
		// where the bytes are, but its URL is the test base's, so read through the
		// interface rather than fetching the URL.
		const servedBytes = await storage.read(work.thumbnail.replace(/^.*\/content\//, ""));
		expect(servedBytes).not.toBeNull();
		expect(
			Buffer.from(servedBytes as Uint8Array).equals(await referenceFrame(sourceKey, "4.2")),
		).toBe(true);

		// The extraction is new image bytes on the Work, so its scan is owed.
		expect(sent.map((s) => s.name)).toContain(QUEUES.SCAN_MEDIA);
		expect(
			sent
				.filter((s) => s.name === QUEUES.SCAN_MEDIA)
				.some((s) => String(s.data.storageKey).includes(String(workId))),
		).toBe(true);

		// The row is what the client was told, and it is settled: a repeat take is the
		// creator's overwrite, not a race.
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.thumbnail).toBe(work.thumbnail);
	});

	it("clamps a moment past the end to the file's own duration", async () => {
		const workId = await videoWorkWithFile(5);
		const res = await call("POST", `/api/content/works/${workId}/thumbnail-frame`, {
			atSeconds: 9999,
		});
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as { work: { thumbnail: string } };
		expect(work.thumbnail).toContain(`/thumbnails/${workId}/`);
	});
});
