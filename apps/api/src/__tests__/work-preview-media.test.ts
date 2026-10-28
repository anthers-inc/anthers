// SPDX-License-Identifier: Apache-2.0
/**
 * Storefront preview media — the screenshots and trailer a locked viewer sees.
 *
 * The suite's claims, one spec each:
 * - **The owner writes, the stranger cannot.** Attach appends in order, refuses a key under
 *   another account's prefix, refuses a kind the Work does not support, and stops at the cap.
 * - **The set is an ordered list.** Reorder is the whole arrangement or nothing, positions
 *   stay dense, and remove takes its object and every caption file with it.
 * - **Delivery runs the Work's reachability ladder, not its access check.** A locked viewer
 *   and a signed-out visitor get a signed redirect; a private Work's non-owner, an Adult
 *   Work's unverified viewer, a suspended creator's visitor and a preview of another Work
 *   all get the same 404. This is the one failure here with no acceptable version.
 * - **Trailer captions are the Work's caption gate on a preview's own table** — parse,
 *   replace-by-language, served to the locked viewer the trailer is for.
 * - **The coverage map stays true.** Scans name preview objects, the delete sweep takes them,
 *   and storage-usage counts them.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accountCycles,
	users,
	workPreviewCaptionTracks,
	workPreviewMedia,
	works,
} from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { runStorageUsageSweep } from "../jobs/storage-usage";
import { purgeWorkMedia } from "../services/media-purge";
import { storage } from "../services/storage";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { giveWorkAFile, insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

let creator: FixtureAccount;
let stranger: FixtureAccount;
let viewer: FixtureAccount;
let suspendedCreator: FixtureAccount;

const workIds: number[] = [];
const writtenKeys: string[] = [];
let sendSpy: ReturnType<typeof spyOn>;

const GATED: { threshold: number; allow: true; price: string }[] = [
	{ threshold: 300, allow: true, price: "3.00" },
];

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
A trailer line.

00:00:04.000 --> 00:00:05.500
Second line.
`;

async function putObject(key: string, bytes: string, mime: string): Promise<string> {
	await storage.upload(key, Buffer.from(bytes, "utf-8"), mime, "private");
	writtenKeys.push(key);
	return key;
}

async function putImage(workId: number, name: string): Promise<string> {
	return putObject(
		`creators/${creator.userId}/previews/images/${workId}/${name}`,
		`image bytes ${name}`,
		"image/png",
	);
}

async function putTrailer(name: string): Promise<string> {
	return putObject(
		`creators/${creator.userId}/previews/videos/${name}`,
		`trailer bytes ${name}`,
		"video/mp4",
	);
}

async function putPreviewVtt(previewId: number, name: string): Promise<string> {
	return putObject(
		`creators/${creator.userId}/previews/captions/${previewId}/${name}`,
		VTT,
		"text/vtt",
	);
}

function call(method: string, path: string, cookie?: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		}),
	);
}

interface PreviewJson {
	previewMedia?: Array<{
		id: number;
		kind: string;
		alt: string;
		url: string;
		captions?: Array<{ id: number; language: string; url: string }>;
	}>;
	error?: string;
	code?: string;
}

async function attachImage(workId: number, key: string, alt = "", cookie = creator.cookie) {
	return call("POST", `/api/content/works/${workId}/previews`, cookie, {
		kind: "image",
		key,
		alt,
	});
}

let gatedVideoId = 0;
let gatedGameId = 0;
let textWorkId = 0;
let privateVideoId = 0;
let adultGameId = 0;
let suspendedWorkId = 0;
let emptyGameId = 0;

beforeAll(async () => {
	creator = await createAccount(`preview-owner-${run}`, { fields: { creatorMode: true } });
	stranger = await createAccount(`preview-stranger-${run}`, { fields: { creatorMode: true } });
	viewer = await createAccount(`preview-viewer-${run}`);
	suspendedCreator = await createAccount(`preview-suspended-${run}`, {
		fields: { creatorMode: true },
	});
	await db
		.update(users)
		.set({ suspendedAt: new Date() })
		.where(eq(users.id, suspendedCreator.userId));

	const gatedVideo = await insertWork({
		creatorId: creator.userId,
		type: "video",
		title: "Gated video with previews",
		access: GATED,
	});
	gatedVideoId = gatedVideo.id;
	workIds.push(gatedVideoId);
	await giveWorkAFile(gatedVideoId);

	const gatedGame = await insertWork({
		creatorId: creator.userId,
		type: "game",
		title: "Gated game with previews",
		access: GATED,
	});
	gatedGameId = gatedGame.id;
	workIds.push(gatedGameId);

	const emptyGame = await insertWork({
		creatorId: creator.userId,
		type: "game",
		title: "Gated game with no previews",
		access: GATED,
	});
	emptyGameId = emptyGame.id;
	workIds.push(emptyGameId);

	const textWork = await insertWork({
		creatorId: creator.userId,
		type: "text",
		title: "A text Work takes no preview set",
		body: "Words.",
		bodyHtml: "<p>Words.</p>",
		access: GATED,
	});
	textWorkId = textWork.id;
	workIds.push(textWorkId);

	const privateVideo = await insertWork({
		creatorId: creator.userId,
		type: "video",
		title: "Private video",
		visibility: "private",
		access: GATED,
	});
	privateVideoId = privateVideo.id;
	workIds.push(privateVideoId);
	await giveWorkAFile(privateVideoId);

	const adultGame = await insertWork({
		creatorId: creator.userId,
		type: "game",
		title: "Adult game",
		maturity: "adult",
		access: GATED,
	});
	adultGameId = adultGame.id;
	workIds.push(adultGameId);

	const suspendedWork = await insertWork({
		creatorId: suspendedCreator.userId,
		type: "game",
		title: "A suspended creator's game",
		access: GATED,
	});
	suspendedWorkId = suspendedWork.id;
	workIds.push(suspendedWorkId);

	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	sendSpy?.mockRestore();
	await db.update(users).set({ suspendedAt: null }).where(eq(users.id, suspendedCreator.userId));
	await purgeWorkIds(workIds);
	for (const key of writtenKeys) await storage.delete(key).catch(() => {});
	writtenKeys.length = 0;
});

describe("attaching preview media", () => {
	it("appends an owned screenshot with its alt text", async () => {
		const key = await putImage(gatedVideoId, "first.png");
		const res = await attachImage(gatedVideoId, key, "The opening shot");
		expect(res.status).toBe(201);
		const body = (await res.json()) as PreviewJson;
		expect(body.previewMedia).toHaveLength(1);
		expect(body.previewMedia![0]).toMatchObject({
			kind: "image",
			alt: "The opening shot",
		});
		expect(body.previewMedia![0].url).toContain(`/works/${gatedVideoId}/previews/`);
	});

	it("refuses a key under another account's prefix", async () => {
		const foreign = await putObject(
			`creators/${stranger.userId}/previews/images/${gatedVideoId}/stolen.png`,
			"not mine",
			"image/png",
		);
		const res = await attachImage(gatedVideoId, foreign);
		expect(res.status).toBe(400);
		expect(((await res.json()) as PreviewJson).code).toBe("preview_refused");
	});

	it("refuses a kind the Work does not support", async () => {
		const key = await putImage(textWorkId, "nope.png");
		const res = await attachImage(textWorkId, key);
		expect(res.status).toBe(400);
		expect(((await res.json()) as PreviewJson).code).toBe("preview_refused");
	});

	it("stops at the cap", async () => {
		const existing = await db
			.select({ id: workPreviewMedia.id })
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, gatedGameId));
		const room = 12 - existing.length;
		await db.insert(workPreviewMedia).values(
			Array.from({ length: room }, (_, i) => ({
				workId: gatedGameId,
				kind: "image",
				file: `creators/${creator.userId}/previews/images/${gatedGameId}/seed-${i}.png`,
				alt: "",
				position: existing.length + i,
			})),
		);
		const key = await putImage(gatedGameId, "over.png");
		const res = await attachImage(gatedGameId, key);
		expect(res.status).toBe(400);
		expect(((await res.json()) as PreviewJson).error).toContain("at most 12");
	});

	it("attaches a trailer and queues its scan", async () => {
		sendSpy.mockClear();
		const key = await putTrailer("trailer.mp4");
		const res = await call("POST", `/api/content/works/${gatedVideoId}/previews`, creator.cookie, {
			kind: "video",
			key,
			alt: "ignored",
		});
		expect(res.status).toBe(201);
		const scans = sendSpy.mock.calls.filter((c: unknown[]) => c[0] === QUEUES.SCAN_MEDIA);
		expect(scans.some((c: unknown[]) => (c[1] as { storageKey?: string }).storageKey === key)).toBe(
			true,
		);
	});
});

describe("ordering and removal", () => {
	it("reorders to the whole list and keeps positions dense", async () => {
		const body = (await (
			await call("GET", `/api/content/works/${gatedVideoId}`, creator.cookie)
		).json()) as { work: PreviewJson };
		const items = body.work.previewMedia ?? [];
		const reversed = items.map((i) => i.id).reverse();
		const res = await call(
			"PUT",
			`/api/content/works/${gatedVideoId}/previews/order`,
			creator.cookie,
			{
				previewIds: reversed,
			},
		);
		expect(res.status).toBe(200);
		const rows = await db
			.select({ id: workPreviewMedia.id, position: workPreviewMedia.position })
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, gatedVideoId))
			.orderBy(workPreviewMedia.position);
		expect(rows.map((r) => r.id)).toEqual(reversed);
		expect(rows.map((r) => r.position)).toEqual([0, 1]);
	});

	it("refuses an order that does not name the whole set", async () => {
		const res = await call(
			"PUT",
			`/api/content/works/${gatedVideoId}/previews/order`,
			creator.cookie,
			{
				previewIds: [999999],
			},
		);
		expect(res.status).toBe(400);
	});

	it("removes an item and its object, renumbering the rest", async () => {
		// The screenshot goes, the trailer stays — the caption suite below needs a video
		// preview to attach to, and the removal path is the same for either kind.
		const rows = await db
			.select()
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, gatedVideoId));
		const target = rows.find((r) => r.kind === "image")!;
		const res = await call(
			"DELETE",
			`/api/content/works/${gatedVideoId}/previews/${target.id}`,
			creator.cookie,
		);
		expect(res.status).toBe(200);
		expect(await storage.read(target.file)).toBeNull();
		const remaining = await db
			.select({ position: workPreviewMedia.position })
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, gatedVideoId))
			.orderBy(workPreviewMedia.position);
		expect(remaining.map((r) => r.position)).toEqual([0]);
	});
});

describe("delivery — reachability, not access", () => {
	let previewId = 0;

	beforeAll(async () => {
		const [row] = await db
			.select()
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, gatedVideoId))
			.limit(1);
		previewId = row.id;
	});

	it("redirects a signed-in viewer who has not unlocked the Work", async () => {
		const res = await call(
			"GET",
			`/api/content/works/${gatedVideoId}/previews/${previewId}`,
			viewer.cookie,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBeTruthy();
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("redirects a signed-out visitor too — the storefront is for them", async () => {
		const res = await call("GET", `/api/content/works/${gatedVideoId}/previews/${previewId}`);
		expect(res.status).toBe(302);
	});

	it("404s a private Work's non-owner", async () => {
		const [row] = await db
			.select()
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, privateVideoId))
			.limit(1);
		// Seed one directly: the route is what is under test, not the writer.
		const [seeded] = row
			? [row]
			: await db
					.insert(workPreviewMedia)
					.values({
						workId: privateVideoId,
						kind: "image",
						file: `creators/${creator.userId}/previews/images/${privateVideoId}/private.png`,
						alt: "",
						position: 0,
					})
					.returning();
		const res = await call(
			"GET",
			`/api/content/works/${privateVideoId}/previews/${seeded.id}`,
			stranger.cookie,
		);
		expect(res.status).toBe(404);
	});

	it("404s an Adult Work to an unverified viewer", async () => {
		const [seeded] = await db
			.insert(workPreviewMedia)
			.values({
				workId: adultGameId,
				kind: "image",
				file: `creators/${creator.userId}/previews/images/${adultGameId}/adult.png`,
				alt: "",
				position: 0,
			})
			.returning();
		const res = await call(
			"GET",
			`/api/content/works/${adultGameId}/previews/${seeded.id}`,
			viewer.cookie,
		);
		expect(res.status).toBe(404);
	});

	it("404s a suspended creator's Work", async () => {
		const [seeded] = await db
			.insert(workPreviewMedia)
			.values({
				workId: suspendedWorkId,
				kind: "image",
				file: `creators/${suspendedCreator.userId}/previews/images/${suspendedWorkId}/gone.png`,
				alt: "",
				position: 0,
			})
			.returning();
		const res = await call(
			"GET",
			`/api/content/works/${suspendedWorkId}/previews/${seeded.id}`,
			viewer.cookie,
		);
		expect(res.status).toBe(404);
	});

	it("404s a preview that belongs to another Work", async () => {
		const res = await call(
			"GET",
			`/api/content/works/${gatedGameId}/previews/${previewId}`,
			viewer.cookie,
		);
		expect(res.status).toBe(404);
	});

	it("lets the owner reach their own private Work's previews", async () => {
		const [row] = await db
			.select()
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, privateVideoId))
			.limit(1);
		const res = await call(
			"GET",
			`/api/content/works/${privateVideoId}/previews/${row.id}`,
			creator.cookie,
		);
		expect(res.status).toBe(302);
	});
});

describe("trailer captions", () => {
	let previewId = 0;

	beforeAll(async () => {
		const [row] = await db
			.select()
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, gatedVideoId))
			.limit(1);
		previewId = row.id;
	});

	it("attaches, replaces by language, and serves to a locked viewer", async () => {
		const first = await putPreviewVtt(previewId, "en.vtt");
		const res = await call(
			"POST",
			`/api/content/works/${gatedVideoId}/previews/${previewId}/captions`,
			creator.cookie,
			{ key: first, language: "en", label: "English" },
		);
		expect(res.status).toBe(201);
		const { caption } = (await res.json()) as { caption: { id: number; language: string } };
		expect(caption.language).toBe("en");

		// Replacing the same language keeps one row and takes the old object with it.
		const second = await putPreviewVtt(previewId, "en-2.vtt");
		const replaced = await call(
			"POST",
			`/api/content/works/${gatedVideoId}/previews/${previewId}/captions`,
			creator.cookie,
			{ key: second, language: "en", label: "English" },
		);
		expect(replaced.status).toBe(201);
		expect(await storage.read(first)).toBeNull();

		// Exactly one row survives the replacement, and the locked viewer reaches its text.
		const [current] = await db
			.select()
			.from(workPreviewCaptionTracks)
			.where(eq(workPreviewCaptionTracks.previewId, previewId));
		expect(current).toBeDefined();
		expect(current.id).not.toBe(caption.id);
		const served = await call(
			"GET",
			`/api/content/works/${gatedVideoId}/previews/${previewId}/captions/${current.id}`,
			viewer.cookie,
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toContain("A trailer line.");
	});

	it("serves the current track to the locked viewer with no-store", async () => {
		const body = (await (
			await call("GET", `/api/content/works/${gatedVideoId}`, viewer.cookie)
		).json()) as { work: PreviewJson };
		const trailer = body.work.previewMedia?.find((p) => p.kind === "video");
		expect(trailer?.captions?.length).toBe(1);
		const res = await call("GET", new URL(trailer!.captions![0].url).pathname, viewer.cookie);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/vtt");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("refuses malformed WebVTT", async () => {
		const bad = await putObject(
			`creators/${creator.userId}/previews/captions/${previewId}/bad.vtt`,
			"not a caption file",
			"text/vtt",
		);
		const res = await call(
			"POST",
			`/api/content/works/${gatedVideoId}/previews/${previewId}/captions`,
			creator.cookie,
			{ key: bad, language: "fr" },
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as PreviewJson).code).toBe("captions_refused");
	});
});

describe("serialization", () => {
	it("carries the preview set on the detail payload, locked and owner alike", async () => {
		const locked = (await (
			await call("GET", `/api/content/works/${gatedVideoId}`, viewer.cookie)
		).json()) as { work: PreviewJson };
		expect(locked.work.previewMedia?.length).toBeGreaterThan(0);
		expect(locked.work.previewMedia![0].url).toContain("/previews/");

		const owner = (await (
			await call("GET", `/api/content/works/${gatedVideoId}`, creator.cookie)
		).json()) as { work: PreviewJson };
		expect(owner.work.previewMedia?.length).toBeGreaterThan(0);
	});

	it("carries an empty list for a kind the carousel does not mount on", async () => {
		const body = (await (
			await call("GET", `/api/content/works/${textWorkId}`, viewer.cookie)
		).json()) as { work: PreviewJson };
		expect(body.work.previewMedia).toEqual([]);
	});

	it("carries an empty list for a supported Work with no previews", async () => {
		const body = (await (
			await call("GET", `/api/content/works/${emptyGameId}`, viewer.cookie)
		).json()) as { work: PreviewJson };
		expect(body.work.previewMedia).toEqual([]);
	});
});

describe("storage accounting and deletion", () => {
	it("counts preview bytes against the creator's catalog storage", async () => {
		await runStorageUsageSweep();
		const [row] = await db
			.select()
			.from(accountCycles)
			.where(eq(accountCycles.userId, creator.userId))
			.limit(1);
		expect(row).toBeDefined();
		expect(row.purposes.catalog ?? 0).toBeGreaterThan(0);
	});

	it("sweeps preview objects and caption files when the Work is deleted", async () => {
		const w = await insertWork({
			creatorId: creator.userId,
			type: "game",
			title: "Deleted with previews",
			access: GATED,
		});
		const imageKey = await putImage(w.id, "sweep.png");
		const [preview] = await db
			.insert(workPreviewMedia)
			.values({ workId: w.id, kind: "image", file: imageKey, alt: "", position: 0 })
			.returning();
		const vttKey = await putPreviewVtt(preview.id, "sweep.vtt");
		await db.insert(workPreviewCaptionTracks).values({
			previewId: preview.id,
			language: "en",
			label: "English",
			kind: "captions",
			storageKey: vttKey,
			byteSize: VTT.length,
			cueCount: 2,
		});
		const [row] = await db.select().from(works).where(eq(works.id, w.id));
		await purgeWorkMedia(row, [], []);
		expect(await storage.read(imageKey)).toBeNull();
		expect(await storage.read(vttKey)).toBeNull();
		workIds.push(w.id);
	});
});
