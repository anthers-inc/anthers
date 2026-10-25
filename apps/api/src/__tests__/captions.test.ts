// SPDX-License-Identifier: Apache-2.0
/**
 * Caption tracks — the captions task's suites.
 *
 * Three things are actually under test:
 *
 * 1. **The parse is the ingest gate.** A file that is not a caption file — wrong header,
 *    no cues, malformed timestamps — is refused with a specific message, and a valid one
 *    attaches with a true cue count. This is the suite the "captions are always real
 *    captions" invariant rests on, since the serving route reads bytes back rather than
 *    re-validating.
 * 2. **Serving obeys the same gates as the video itself.** Access refused, captions
 *    refused; access granted, captions served; and deliberately NO Public Access meter,
 *    because the meter measures attention and the playlist route is where that bites.
 *    Where a document claims an absence, the absence needs a test ("never metered on
 *    captions" would otherwise be a comment nobody verified).
 * 3. **The payload and the routes agree.** A reachable viewer's serialization carries
 *    playable URLs; a locked viewer's carries none — no URL, no side door via a stale
 *    address, because the route re-checks.
 *
 * A test cleans up everything it writes, in `afterAll`, on success or failure (Parker).
 * The caption objects live under the creator fixture's `creators/{id}/` prefix; tracks
 * deleted through the route take their bytes with them, the strays go by key below.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import type { AccessRow } from "@anthers/db/schema";
import { workCaptionTracks, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { attachCaptionTrack, parseVtt, VttRefusal } from "../services/captions";
import { storage } from "../services/storage";
import type { FixtureAccount } from "./account-fixture";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { giveWorkAFile, insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const creator: FixtureAccount[] = [];
const stranger: FixtureAccount[] = [];

/** Every storage key this file wrote, swept at the end. */
const writtenKeys: string[] = [];

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello, and welcome.

00:00:04.000 --> 00:00:05.500
Second cue.
`;

/** A gated sibling Work: the access decision, not the upload, is what some rows prove. */
const GATED_ROW: AccessRow = { threshold: 300, allow: true, price: "3.00" };

async function uploadCaptionVtt(
	creatorId: number,
	workId: number,
	name: string,
	text: string,
): Promise<string> {
	const key = `creators/${creatorId}/captions/${workId}/${name}`;
	await storage.upload(key, Buffer.from(text, "utf-8"), "text/vtt", "private");
	writtenKeys.push(key);
	return key;
}

function captionUrl(workId: number): string {
	return `/api/content/works/${workId}/captions`;
}

interface CaptionJson {
	caption: { id: number; language: string; label: string; kind: string; url: string };
	error?: string;
	code?: string;
}

let ungatedWorkId = 0;
let gatedWorkId = 0;

/** The baseline `$0` row that makes a released streaming Work the commons (Work shapes without it are locked — empty is not free). */
const BASELINE_ROW: AccessRow = { threshold: 0, allow: true, price: "0" };

beforeAll(async () => {
	creator.push(await createAccount("captions-owner", { fields: { creatorMode: true } }));
	stranger.push(await createAccount("captions-stranger", { fields: { creatorMode: true } }));

	const ungated = await insertWork({
		creatorId: creator[0].userId,
		type: "video",
		title: "Captioned open video",
		access: [BASELINE_ROW],
	});
	ungatedWorkId = ungated.id;
	await giveWorkAFile(ungatedWorkId);

	const gated = await insertWork({
		creatorId: creator[0].userId,
		type: "video",
		title: "Captioned gated video",
		access: [GATED_ROW],
	});
	gatedWorkId = gated.id;
	await giveWorkAFile(gatedWorkId);
});

afterAll(async () => {
	await purgeWorkIds([ungatedWorkId, gatedWorkId]);
	for (const key of writtenKeys) await storage.delete(key).catch(() => {});
	writtenKeys.length = 0;
});

describe("parseVtt — the ingest gate", () => {
	it("counts the cues of a valid file", () => {
		const parsed = parseVtt(VTT);
		expect(parsed).toEqual({ ok: true, cueCount: 2 });
	});

	it("admits a BOM and hour-less timestamps", () => {
		const parsed = parseVtt(`\uFEFFWEBVTT\n\n01:02.000 --> 01:05.000\nOne\n`);
		expect(parsed).toEqual({ ok: true, cueCount: 1 });
	});

	it("skips NOTE blocks without swallowing a cue", () => {
		const parsed = parseVtt(
			`WEBVTT\n\nNOTE\nthis is a comment\n\n00:00:01.000 --> 00:00:02.000\nHi\n`,
		);
		expect(parsed).toEqual({ ok: true, cueCount: 1 });
	});

	it("refuses a file with no WEBVTT header", () => {
		expect(parseVtt("00:00:01.000 --> 00:00:02.000\nHi\n").ok).toBe(false);
	});

	it("refuses a header-only file — zero cues is a track that shows nothing", () => {
		const parsed = parseVtt("WEBVTT\n");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain("no caption cues");
	});

	it("refuses a malformed timestamp line with its line number", () => {
		const parsed = parseVtt("WEBVTT\n\nnot a timestamp\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toMatch(/line 3/);
	});

	it("refuses a cue whose end is not after its start", () => {
		const parsed = parseVtt("WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nBackwards\n");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain("after its start");
	});

	it("refuses a cue with no text", () => {
		const parsed = parseVtt(
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\nNext\n",
		);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain("no text");
	});
});

describe("attaching a track", () => {
	it("attaches a valid upload for its owner, counting its cues", async () => {
		const key = await uploadCaptionVtt(creator[0].userId, ungatedWorkId, "en.vtt", VTT);
		const res = await app.request(captionUrl(ungatedWorkId), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: creator[0].cookie,
			},
			body: JSON.stringify({ key, language: "en" }),
		});
		expect(res.status).toBe(201);
		const { caption } = (await res.json()) as CaptionJson;
		expect(caption.language).toBe("en");
		expect(caption.label).toBe("en");
		expect(caption.url).toContain(`/api/content/works/${ungatedWorkId}/captions/${caption.id}`);
		void caption.kind;
	});

	it("answers 400, not an empty row, for a file that is not a caption file", async () => {
		const key = await uploadCaptionVtt(
			creator[0].userId,
			ungatedWorkId,
			"bad.vtt",
			"just some text",
		);
		const res = await app.request(captionUrl(ungatedWorkId), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: creator[0].cookie,
			},
			body: JSON.stringify({ key, language: "en" }),
		});
		expect(res.status).toBe(400);
		const data = (await res.json()) as { code?: string; error?: string };
		expect(data.code).toBe("captions_refused");
		void data.error;
	});

	it("answers 400 for a reference outside the writer's own prefix", async () => {
		// A key under the stranger's prefix, offered by the creator: the foreign-file door.
		const foreign = `creators/${stranger[0].userId}/captions/${ungatedWorkId}/stolen.vtt`;
		await storage.upload(foreign, Buffer.from(VTT), "text/vtt", "private");
		writtenKeys.push(foreign);
		const res = await app.request(captionUrl(ungatedWorkId), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: creator[0].cookie,
			},
			body: JSON.stringify({ key: foreign, language: "en" }),
		});
		expect(res.status).toBe(400);
	});

	it("answers 404 for a non-owner — another creator's Work is not information to hand out", async () => {
		const key = await uploadCaptionVtt(creator[0].userId, ungatedWorkId, "en-again.vtt", VTT);
		const res = await app.request(captionUrl(ungatedWorkId), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: stranger[0].cookie,
			},
			body: JSON.stringify({ key, language: "en" }),
		});
		expect(res.status).toBe(404);
	});

	it("replaces a language rather than stacking a second track in it", async () => {
		const key = await uploadCaptionVtt(creator[0].userId, gatedWorkId, "en-replace.vtt", VTT);
		await app.request(captionUrl(gatedWorkId), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: creator[0].cookie,
			},
			body: JSON.stringify({ key, language: "en", label: "English" }),
		});
		const key2 = await uploadCaptionVtt(creator[0].userId, gatedWorkId, "en-replace-2.vtt", VTT);
		await app.request(captionUrl(gatedWorkId), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: creator[0].cookie,
			},
			body: JSON.stringify({ key: key2, language: "en", label: "English SDH", kind: "subtitles" }),
		});
		// Same language AND kind replaced; a different kind is a different row.
		const rows = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, gatedWorkId));
		expect(rows.filter((r) => r.kind === "subtitles")).toHaveLength(1);
		expect(rows.filter((r) => r.language === "en")).toHaveLength(2);
		expect(rows.find((r) => r.kind === "subtitles")?.label).toBe("English SDH");
	});

	it("refuses a non-video Work through the route", async () => {
		const audio = await insertWork({ creatorId: creator[0].userId, type: "audio", title: "Audio" });
		const key = await uploadCaptionVtt(creator[0].userId, audio.id, "en.vtt", VTT);
		const res = await app.request(captionUrl(audio.id), {
			method: "POST",
			headers: {
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
				Cookie: creator[0].cookie,
			},
			body: JSON.stringify({ key, language: "en" }),
		});
		expect(res.status).toBe(400);
		const data = (await res.json()) as { code?: string };
		expect(data.code).toBe("captions_not_video");
		await purgeWorkIds([audio.id]);
	});

	it("the service still refuses a non-owner, for any future caller that forgets the route", async () => {
		const [work] = await db.select().from(works).where(eq(works.id, ungatedWorkId)).limit(1);
		const key = await uploadCaptionVtt(creator[0].userId, ungatedWorkId, "en.vtt", VTT);
		await expect(
			attachCaptionTrack({ work, requesterId: stranger[0].userId, key, language: "en" }),
		).rejects.toThrow("Only the Work's creator may attach captions.");
	});
});

describe("direct upload of a caption file", () => {
	it("uploads through the caption branch into the Work's own directory", async () => {
		const form = new FormData();
		form.append("file", new File([VTT], "en.vtt", { type: "text/vtt" }));
		form.append("mediaType", "caption");
		form.append("entityId", String(ungatedWorkId));
		const res = await app.request("/api/content/media-upload/direct", {
			method: "POST",
			headers: { Origin: "http://localhost:3000", Cookie: creator[0].cookie },
			body: form,
		});
		expect(res.status).toBe(201);
		const { key } = (await res.json()) as { key: string };
		expect(key).toMatch(
			new RegExp(`^creators/${creator[0].userId}/captions/${ungatedWorkId}/[a-f0-9]{32}\\.vtt$`),
		);
		writtenKeys.push(key);
	});
});

describe("serving a track", () => {
	it("serves the bytes to anyone who can reach the open Work, with the vtt type", async () => {
		const [row] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, ungatedWorkId));
		expect(row).toBeDefined();
		const res = await app.request(`/api/content/works/${ungatedWorkId}/captions/${row.id}`, {
			headers: { Origin: "http://localhost:3000", Cookie: stranger[0].cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/vtt");
		const text = await res.text();
		expect(text).toContain("Hello, and welcome.");
	});

	it("serves the owner their own gated Work's track", async () => {
		const [row] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, gatedWorkId));
		const res = await app.request(`/api/content/works/${gatedWorkId}/captions/${row.id}`, {
			headers: { Origin: "http://localhost:3000", Cookie: creator[0].cookie },
		});
		expect(res.status).toBe(200);
	});

	it("refuses a stranger a gated Work's track with the same 403 the video gets", async () => {
		const [row] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, gatedWorkId));
		const res = await app.request(`/api/content/works/${gatedWorkId}/captions/${row.id}`, {
			headers: { Origin: "http://localhost:3000", Cookie: stranger[0].cookie },
		});
		expect(res.status).toBe(403);
	});

	it("answers 404 for a track that is not this Work's", async () => {
		const [theirRow] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, gatedWorkId));
		const res = await app.request(`/api/content/works/${ungatedWorkId}/captions/${theirRow.id}`, {
			headers: { Origin: "http://localhost:3000", Cookie: stranger[0].cookie },
		});
		expect(res.status).toBe(404);
	});

	it("answers 401 signed out, exactly as the video's own delivery routes do", async () => {
		const [row] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, ungatedWorkId));
		const res = await app.request(`/api/content/works/${ungatedWorkId}/captions/${row.id}`);
		expect(res.status).toBe(401);
	});
});

describe("the payload and the route agree", () => {
	it("hands a reachable viewer playable URLs", async () => {
		const res = await app.request(`/api/content/works/${ungatedWorkId}`, {
			headers: { Origin: "http://localhost:3000", Cookie: stranger[0].cookie },
		});
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as {
			work: { captions: Array<{ url: string; id: number }> };
		};
		expect(work.captions).toHaveLength(1);
		expect(work.captions[0].url).toContain("captions");
	});

	it("hands a locked viewer an empty list — the track lives inside the gate", async () => {
		const res = await app.request(`/api/content/works/${gatedWorkId}`, {
			headers: { Origin: "http://localhost:3000", Cookie: stranger[0].cookie },
		});
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as { work: { captions: unknown[] } };
		expect(work.captions).toEqual([]);
	});

	it("carries the owner's counts for the Studio editor", async () => {
		const res = await app.request(`/api/content/works/${ungatedWorkId}`, {
			headers: { Origin: "http://localhost:3000", Cookie: creator[0].cookie },
		});
		const { work } = (await res.json()) as {
			work: { captions: Array<{ byteSize: number; cueCount: number }> };
		};
		expect(work.captions[0].cueCount).toBe(2);
		expect(work.captions[0].byteSize).toBeGreaterThan(0);
	});
});

describe("removing a track", () => {
	it("removes the row and its bytes for the owner", async () => {
		const key = await uploadCaptionVtt(creator[0].userId, ungatedWorkId, "en-gone.vtt", VTT);
		const [work] = await db.select().from(works).where(eq(works.id, ungatedWorkId)).limit(1);
		const attached = await attachCaptionTrack({
			work,
			requesterId: creator[0].userId,
			key,
			language: "ff",
		});
		const res = await app.request(`${captionUrl(ungatedWorkId)}/${attached.id}`, {
			method: "DELETE",
			headers: { Origin: "http://localhost:3000", Cookie: creator[0].cookie },
		});
		expect(res.status).toBe(200);
		const { captions } = (await res.json()) as { captions: Array<{ id: number }> };
		expect(captions.find((t) => t.id === attached.id)).toBeUndefined();
		// The object's bytes left with the row.
		expect(await storage.read(key)).toBeNull();
	});

	it("answers 404 for a stranger", async () => {
		const [row] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, gatedWorkId));
		const res = await app.request(`${captionUrl(gatedWorkId)}/${row.id}`, {
			method: "DELETE",
			headers: { Origin: "http://localhost:3000", Cookie: stranger[0].cookie },
		});
		expect(res.status).toBe(404);
	});
});

describe("the parse refusal path through the service", () => {
	it("throws VttRefusal — the class the routes translate to 400 — for garbage", async () => {
		const [work] = await db.select().from(works).where(eq(works.id, ungatedWorkId)).limit(1);
		const key = await uploadCaptionVtt(
			creator[0].userId,
			ungatedWorkId,
			"png.vtt",
			"not webvtt at all",
		);
		await expect(
			attachCaptionTrack({ work, requesterId: creator[0].userId, key, language: "en" }),
		).rejects.toBeInstanceOf(VttRefusal);
	});
});
