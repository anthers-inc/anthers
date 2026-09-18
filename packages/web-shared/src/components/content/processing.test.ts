// SPDX-License-Identifier: Apache-2.0
/**
 * What a creator is told about processing, and what the Dashboard's processing panel lists.
 *
 * The failure worth a suite is the quiet one: an empty panel is exactly what a creator with
 * nothing processing should see, so a condition that stops matching looks like success.
 */
import { describe, expect, it } from "bun:test";
import type { Work } from "../../lib/types";
import type { WorkUpload } from "../../lib/work-uploads";
import {
	etaLeft,
	etaText,
	processingQueue,
	processingStatusText,
	processingText,
	RECENTLY_FINISHED_MS,
} from "./processing";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function work(id: number, transcoding: Partial<NonNullable<Work["transcoding"]>> | null): Work {
	return {
		id,
		publicId: 100000 + id,
		type: "video",
		title: `Work ${id}`,
		transcoding: transcoding
			? { status: "processing", progress: 0, etaSeconds: null, updatedAt: "", ...transcoding }
			: null,
	} as unknown as Work;
}

function upload(workId: number, over: Partial<WorkUpload> = {}): WorkUpload {
	return {
		id: `u${workId}`,
		workId,
		fileName: "clip.mp4",
		target: { kind: "source", type: "video" },
		status: "uploading",
		progress: 40,
		error: null,
		...over,
	};
}

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("processingText", () => {
	it("gives the estimate only when there is one", () => {
		// Audio and ebooks never carry an estimate, and a sentence ending in an empty "left"
		// is the failure the column's own comment warns about.
		expect(processingText(work(1, { progress: 43, etaSeconds: 150 }).transcoding)).toBe(
			"Processing 43% · About 3 minutes left",
		);
		expect(processingText(work(1, { progress: 43, etaSeconds: null }).transcoding)).toBe(
			"Processing 43%",
		);
		expect(processingText(work(1, { status: "pending" }).transcoding)).toBe("Waiting to process");
	});

	it("says nothing about a job that is not running", () => {
		expect(processingText(null)).toBeNull();
		expect(processingText(work(1, { status: "completed" }).transcoding)).toBeNull();
		expect(processingText(work(1, { status: "failed" }).transcoding)).toBeNull();
	});
});

describe("processingStatusText", () => {
	it("leaves the estimate out, because a badge has no room for it", () => {
		expect(processingStatusText(work(1, { progress: 43, etaSeconds: 30 }).transcoding)).toBe(
			"Processing 43%",
		);
		expect(processingStatusText(work(1, { status: "pending" }).transcoding)).toBe(
			"Waiting to process",
		);
		expect(processingStatusText(work(1, { status: "completed" }).transcoding)).toBeNull();
	});
});

describe("etaText", () => {
	it("never names seconds", () => {
		expect(etaText(1)).toBe("less than a minute");
		expect(etaText(59)).toBe("less than a minute");
		expect(etaText(60)).toBe("about a minute");
		expect(etaText(89)).toBe("about a minute");
	});

	it("gives whole minutes under ten, then the nearest five", () => {
		expect(etaText(150)).toBe("about 3 minutes");
		expect(etaText(9 * 60)).toBe("about 9 minutes");
		expect(etaText(23 * 60)).toBe("about 25 minutes");
		expect(etaText(57 * 60)).toBe("about 55 minutes");
	});

	it("turns into hours once the nearest five minutes is an hour", () => {
		// 58 minutes rounds to 60, which is an hour rather than "about 60 minutes".
		expect(etaText(58 * 60)).toBe("about an hour");
		expect(etaText(80 * 60)).toBe("about an hour");
		expect(etaText(100 * 60)).toBe("about 2 hours");
	});
});

describe("etaLeft", () => {
	it("is a sentence, and absent when there is no estimate", () => {
		expect(etaLeft(150)).toBe("About 3 minutes left");
		expect(etaLeft(30)).toBe("Less than a minute left");
		expect(etaLeft(0)).toBeNull();
		expect(etaLeft(null)).toBeNull();
		expect(etaLeft(undefined)).toBeNull();
	});
});

describe("processingQueue", () => {
	it("lists uploads, then running, then waiting, then what finished today", () => {
		const rows = processingQueue(
			[
				work(1, { status: "completed", updatedAt: minutesAgo(30) }),
				work(2, { status: "pending" }),
				work(3, { status: "processing", progress: 10 }),
				work(4, null),
			],
			[upload(4)],
			NOW,
		);
		expect(rows.map((r) => [r.workId, r.state])).toEqual([
			[4, "uploading"],
			[3, "processing"],
			[2, "processing"],
			[1, "finished"],
		]);
		expect(rows[0].detail).toBe("Uploading 40%");
	});

	it("lets a finished Work go after a day", () => {
		const old = work(1, { status: "completed", updatedAt: minutesAgo(24 * 60 + 1) });
		const recent = work(2, {
			status: "completed",
			updatedAt: new Date(NOW - RECENTLY_FINISHED_MS).toISOString(),
		});
		expect(processingQueue([old, recent], [], NOW).map((r) => r.workId)).toEqual([2]);
	});

	it("leaves a failed encode to the worklist", () => {
		expect(processingQueue([work(1, { status: "failed" })], [], NOW)).toEqual([]);
	});

	it("drops an upload once it has landed or failed", () => {
		expect(processingQueue([], [upload(1, { status: "done" })], NOW)).toEqual([]);
		expect(processingQueue([], [upload(1, { status: "failed" })], NOW)).toEqual([]);
	});

	it("names an upload by its file before the listing has caught up with its Work", () => {
		const [row] = processingQueue([], [upload(9)], NOW);
		expect(row).toMatchObject({ workId: 9, title: "clip.mp4", work: null });
	});
});
