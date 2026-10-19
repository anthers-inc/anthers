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
	const signals: Array<AbortSignal | undefined> = [];
	let releasePut: ((key: string) => void) | null = null;
	let failPut: (() => void) | null = null;
	let releaseAttach: (() => void) | null = null;
	let failAttach: (() => void) | null = null;
	let progress: ((percent: number) => void) | null = null;

	const transport: WorkUploadTransport = {
		put(_file, _target, onProgress, signal) {
			calls.push("put");
			signals.push(signal);
			progress = onProgress;
			return new Promise((resolve, reject) => {
				releasePut = resolve;
				failPut = () => reject(new Error("network"));
			});
		},
		attach(workId, _target, key, _file, signal) {
			calls.push(`attach ${workId} ${key}`);
			signals.push(signal);
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
		signals,
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
	it("does not notify subscribers for a progress event that moved nothing", async () => {
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		store.start(7, file(), VIDEO);
		let notifications = 0;
		store.subscribe(() => {
			notifications += 1;
		});

		t.progress(40);
		expect(notifications).toBe(1);
		// The wire speaks far more often than the whole percent moves; an event that
		// leaves it where it was must not re-render every subscriber.
		t.progress(40);
		expect(notifications).toBe(1);
		t.progress(41);
		expect(notifications).toBe(2);

		await t.putArrives("k");
		await t.attachAnswers();
	});

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

	it("a cancel aborts the send and forgets the entry in either phase", async () => {
		// Mid-upload: the transport was handed a live signal, the cancel aborts it, and
		// what the wire eventually answers attaches to nothing — no attach is asked at all.
		const t = controlledTransport();
		const store = createWorkUploadStore(t.transport);
		const idMid = store.start(7, file(), VIDEO);
		expect(t.signals[0]?.aborted).toBe(false);
		store.cancel(idMid);
		expect(t.signals[0]?.aborted).toBe(true);
		expect(store.list()).toHaveLength(0);
		expect(store.active()).toBe(false);
		await t.putArrives("k");
		await t.attachAnswers();
		expect(t.calls).toEqual(["put"]);

		// Mid-attach: the bytes have arrived, so the run holds no put to abort; the cancel
		// still forgets the entry, whose completion writes land nowhere.
		const t2 = controlledTransport();
		const store2 = createWorkUploadStore(t2.transport);
		const idAttach = store2.start(9, file(), VIDEO);
		await t2.putArrives("arrived.mp4");
		store2.cancel(idAttach);
		expect(store2.list()).toHaveLength(0);
		await t2.attachAnswers();
		expect(t2.calls).toEqual(["put", "attach 9 arrived.mp4"]);

		// Canceling an unknown id changes nothing and refuses nothing.
		store2.cancel("upload-999");
		expect(store2.list()).toHaveLength(0);
	});
});
