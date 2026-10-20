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
	type WorkUploadSetRowTarget,
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
const page = (name: string) => new File(["page"], name, { type: "image/png" });
/** A pick of page images, the shape a paged or image set editor hands the store. */
const SET_ROW: WorkUploadSetRowTarget = { kind: "set-row", type: "comic" };

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

	describe("a pick of set rows", () => {
		it("runs the files one at a time, in the order they were picked", async () => {
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			const batchId = store.startBatch(
				7,
				[page("01.png"), page("02.png"), page("03.png")],
				SET_ROW,
			);

			expect(store.list()).toHaveLength(1);
			expect(store.list()[0]).toMatchObject({
				fileName: "01.png",
				status: "uploading",
				batch: { id: batchId, index: 1, total: 3 },
			});
			expect(store.listBatches()[0]).toMatchObject({ total: 3, waiting: 2, held: null });

			await t.putArrives("k1");
			await t.attachAnswers();
			// The second file begins only once the first is attached, so the wire never carries
			// two digest reads and two part streams at once.
			expect(store.list()[1]).toMatchObject({
				fileName: "02.png",
				status: "uploading",
				batch: { index: 2 },
			});
			expect(store.listBatches()[0]).toMatchObject({ waiting: 1 });

			await t.putArrives("k2");
			await t.attachAnswers();
			await t.putArrives("k3");
			await t.attachAnswers();

			expect(store.list().map((u) => `${u.fileName} ${u.status}`)).toEqual([
				"01.png done",
				"02.png done",
				"03.png done",
			]);
			expect(t.calls).toEqual(["put", "attach 7 k1", "put", "attach 7 k2", "put", "attach 7 k3"]);
			// Finished, so nothing is held any more; the landed entries stay as the tab's record.
			expect(store.listBatches()).toHaveLength(0);
		});

		it("holds the pick at a failure, and a retry resumes from that file", async () => {
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			store.startBatch(7, [page("01.png"), page("02.png"), page("03.png")], SET_ROW);
			await t.putFails();

			expect(store.list()[0].status).toBe("failed");
			expect(store.listBatches()[0]).toMatchObject({ waiting: 2, held: "01.png" });
			// The rest is not attempted into a dead connection: one failure is one failure.
			expect(t.calls).toEqual(["put"]);

			store.retry(store.list()[0].id);
			await t.putArrives("k1");
			await t.attachAnswers();
			expect(store.list().map((u) => u.fileName)).toEqual(["01.png", "02.png"]);
			expect(store.list()[1].status).toBe("uploading");
		});

		it("ends the pick when the file that failed was its last, keeping the row for its retry", async () => {
			// A lone refused file is the shape the gallery walk covers: the refusal is permanent, so
			// holding a pick behind it would block the editor for no one's benefit.
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			store.startBatch(7, [page("01.png")], SET_ROW);
			await t.putFails();

			expect(store.listBatches()).toHaveLength(0);
			expect(store.list()[0]).toMatchObject({
				status: "failed",
				fileName: "01.png",
				batch: { index: 1, total: 1 },
			});
		});

		it("skips past the file a pick is held on", async () => {
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			store.startBatch(7, [page("01.png"), page("02.png")], SET_ROW);
			await t.putFails();

			store.dismiss(store.list()[0].id);
			expect(store.list().map((u) => u.fileName)).toEqual(["02.png"]);
			expect(store.listBatches()[0]).toMatchObject({ waiting: 0, held: null });
			await t.putArrives("k2");
			await t.attachAnswers();
			expect(store.listBatches()).toHaveLength(0);
		});

		it("moves on when the creator cancels the file on the wire", async () => {
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			store.startBatch(7, [page("01.png"), page("02.png")], SET_ROW);
			store.cancel(store.list()[0].id);

			expect(t.signals[0]?.aborted).toBe(true);
			expect(store.list().map((u) => u.fileName)).toEqual(["02.png"]);
			expect(store.listBatches()[0]).toMatchObject({ waiting: 0, held: null });
			await t.putArrives("k2");
			await t.attachAnswers();
			expect(store.listBatches()).toHaveLength(0);
		});

		it("stops the rest: the live file aborts and the files that never began are dropped", async () => {
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			const batchId = store.startBatch(
				7,
				[page("01.png"), page("02.png"), page("03.png")],
				SET_ROW,
			);
			store.cancelBatch(batchId);

			expect(t.signals[0]?.aborted).toBe(true);
			expect(store.list()).toHaveLength(0);
			expect(store.listBatches()).toHaveLength(0);
			expect(store.active()).toBe(false);
		});

		it("an image's pick bar is indeterminate, since its one request reports no percent", () => {
			const t = controlledTransport();
			const store = createWorkUploadStore(t.transport);
			store.startBatch(7, [page("01.png")], { kind: "set-row", type: "image" });
			expect(store.list()[0].progress).toBeNull();
		});
	});
});
