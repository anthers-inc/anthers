// SPDX-License-Identifier: Apache-2.0
/**
 * The files going up into Works that already exist — held outside React, so an upload outlives
 * the page that started it.
 *
 * 🚨 **A Work is created the moment its file is picked, and the file follows** (Parker,
 * 2026-09-16). The Upload page makes the Work and moves the creator straight to its Edit page
 * while the bytes are still travelling, which is what lets somebody fill in a Work's details
 * during a long video upload instead of watching a progress bar. So the upload cannot belong to
 * the page it started on, and it cannot belong to any page: a creator may go on to the Catalog,
 * write a post, or open Settings for payout setup, and every one of those unmounts the component
 * that started it.
 *
 * ⭐ **A module rather than a context provider, deliberately.** A provider would have to be
 * mounted above every route a creator can reach mid-upload, which is a claim about the router
 * that goes stale the day a route moves. A module is mounted by being imported, survives any
 * navigation inside the app, and is subscribed to with `useSyncExternalStore`.
 *
 * ⚠️ **It does not survive the tab.** Reloading or closing it abandons the upload, which is why
 * a `beforeunload` warning is armed while anything is in flight, and why the Edit page has a
 * state for a Work whose file never arrived — that Work is real and private, and a release of it
 * is refused (`media_missing`) until its file is uploaded again.
 *
 * The file is attached with its own narrow request — `sourceKey` alone, or a build's asset row —
 * rather than by the form the creator is editing. The Work's page saves its fields while this is
 * running, and a whole-form save carrying an empty `sourceKey` would erase a file that arrived a
 * moment earlier.
 */

import { type FILE_WORK_TYPES, processingFor } from "@anthers/shared/content";
import { useMemo, useSyncExternalStore } from "react";
import { uploadImageFile } from "../components/post/mediaUpload";
import { client } from "./rpc";
import { uploadMediaFile } from "./upload";

/** Where an uploaded file goes once it has arrived. */
export type WorkUploadTarget =
	/** The Work's own file — what a video, a track, an image or a book IS. */
	| { kind: "source"; type: (typeof FILE_WORK_TYPES)[number] }
	/** A downloadable build for a game or software Work, which becomes its primary download. */
	| { kind: "build"; platform: string };

/**
 * `uploading` is bytes on the wire, `attaching` is telling the Work the file is there, `done`
 * is attached, and `failed` holds the file so the creator can retry without picking it again.
 */
export type WorkUploadStatus = "uploading" | "attaching" | "done" | "failed";

export interface WorkUpload {
	id: string;
	workId: number;
	fileName: string;
	target: WorkUploadTarget;
	status: WorkUploadStatus;
	/** Whole percent, or `null` where the transport reports no progress (an image goes up in one request). */
	progress: number | null;
	/** What went wrong, as a sentence a creator can read. */
	error: string | null;
}

/** How a file reaches storage and then its Work. Swappable so the store can be tested without a network. */
export interface WorkUploadTransport {
	/** Send the bytes; resolves to the stored key. */
	put(file: File, target: WorkUploadTarget, onProgress: (percent: number) => void): Promise<string>;
	/** Tell the Work its file has arrived. */
	attach(workId: number, target: WorkUploadTarget, key: string, file: File): Promise<void>;
}

const defaultTransport: WorkUploadTransport = {
	async put(file, target, onProgress) {
		if (target.kind === "source" && target.type === "image") {
			return (await uploadImageFile(file, "image")).url;
		}
		const processing = target.kind === "source" ? processingFor(target.type) : null;
		const mediaType = processing === "video" || processing === "audio" ? processing : "asset";
		return uploadMediaFile(file, mediaType, onProgress);
	},
	async attach(workId, target, key, file) {
		const param = { id: String(workId) };
		const res =
			target.kind === "source"
				? await client.api.content.works[":id"].$patch({ param, json: { sourceKey: key } })
				: await client.api.content.works[":id"].assets.$post({
						param,
						json: {
							file: key,
							filename: file.name,
							fileSize: file.size,
							mimeType: file.type || "application/octet-stream",
							platform: target.platform,
							version: "",
							isPrimary: true,
						},
					});
		if (!res.ok) throw new Error(`attach answered ${res.status}`);
	},
};

interface Entry {
	state: WorkUpload;
	file: File;
	/** Set once the bytes have arrived, so a failed attach retries the attach alone. */
	key: string | null;
}

export interface WorkUploadStore {
	start(workId: number, file: File, target: WorkUploadTarget): string;
	retry(uploadId: string): void;
	dismiss(uploadId: string): void;
	list(): readonly WorkUpload[];
	/** True while any upload would be lost by leaving the page. */
	active(): boolean;
	subscribe(listener: () => void): () => void;
}

export function createWorkUploadStore(transport: WorkUploadTransport): WorkUploadStore {
	const entries = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	// `useSyncExternalStore` compares snapshots by reference, so the list is rebuilt only on a
	// change and handed out unchanged otherwise.
	let snapshot: readonly WorkUpload[] = [];
	let seq = 0;

	const emit = () => {
		snapshot = [...entries.values()].map((e) => e.state);
		for (const listener of listeners) listener();
	};

	const update = (id: string, changes: Partial<WorkUpload>) => {
		const entry = entries.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, ...changes };
		emit();
	};

	const run = async (id: string) => {
		const entry = entries.get(id);
		if (!entry) return;
		const { file, state } = entry;
		if (entry.key == null) {
			update(id, { status: "uploading", error: null });
			try {
				entry.key = await transport.put(file, state.target, (percent) =>
					update(id, { progress: percent }),
				);
			} catch {
				update(id, {
					status: "failed",
					error: `${file.name} didn't finish uploading. Check your connection and try again.`,
				});
				return;
			}
		}
		update(id, { status: "attaching", error: null });
		try {
			await transport.attach(state.workId, state.target, entry.key, file);
			update(id, { status: "done", progress: 100 });
		} catch {
			update(id, {
				status: "failed",
				error: `${file.name} uploaded, but the Work couldn't be told it had arrived. Try again.`,
			});
		}
	};

	return {
		start(workId, file, target) {
			// One file per Work at a time: a new pick replaces an earlier upload of the Work's own
			// file that is not still running. A build is additive, so it replaces nothing.
			if (target.kind === "source") {
				for (const [id, entry] of entries) {
					if (
						entry.state.workId === workId &&
						entry.state.target.kind === "source" &&
						(entry.state.status === "failed" || entry.state.status === "done")
					) {
						entries.delete(id);
					}
				}
			}
			seq += 1;
			const id = `upload-${seq}`;
			entries.set(id, {
				file,
				key: null,
				state: {
					id,
					workId,
					fileName: file.name,
					target,
					status: "uploading",
					progress: target.kind === "source" && target.type === "image" ? null : 0,
					error: null,
				},
			});
			emit();
			void run(id);
			return id;
		},
		retry(uploadId) {
			if (entries.get(uploadId)?.state.status === "failed") void run(uploadId);
		},
		dismiss(uploadId) {
			if (entries.delete(uploadId)) emit();
		},
		list: () => snapshot,
		active: () => snapshot.some((u) => u.status === "uploading" || u.status === "attaching"),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** The one store the app uses. */
export const workUploads = createWorkUploadStore(defaultTransport);

// Leaving the page abandons whatever is still going up, and a Work left behind with no file is
// the cost. The browser shows its own wording; setting `returnValue` is what asks it to.
if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", (event) => {
		if (!workUploads.active()) return;
		event.preventDefault();
		event.returnValue = "";
	});
}

/** Every upload this tab has started, in the order they were started. */
export function useWorkUploads(): readonly WorkUpload[] {
	return useSyncExternalStore(workUploads.subscribe, workUploads.list, workUploads.list);
}

/** The latest upload of one Work's own file, or null when this tab has not uploaded one. */
export function useSourceUpload(workId: number | undefined): WorkUpload | null {
	const all = useWorkUploads();
	return useMemo(() => {
		const mine = all.filter((u) => u.workId === workId && u.target.kind === "source");
		return mine[mine.length - 1] ?? null;
	}, [all, workId]);
}

/** Whether an upload is still on its way. */
export function isUploading(upload: WorkUpload | null | undefined): boolean {
	return upload?.status === "uploading" || upload?.status === "attaching";
}
