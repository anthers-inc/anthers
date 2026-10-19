// SPDX-License-Identifier: Apache-2.0
/**
 * The store that carries a hosted build from the Upload page to its registered file list.
 *
 * Tested without a browser because the failure it guards against is silent: a build whose
 * files all went up but whose registration never ran is an open row with bytes behind it
 * and nothing a player can load. The order — create, one PUT per file, register, complete
 * — is the property, and each phase's failure leaves the creator a sentence rather than a
 * half-finished build they have to guess about.
 */
import { describe, expect, it } from "bun:test";
import { pickBuildFolder, type WebBuildPick } from "./web-build-files";
import {
	type BuildFileRef,
	createWebBuildUploadStore,
	type WebBuildUploadInput,
	type WebBuildUploadTransport,
} from "./web-build-uploads";

function file(path: string, bytes = "bytes"): File {
	const f = new File([bytes], path.split("/").pop() ?? path);
	Object.defineProperty(f, "webkitRelativePath", { value: path });
	return f;
}

function pick(): WebBuildPick {
	return pickBuildFolder([
		file("web/index.html", "<html></html>"),
		file("web/index.js", "boot()"),
		file("web/index.pck", "pack"),
	]);
}

const INPUT: WebBuildUploadInput = { entryPath: "web/index.html", requiresIsolation: true };

/** A transport that answers at once and records the ceremony it was asked for. */
function recordingTransport(overrides: Partial<WebBuildUploadTransport> = {}) {
	const calls: string[] = [];
	const transport: WebBuildUploadTransport = {
		async create(workId, input) {
			calls.push(`create ${workId} ${input.entryPath} ${input.requiresIsolation}`);
			return 42;
		},
		async put(_workId, buildId, { path }, onProgress) {
			calls.push(`put ${buildId} ${path}`);
			onProgress(50);
			return {
				path,
				storageRef: `creators/1/web-builds/${buildId}/${path}`,
				fileSize: 6,
				contentType: "",
			};
		},
		async register(_workId, buildId, files: BuildFileRef[]) {
			calls.push(`register ${buildId} ${files.length}`);
		},
		async complete(_workId, buildId, input) {
			calls.push(`complete ${buildId} ${input.entryPath}`);
		},
		...overrides,
	};
	return { transport, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("web build uploads", () => {
	it("creates the build, puts every file, registers the list, then completes it", async () => {
		const t = recordingTransport();
		const store = createWebBuildUploadStore(t.transport);
		const id = store.start(7, pick(), INPUT);
		expect(store.list()[0]).toMatchObject({
			workId: 7,
			entryPath: "web/index.html",
			requiresIsolation: true,
			status: "uploading",
		});
		expect(store.active()).toBe(true);

		await tick();
		await tick();
		expect(t.calls).toEqual([
			"create 7 web/index.html true",
			"put 42 web/index.html",
			"put 42 web/index.js",
			"put 42 web/index.pck",
			"register 42 3",
			"complete 42 web/index.html",
		]);
		const upload = store.list().find((u) => u.id === id)!;
		expect(upload.status).toBe("done");
		expect(upload.files.every((f) => f.done && f.percent === 100)).toBe(true);
		expect(store.active()).toBe(false);
	});

	it("fails the whole build when a file's upload fails, naming the file", async () => {
		const t = recordingTransport({
			async put(_workId, buildId, { path }, _onProgress) {
				t.calls.push(`put ${buildId} ${path}`);
				throw new Error("Upload failed with status 403");
			},
		});
		const store = createWebBuildUploadStore(t.transport);
		store.start(7, pick(), INPUT);
		await tick();
		await tick();
		const [upload] = store.list();
		expect(upload.status).toBe("failed");
		expect(upload.error).toContain("web/index.html");
		expect(upload.error).toContain("403");
		// Registration never runs on a partial list.
		expect(t.calls).toEqual(["create 7 web/index.html true", "put 42 web/index.html"]);
	});

	it("fails before any file when the build unit cannot be created", async () => {
		const t = recordingTransport({
			async create() {
				t.calls.push("create");
				throw new Error("The build couldn't be started. Try again.");
			},
		});
		const store = createWebBuildUploadStore(t.transport);
		store.start(7, pick(), INPUT);
		await tick();
		expect(store.list()[0].status).toBe("failed");
		expect(store.list()[0].error).toContain("couldn't be started");
		expect(t.calls).toEqual(["create"]);
	});

	it("a cancel aborts the send and forgets the entry", async () => {
		let signal: AbortSignal | undefined;
		let release: () => void = () => {};
		const t = recordingTransport({
			put(_workId, _buildId, { path }, _onProgress, putSignal) {
				t.calls.push(`put 42 ${path}`);
				signal = putSignal;
				return new Promise((resolve) => {
					release = () =>
						resolve({ path, storageRef: `key-${path}`, fileSize: 6, contentType: "" });
				});
			},
		});
		const store = createWebBuildUploadStore(t.transport);
		const id = store.start(7, pick(), INPUT);
		await tick();
		expect(signal?.aborted).toBe(false);
		store.cancel(id);
		expect(signal?.aborted).toBe(true);
		expect(store.list()).toHaveLength(0);
		expect(store.active()).toBe(false);
		// The run's late answer lands on an entry that is gone; nothing registers it.
		release();
		await tick();
		expect(t.calls).toEqual(["create 7 web/index.html true", "put 42 web/index.html"]);
	});
});
