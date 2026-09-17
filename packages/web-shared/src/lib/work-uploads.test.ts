// SPDX-License-Identifier: Apache-2.0
/**
 * The upload store that carries a file into a Work after the Work exists.
 *
 * Tested here rather than only in a browser because the failure it guards against looks like
 * success on screen: a file that went up and was never attached leaves a Work reading "no file
 * yet" beside an upload bar that finished, and a retry that re-sends a 2 GB file to repair a
 * failed attach costs a creator the whole upload again for a request that took milliseconds.
 */
import { describe, expect, it } from "bun:test";
import {
	createWorkUploadStore,
	type WorkUploadTarget,
	type WorkUploadTransport,
} from "./work-uploads";

const VIDEO: WorkUploadTarget = { kind: "source", type: "video" };

/** A transport whose every call waits until the test lets it go, and records what it was asked. */
function controlledTransport() {
	const calls: string[] = [];
	let releasePut: ((key: string) => void) | null = null;
	let failPut: (() => void) | null = null;
	let releaseAttach: (() => void) | null = null;
	let failAttach: (() => void) | null = null;
	let progress: ((percent: number) => void) | null = null;

	const transport: WorkUploadTransport = {
		put(_file, _target, onProgress) {
			calls.push("put");
			progress = onProgress;
			return new Promise((resolve, reject) => {
				releasePut = resolve;
				failPut = () => reject(new Error("network"));
			});
		},
		attach(workId, _target, key) {
			calls.push(`attach ${workId} ${key}`);
			return new Promise((resolve, reject) => {
				releaseAttach = resolve;
				failAttach = () => reject(new Error("409"));
			});
		},
	};

	const tick = () => new Promise((r) => setTimeout(r, 0));
	return {
		transport,
		calls,
		progress: (p: number) => progress?.(p),
		putArrives: async (key: string) => {
			releasePut?.(key);
			await tick();
		},
		putFails: async () => {
			failPut?.();
			await tick();
		},
		attachAnswers: async () => {
			releaseAttach?.();
			await tick();
		},
		attachFails: async () => {
			failAttach?.();
			await tick();
		},
	};
}

const file = () => new File(["bytes"], "clip.mp4", { type: "video/mp4" });

describe("work uploads", () => {
	it("uploads, then attaches the key that came back, then reports done", async () => {
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		store.start(7, file(), VIDEO);
		expect(store.list()[0]).toMatchObject({ workId: 7, status: "uploading", progress: 0 });
		expect(store.active()).toBe(true);

		t.progress(40);
		expect(store.list()[0].progress).toBe(40);

		await t.putArrives("creators/1/video/clip.mp4");
		expect(store.list()[0].status).toBe("attaching");
		expect(store.active()).toBe(true);

		await t.attachAnswers();
		expect(store.list()[0].status).toBe("done");
		expect(store.active()).toBe(false);
		expect(t.calls).toEqual(["put", "attach 7 creators/1/video/clip.mp4"]);
	});

	it("holds the file after a failed upload, and a retry sends it again", async () => {
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		const id = store.start(7, file(), VIDEO);
		await t.putFails();
		expect(store.list()[0].status).toBe("failed");
		expect(store.list()[0].error).toContain("clip.mp4");
		// A failed upload is not in flight, so leaving the page no longer loses anything.
		expect(store.active()).toBe(false);

		store.retry(id);
		expect(store.list()[0].status).toBe("uploading");
		await t.putArrives("k");
		await t.attachAnswers();
		expect(store.list()[0].status).toBe("done");
		expect(t.calls).toEqual(["put", "put", "attach 7 k"]);
	});

	it("retries only the attach when the bytes already arrived", async () => {
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		const id = store.start(7, file(), VIDEO);
		await t.putArrives("k");
		await t.attachFails();
		expect(store.list()[0].status).toBe("failed");

		store.retry(id);
		await t.attachAnswers();
		expect(store.list()[0].status).toBe("done");
		expect(t.calls).toEqual(["put", "attach 7 k", "attach 7 k"]);
	});

	it("replaces a Work's failed upload when its file is picked again", async () => {
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		store.start(7, file(), VIDEO);
		await t.putFails();
		store.start(7, file(), VIDEO);
		expect(store.list().map((u) => u.status)).toEqual(["uploading"]);
	});

	it("keeps builds side by side, since a Work carries several", async () => {
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		const build: WorkUploadTarget = { kind: "build", platform: "linux" };
		store.start(7, file(), build);
		await t.putFails();
		store.start(7, file(), build);
		expect(store.list()).toHaveLength(2);
	});
});
