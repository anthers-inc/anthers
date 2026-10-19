// SPDX-License-Identifier: Apache-2.0
/**
 * The hosted build going up from the Upload page — a whole export's file list, held
 * outside React so the upload outlives the page that started it.
 *
 * 🚨 **A browser build is not a single file, and the Work does not wait for it.** Page
 * one creates the Work and starts the build, then moves the creator to the Work's own
 * page; the build's files keep going from here while they fill in the Work. That is the
 * same shape `work-uploads` carries for one file (Parker, 2026-09-16), applied to the
 * lane where the deliverable is a file *list*: create the build unit, upload each file,
 * register the list, and complete it as the creator's own act.
 *
 * ⭐ **A module rather than a provider**, for the reason `work-uploads` states: it is
 * mounted by being imported and survives any navigation inside the app.
 *
 * ⚠️ **It does not survive the tab.** A reload abandons the upload, so a `beforeunload`
 * warning is armed while anything is in flight, and the Work page's Hosted Build section
 * shows the rows that did land — an open build is a draft state, not an error.
 */

import { useSyncExternalStore } from "react";
import { apiBaseUrl, apiSendsCookies, client } from "./rpc";
import type { WebBuildPick } from "./web-build-files";

export type WebBuildUploadStatus = "uploading" | "registering" | "done" | "failed";

/** One file's progress through its own PUT. */
export interface WebBuildUploadFile {
	path: string;
	size: number;
	percent: number;
	done: boolean;
}

export interface WebBuildUpload {
	id: string;
	workId: number;
	entryPath: string;
	requiresIsolation: boolean;
	status: WebBuildUploadStatus;
	files: WebBuildUploadFile[];
	/** What went wrong, as a sentence a creator can read. */
	error: string | null;
}

/** The questions a build answers at create time; the entry and isolation are fixed there. */
export interface WebBuildUploadInput {
	entryPath: string;
	requiresIsolation: boolean;
	label?: string;
}

/** One registered file, as the register route takes it. */
export interface BuildFileRef {
	path: string;
	storageRef: string;
	fileSize: number;
	contentType: string;
}

/** How a build reaches storage and its rows. Swappable so the store can be tested without a network. */
export interface WebBuildUploadTransport {
	/** Create the build unit; resolves to its id. */
	create(workId: number, input: WebBuildUploadInput, signal: AbortSignal): Promise<number>;
	/** Send one file and resolve the reference the register route takes. */
	put(
		workId: number,
		buildId: number,
		file: WebBuildPick["files"][number],
		onProgress: (percent: number) => void,
		signal: AbortSignal,
	): Promise<BuildFileRef>;
	/** Register the whole landed list. */
	register(
		workId: number,
		buildId: number,
		files: BuildFileRef[],
		signal: AbortSignal,
	): Promise<void>;
	/** Say the list is whole, naming the entry. */
	complete(
		workId: number,
		buildId: number,
		input: WebBuildUploadInput,
		signal: AbortSignal,
	): Promise<void>;
}

/**
 * PUT one file to its presigned URL, with progress. Mirrors `upload.ts`'s xhrUpload — XHR
 * because fetch has no upload progress — but without the multipart path: a build file's
 * key is minted by the build route and the PUT goes straight to storage.
 */
export function putToStorage(
	url: string,
	file: File,
	headers: Record<string, string>,
	onPercent: (p: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
		});
		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) resolve();
			else reject(new Error(`Upload failed with status ${xhr.status}`));
		});
		xhr.addEventListener("error", () => reject(new Error("Upload failed")));
		xhr.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
		signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(file);
	});
}

/**
 * POST one file to the build route's direct endpoint (local dev), with progress. Mirrors
 * `upload.ts`'s `xhrUploadFormData`: XHR because fetch has no upload progress, which also
 * means it bypasses `apiFetch`, so the base URL and credentials are resolved the same way
 * `apiFetch` would.
 */
export function directBuildUpload(
	path: string,
	file: File,
	buildPath: string,
	onPercent: (p: number) => void,
	signal?: AbortSignal,
): Promise<{ key: string }> {
	return new Promise((resolve, reject) => {
		const form = new FormData();
		form.append("file", file);
		form.append("path", buildPath);
		const xhr = new XMLHttpRequest();
		const full = path.startsWith("/") ? `${apiBaseUrl()}${path}` : path;
		xhr.open("POST", full);
		xhr.withCredentials = apiSendsCookies();
		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
		});
		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
			else reject(new Error(`Upload failed with status ${xhr.status}`));
		});
		xhr.addEventListener("error", () => reject(new Error("Upload failed")));
		xhr.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
		signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(form);
	});
}

const defaultTransport: WebBuildUploadTransport = {
	async create(workId, input) {
		const res = await client.api["web-builds"].works[":id"]["web-build"].$post({
			param: { id: String(workId) },
			json: {
				entryPath: input.entryPath,
				requiresIsolation: input.requiresIsolation,
				label: input.label ?? "",
			},
		});
		if (!res.ok) throw new Error("The build couldn't be started. Try again.");
		const { build } = (await res.json()) as { build: { id: number } };
		return build.id;
	},
	async put(workId, buildId, { path, file }, onProgress, signal) {
		const presign = await client.api["web-builds"].works[":id"]["web-build"][
			":buildId"
		].presign.$post({
			param: { id: String(workId), buildId: String(buildId) },
			json: { path, contentType: file.type || "application/octet-stream" },
		});
		if (!presign.ok) throw new Error(`Could not get an upload URL for ${path}.`);
		const info = (await presign.json()) as {
			method: "presigned" | "direct";
			uploadUrl: string;
			headers?: Record<string, string>;
			key: string;
		};
		if (info.method === "presigned") {
			await putToStorage(info.uploadUrl, file, info.headers ?? {}, onProgress, signal);
		} else {
			// Local dev: POST the bytes to the build route's direct endpoint.
			const body = await directBuildUpload(info.uploadUrl, file, path, onProgress, signal);
			info.key = body.key;
		}
		return {
			path,
			storageRef: info.key,
			fileSize: file.size,
			contentType: file.type || "",
		};
	},
	async register(workId, buildId, files) {
		const res = await client.api["web-builds"].works[":id"]["web-build"][":buildId"].files.$post({
			param: { id: String(workId), buildId: String(buildId) },
			json: { files },
		});
		if (!res.ok)
			throw new Error("The files uploaded, but the build couldn't be told they arrived.");
	},
	async complete(workId, buildId, input) {
		const res = await client.api["web-builds"].works[":id"]["web-build"][":buildId"].complete.$post(
			{
				param: { id: String(workId), buildId: String(buildId) },
				json: { entryPath: input.entryPath, label: input.label || undefined },
			},
		);
		if (!res.ok)
			throw new Error("The files uploaded, but the build couldn't be closed. Try again.");
	},
};

interface Entry {
	state: WebBuildUpload;
	pick: WebBuildPick;
	input: WebBuildUploadInput;
	controller: AbortController;
}

export interface WebBuildUploadStore {
	start(workId: number, pick: WebBuildPick, input: WebBuildUploadInput): string;
	/** Abort an in-flight build's upload and forget it — the creator's cancel. */
	cancel(uploadId: string): void;
	dismiss(uploadId: string): void;
	list(): readonly WebBuildUpload[];
	/** True while any build would be lost by leaving the page. */
	active(): boolean;
	subscribe(listener: () => void): () => void;
}

export function createWebBuildUploadStore(transport: WebBuildUploadTransport): WebBuildUploadStore {
	const entries = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	let snapshot: readonly WebBuildUpload[] = [];
	let seq = 0;

	const emit = () => {
		snapshot = [...entries.values()].map((e) => e.state);
		for (const listener of listeners) listener();
	};

	const update = (id: string, changes: Partial<WebBuildUpload>) => {
		const entry = entries.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, ...changes };
		emit();
	};

	const updateFile = (id: string, path: string, changes: Partial<WebBuildUploadFile>) => {
		const entry = entries.get(id);
		if (!entry) return;
		entry.state = {
			...entry.state,
			files: entry.state.files.map((f) => (f.path === path ? { ...f, ...changes } : f)),
		};
		emit();
	};

	const run = async (id: string) => {
		const entry = entries.get(id);
		if (!entry) return;
		const { pick, input, controller } = entry;
		let buildId: number;
		try {
			buildId = await transport.create(entry.state.workId, input, controller.signal);
		} catch (err) {
			update(id, {
				status: "failed",
				error: err instanceof Error ? err.message : "The build couldn't be started. Try again.",
			});
			return;
		}
		if (!entries.get(id)) return;
		const refs: BuildFileRef[] = [];
		for (const file of pick.files) {
			// A cancel that arrived while a file was on the wire is final: the entry is
			// gone, and the run stops before sending a file its creator stopped.
			if (!entries.get(id)) return;
			try {
				const ref = await transport.put(
					entry.state.workId,
					buildId,
					file,
					(percent) => updateFile(id, file.path, { percent }),
					controller.signal,
				);
				refs.push(ref);
				updateFile(id, file.path, { percent: 100, done: true });
			} catch (err) {
				update(id, {
					status: "failed",
					error:
						err instanceof Error
							? `${file.path}: ${err.message}`
							: `${file.path} didn't finish uploading. Check your connection and try again.`,
				});
				return;
			}
		}
		if (!entries.get(id)) return;
		update(id, { status: "registering" });
		try {
			await transport.register(entry.state.workId, buildId, refs, controller.signal);
			if (!entries.get(id)) return;
			await transport.complete(entry.state.workId, buildId, input, controller.signal);
			update(id, { status: "done" });
		} catch (err) {
			update(id, {
				status: "failed",
				error:
					err instanceof Error
						? err.message
						: "The files uploaded, but the build couldn't be finished. Try again.",
			});
		}
	};

	return {
		start(workId, pick, input) {
			seq += 1;
			const id = `web-build-${seq}`;
			entries.set(id, {
				pick,
				input,
				controller: new AbortController(),
				state: {
					id,
					workId,
					entryPath: input.entryPath,
					requiresIsolation: input.requiresIsolation,
					status: "uploading",
					files: pick.files.map((f) => ({
						path: f.path,
						size: f.file.size,
						percent: 0,
						done: false,
					})),
					error: null,
				},
			});
			emit();
			void run(id);
			return id;
		},
		cancel(uploadId) {
			const entry = entries.get(uploadId);
			if (!entry) return;
			if (entry.state.status !== "uploading" && entry.state.status !== "registering") return;
			// Aborting first, then forgetting: the run's rejected promise lands on an entry
			// that is already gone, so nothing marks it failed over the creator's own stop.
			entry.controller.abort();
			entries.delete(uploadId);
			emit();
		},
		dismiss(uploadId) {
			if (entries.delete(uploadId)) emit();
		},
		list: () => snapshot,
		active: () => snapshot.some((u) => u.status === "uploading" || u.status === "registering"),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** The one store the app uses. */
export const webBuildUploads = createWebBuildUploadStore(defaultTransport);

// Leaving the page abandons whatever is still going up, and the open build row is the cost.
if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", (event) => {
		if (!webBuildUploads.active()) return;
		event.preventDefault();
		event.returnValue = "";
	});
}

/** Every hosted build upload this tab has started, in the order they were started. */
export function useWebBuildUploads(): readonly WebBuildUpload[] {
	return useSyncExternalStore(
		webBuildUploads.subscribe,
		webBuildUploads.list,
		webBuildUploads.list,
	);
}
