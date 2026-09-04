// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scanning a stored video, end to end from object to rows.
 *
 * 🚨 **One matching frame in ninety minutes is the case video coverage exists for**, so the
 * fold is by severity and never by majority. A video whose every other frame is unremarkable
 * is still `apparent-csam` if one frame matched, and the assertions below are written to
 * fail if that ever becomes a vote.
 *
 * ⭐ **Every sampled frame gets its own row beside the summary**, keyed `<key>#t=<seconds>`.
 * Those hashes are ours rather than the vendor's, so no Match Data restriction touches them
 * — and they are what lets a corpus update be re-checked later without decoding the video
 * again, which for video is the expensive half. The summary row at the bare key is what the
 * release gate and the owed sweep watch, because they enumerate keys before anything has
 * been decoded and cannot know how many frames there will be.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { mediaScans, users, works } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import { scanStoredVideo, worstOutcome } from "../services/safety-scan";
import { storage } from "../services/storage/index.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const CREDS = { username: "u", password: "p" };
const RUN = crypto.randomUUID().slice(0, 8);

const outcome = (determination: string) =>
	({
		determination,
		vendorMatch: null,
		reportable: determination === "apparent-csam",
		quarantine: determination !== "clean" && determination !== "unscannable",
	}) as Parameters<typeof worstOutcome>[0][number];

describe("worstOutcome — the worst frame decides the video", () => {
	it("🚨 lets one match outrank every clean frame around it", () => {
		const frames = [
			...Array.from({ length: 199 }, () => outcome("clean")),
			outcome("apparent-csam"),
		];
		expect(worstOutcome(frames).determination).toBe("apparent-csam");
		// And the order it arrives in cannot matter.
		expect(worstOutcome([...frames].reverse()).determination).toBe("apparent-csam");
	});

	it("keeps the two kinds of match apart, because only one is reportable", () => {
		expect(worstOutcome([outcome("clean"), outcome("harmful-abusive")]).determination).toBe(
			"harmful-abusive",
		);
		expect(worstOutcome([outcome("harmful-abusive"), outcome("apparent-csam")]).determination).toBe(
			"apparent-csam",
		);
	});

	it("⭐ ranks unscannable BELOW clean, so one unhashable frame cannot erase a real scan", () => {
		// A fade to black produces a fingerprint with no signal in it and is never sent. If
		// that dragged the video down to "never examined", almost every real video would
		// record as unscannable and the coverage would be a fiction.
		expect(worstOutcome([outcome("unscannable"), outcome("clean")]).determination).toBe("clean");
	});

	it("calls a video with no answers at all unscannable, not clean", () => {
		// The empty fold. Recording "nothing matched" for a video nobody ever asked about is
		// the exact way "we scan uploads" becomes quietly untrue.
		expect(worstOutcome([]).determination).toBe("unscannable");
		expect(worstOutcome([outcome("unscannable")]).determination).toBe("unscannable");
	});
});

/** A synthetic video whose picture changes over time. */
async function makeVideo(seconds: number): Promise<Buffer> {
	const path = join(tmpdir(), `sv_${crypto.randomUUID()}.mp4`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc=duration=${seconds}:size=160x120:rate=10`,
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

/**
 * A Shield stand-in that answers `classification` for the nth hash it is asked about and
 * `no-known-match` for the rest — so a test can plant one match in a video without knowing
 * the hashes in advance.
 */
function stubShield(matchIndex: number | null, classification = "csam") {
	const original = globalThis.fetch;
	let sent: string[] = [];
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { hashes?: string[] };
		sent = body.hashes ?? [];
		const scanned: Record<string, { classification: string; match_type: string | null }> = {};
		sent.forEach((h, i) => {
			scanned[h] =
				i === matchIndex
					? { classification, match_type: "near" }
					: { classification: "no-known-match", match_type: null };
		});
		return new Response(JSON.stringify({ scanned_hashes: scanned }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return {
		url: "https://shield.test",
		get sent() {
			return sent;
		},
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const creatorName = `sv_creator_${RUN}`;
let creatorId = 0;
const keys: string[] = [];

async function stageVideo(label: string): Promise<{ workId: number; key: string }> {
	const work = await insertWork({ creatorId, type: "video", title: `Video ${label} ${RUN}` });
	const key = `creators/${creatorId}/videos/${RUN}-${label}.mp4`;
	await storage.upload(key, await makeVideo(35), "video/mp4");
	await db.update(works).set({ sourceKey: key }).where(eq(works.id, work.id));
	keys.push(key);
	return { workId: work.id, key };
}

describe("scanStoredVideo — object in, rows out", () => {
	beforeAll(async () => {
		await db
			.execute(`DELETE FROM users WHERE username = '${creatorName}'` as unknown as never)
			.catch(() => {});
		const [creator] = await db
			.insert(users)
			.values({
				username: creatorName,
				email: `${creatorName}@example.com`,
				isCreator: true,
			})
			.returning({ id: users.id });
		creatorId = creator.id;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		for (const key of keys) {
			await db.delete(mediaScans).where(like(mediaScans.storageKey, `${key}%`));
		}
		await db.delete(users).where(eq(users.id, creatorId));
	});

	it("⭐ writes a row per sampled frame AND a summary row at the bare key", async () => {
		const { workId, key } = await stageVideo("rows");
		const stub = stubShield(null);
		try {
			const result = await scanStoredVideo(key, {
				workId,
				credentials: CREDS,
				baseUrl: stub.url,
			});
			expect(result.determination).toBe("clean");

			const rows = await db
				.select()
				.from(mediaScans)
				.where(like(mediaScans.storageKey, `${key}%`));
			const summary = rows.find((r) => r.storageKey === key);
			const frames = rows.filter((r) => r.storageKey !== key);

			// The summary is what the gate watches, and it carries no hash of its own —
			// a video has no single fingerprint, and inventing one would be a lie in a column.
			expect(summary, "the gate watches the bare key").toBeDefined();
			expect(summary!.pdqHash).toBeNull();
			expect(summary!.determination).toBe("clean");

			expect(frames.length).toBeGreaterThan(2);
			for (const frame of frames) {
				expect(frame.storageKey).toMatch(/#t=\d+$/);
				// Ours, not the vendor's — which is why keeping them is free of every Match
				// Data restriction, and what makes a later corpus re-check possible.
				expect(frame.pdqHash).toMatch(/^[0-9a-f]{64}$/);
				expect(frame.workId).toBe(workId);
			}
			// One request for the whole video, not one per frame.
			expect(stub.sent.length).toBe(frames.length);
		} finally {
			stub.restore();
		}
	}, 60_000);

	it("🚨 quarantines the Work when a single frame matches", async () => {
		const { workId, key } = await stageVideo("match");
		// The second frame, so a match that is neither first nor last has to be found.
		const stub = stubShield(1);
		try {
			const result = await scanStoredVideo(key, {
				workId,
				credentials: CREDS,
				baseUrl: stub.url,
			});
			expect(result.determination).toBe("apparent-csam");
			expect(result.reportable).toBe(true);
			expect(result.vendorMatch).toMatchObject({ classification: "csam", matchType: "near" });

			const [after] = await db
				.select({ status: works.quarantineStatus })
				.from(works)
				.where(eq(works.id, workId));
			expect(after.status).toBe("quarantined");

			// The matching frame is identifiable, not merely counted — that is what the
			// per-frame keys buy.
			const matched = await db
				.select({ key: mediaScans.storageKey, determination: mediaScans.determination })
				.from(mediaScans)
				.where(like(mediaScans.storageKey, `${key}#%`));
			expect(matched.filter((m) => m.determination === "apparent-csam")).toHaveLength(1);
		} finally {
			stub.restore();
		}
	}, 60_000);

	it("records an object storage does not have as unscannable, and does not throw", async () => {
		// A key the database names and storage lost. Retrying will not make it reappear, so
		// the row is the answer — and it must not be `clean`.
		const missing = `creators/${creatorId}/videos/${RUN}-gone.mp4`;
		keys.push(missing);
		const result = await scanStoredVideo(missing, { credentials: CREDS });
		expect(result.determination).toBe("unscannable");
		const [row] = await db.select().from(mediaScans).where(eq(mediaScans.storageKey, missing));
		expect(row.determination).toBe("unscannable");
	});
});
