// SPDX-License-Identifier: Apache-2.0
/**
 * `downloadToTemp` streams an object to disk and never holds it in memory.
 *
 * 🚨 **This is the one read of a whole video the worker makes, and the worker has less memory
 * than a video can be large.** Collecting the body with `transformToByteArray()` killed the
 * production worker on every video upload, and the restart resumed the same transcode and died
 * again. So every body here refuses to be collected: a download that reaches for the whole
 * object fails the test rather than merely using more memory than it should.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { resolveStorageConfig } from "../services/storage/config";
import { S3StorageService } from "../services/storage/s3";

const CONFIG = resolveStorageConfig({
	STORAGE_REGION: "auto",
	STORAGE_BUCKET: "test-private",
	STORAGE_PUBLIC_BUCKET: "test-public",
	STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
	STORAGE_PUBLIC_BASE_URL: "https://cdn.example.org",
	STORAGE_FORCE_PATH_STYLE: "true",
	STORAGE_KEY: "test-key",
	STORAGE_SECRET: "test-secret",
});

/** Three distinct chunks, so a reordered or dropped chunk changes the file. */
const CHUNKS = [0x11, 0x22, 0x33].map((byte) => Buffer.alloc(64 * 1024, byte));
const WHOLE = Buffer.concat(CHUNKS);

const written: string[] = [];

afterAll(async () => {
	await Promise.all(written.map((path) => rm(path, { force: true })));
});

/** A storage service whose client answers every request with this body. */
function serviceAnswering(body: unknown): S3StorageService {
	const service = new S3StorageService(CONFIG);
	const client = (service as unknown as { s3: { send: () => Promise<unknown> } }).s3;
	spyOn(client, "send").mockResolvedValue({ Body: body });
	return service;
}

/** Makes collecting the body into one array a failure, which is the whole assertion. */
function refusingToCollect<T extends object>(body: T): T {
	return Object.assign(body, {
		transformToByteArray: () => {
			throw new Error("the download collected the whole object into memory");
		},
	});
}

async function tempDownloads(): Promise<string[]> {
	return (await readdir(tmpdir())).filter((name) => name.startsWith("s3dl_"));
}

describe("downloadToTemp", () => {
	it("streams a Node stream body to disk, whole and in order", async () => {
		const service = serviceAnswering(refusingToCollect(Readable.from(CHUNKS)));
		const path = await service.downloadToTemp("creators/1/videos/originals/a.mp4");
		written.push(path);
		expect(path.endsWith(".mp4")).toBe(true);
		expect(Buffer.compare(await readFile(path), WHOLE)).toBe(0);
	});

	it("streams a web stream body too, which is what a fetch-based handler returns", async () => {
		const body = refusingToCollect({
			transformToWebStream: () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const chunk of CHUNKS) controller.enqueue(new Uint8Array(chunk));
						controller.close();
					},
				}),
		});
		const path = await serviceAnswering(body).downloadToTemp("creators/1/videos/originals/b.mp4");
		written.push(path);
		expect(Buffer.compare(await readFile(path), WHOLE)).toBe(0);
	});

	it("leaves no partial file behind when the stream fails partway", async () => {
		// ffmpeg would read a half-written file as a truncated video rather than an error.
		const failing = new Readable({
			read() {
				this.push(CHUNKS[0]);
				this.destroy(new Error("connection reset"));
			},
		});
		const before = await tempDownloads();
		await expect(
			serviceAnswering(refusingToCollect(failing)).downloadToTemp(
				"creators/1/videos/originals/c.mp4",
			),
		).rejects.toThrow("connection reset");
		expect((await tempDownloads()).filter((name) => !before.includes(name))).toEqual([]);
	});
});
