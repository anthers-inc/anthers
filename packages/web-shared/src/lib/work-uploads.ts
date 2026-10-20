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
 *
 * ⭐ **A set-kind Work's later files ride this store too, as a pick** (2026-10-19). A comic's page
 * images, a book's PDF beside its first file and a gallery's extra pictures are *additive*: each
 * is its own `set-row` entry, and the files beyond the first wait in a batch so they go up one at
 * a time rather than as thirty concurrent digest reads and part uploads. The batch is what makes
 * the pick outlive the page that started it and gives the tab's unload guard something to count,
 * and it is the reason this file is the one place a source set's progress lives.
 */

import {
	type FILE_WORK_TYPES,
	hasSourceSet,
	isPaged,
	processingFor,
} from "@anthers/shared/content";
import { useMemo, useSyncExternalStore } from "react";
import { uploadImageFile } from "../components/post/mediaUpload";
import { client } from "./rpc";
import { uploadMediaFile } from "./upload";

/** Where an uploaded file goes once it has arrived. */
export type WorkUploadTarget =
	/** The Work's own file — what a video, a track, an image or a book IS. */
	| { kind: "source"; type: (typeof FILE_WORK_TYPES)[number] }
	/**
	 * A row appended to a set-kind Work's source set: a comic's page image, a book's PDF or
	 * EPUB past its first file, one picture in a gallery. 🚨 **Additive by construction** —
	 * several rows coexist, so the one-source-per-Work replacement below is keyed to `source`
	 * alone and never sees these.
	 */
	| { kind: "set-row"; type: (typeof FILE_WORK_TYPES)[number] }
	/** A downloadable build for a game or software Work, which becomes its primary download. */
	| { kind: "build"; platform: string };

/** The additive target: a file joining a set-kind Work's source set. */
export type WorkUploadSetRowTarget = Extract<WorkUploadTarget, { kind: "set-row" }>;

/**
 * `uploading` is bytes on the wire, `attaching` is telling the Work the file is there, `done`
 * is attached, and `failed` holds the file so the creator can retry without picking it again.
 */
export type WorkUploadStatus = "uploading" | "attaching" | "done" | "failed";

export interface WorkUpload {
	id: string;
	workId: number;
	fileName: string;
	/** The file's size, so a row can name what is travelling without reading it again. */
	fileSize: number;
	target: WorkUploadTarget;
	status: WorkUploadStatus;
	/** Whole percent, or `null` where the transport reports no progress (an image goes up in one request). */
	progress: number | null;
	/** What went wrong, as a sentence a creator can read. */
	error: string | null;
	/**
	 * The multi-file pick this file was added in, in the order the creator picked it — `null`
	 * for a lone upload. The pick itself (what has not started) lives in {@link WorkUploadBatch}.
	 */
	batch: { id: string; index: number; total: number } | null;
}

/**
 * A pick that has not finished: the files beyond the one on the wire, held so an add of a
 * hundred pages survives a glance at the Catalog and one failure does not swallow the rest.
 *
 * ⚠️ **It runs in order, one file at a time.** An entry appears only when its turn comes, so
 * `list()` never shows files the wire has not touched yet; that is what keeps `processingQueue`
 * and the progress rows honest.
 */
export interface WorkUploadBatch {
	id: string;
	workId: number;
	target: WorkUploadTarget;
	total: number;
	/** Files that have not started yet. */
	waiting: number;
	/** The file the pick stopped at after a failure, with the rest held behind it. */
	held: string | null;
}

/** How a file reaches storage and then its Work. Swappable so the store can be tested without a network. */
export interface WorkUploadTransport {
	/** Send the bytes; resolves to the stored key. Progress of `null` is honest — a
	 * transport reading the file before sending (the session's digest pass) reports no
	 * percent yet, and the caller renders its indeterminate bar. The signal aborts the
	 * send — a canceled upload stops spending the wire, and may leave its session open
	 * for the sweeper, exactly as a tab close would. */
	put(
		file: File,
		target: WorkUploadTarget,
		onProgress: (percent: number | null) => void,
		signal?: AbortSignal,
	): Promise<string>;
	/** Tell the Work its file has arrived. */
	attach(
		workId: number,
		target: WorkUploadTarget,
		key: string,
		file: File,
		signal?: AbortSignal,
	): Promise<void>;
}

const defaultTransport: WorkUploadTransport = {
	async put(file, target, onProgress, signal) {
		if (target.kind !== "build" && target.type === "image") {
			return (await uploadImageFile(file, "image", signal)).url;
		}
		const processing = target.kind === "source" ? processingFor(target.type) : null;
		const mediaType = processing === "video" || processing === "audio" ? processing : "asset";
		return uploadMediaFile(file, mediaType, onProgress, signal);
	},
	// ⚠️ The attach ignores its signal on purpose: it is the narrow single-field write
	// that follows a completed upload, sub-second by construction. A cancel landing in
	// its window stops the store from tracking the entry, and the run's own completion
	// writes land on a forgotten entry — the honest shape of a cancel that arrives a
	// breath after the bytes did.
	async attach(workId, target, key, file, _signal) {
		const param = { id: String(workId) };
		// 🚨 A set-kind Work's file attaches as a ROW of its source set (Parker, 2026-10-10;
		// the image kind joins it, 2026-10-18) — the route carries the filename, size and
		// mime a `source_key` PATCH cannot, and the set is the row-level truth for these
		// kinds; the service keeps the legacy column following the set — a paged set at its
		// newest file, an image set at its first. The other kinds' attach stays the legacy
		// column patch.
		const res =
			target.kind === "set-row" || (target.kind === "source" && hasSourceSet(target.type))
				? await client.api.content.works[":id"]["source-files"].$post({
						param,
						json: {
							file: key,
							filename: file.name,
							fileSize: file.size,
							mimeType: file.type || (isPaged(target.type) ? "application/pdf" : "image"),
						},
					})
				: target.kind === "source"
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
		if (res.ok) return;
		// The server's refusal is the sentence a creator needs — a set that mixes an EPUB with
		// page images says so — so it travels as the attach's message rather than a status code
		// the store could only turn back into something vaguer.
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(
			body?.error ||
				`${file.name} uploaded, but the Work couldn't be told it had arrived. Check your connection and try again.`,
		);
	},
};

interface Entry {
	state: WorkUpload;
	file: File;
	/** Set once the bytes have arrived, so a failed attach retries the attach alone. */
	key: string | null;
	/** The run's own abort. A cancel aborts what is on the wire and forgets the entry. */
	controller: AbortController;
}

/** A pick still in flight: the files whose turn has not come, and the one that went wrong. */
interface Batch {
	id: string;
	workId: number;
	target: WorkUploadSetRowTarget;
	files: File[];
	/** Index of the next file to start; equal to `files.length` once every file has begun. */
	next: number;
	/** The entry on the wire, or the failed one the pick is held on. */
	current: string | null;
	stopped: boolean;
}

export interface WorkUploadStore {
	start(workId: number, file: File, target: WorkUploadTarget): string;
	/**
	 * Start a pick: one entry per file, in the order given, each beginning as the one before it
	 * settles. A failure holds the pick at that file while files remain behind it — its retry
	 * resumes from there, and a skip (`dismiss`) moves on. A failure on the pick's last file
	 * ends the pick, and the failed entry stays as its own row.
	 */
	startBatch(workId: number, files: File[], target: WorkUploadSetRowTarget): string;
	retry(uploadId: string): void;
	/** Forget an entry — a settled row's dismissal, or the skip past a file a pick is held on. */
	dismiss(uploadId: string): void;
	/** Abort an in-flight upload and forget it — the creator's cancel, not a retry. */
	cancel(uploadId: string): void;
	/** Stop a pick: abort the file on the wire and drop the files that have not started. */
	cancelBatch(batchId: string): void;
	list(): readonly WorkUpload[];
	listBatches(): readonly WorkUploadBatch[];
	/** True while any upload would be lost by leaving the page. */
	active(): boolean;
	subscribe(listener: () => void): () => void;
}

export function createWorkUploadStore(transport: WorkUploadTransport): WorkUploadStore {
	const entries = new Map<string, Entry>();
	const batches = new Map<string, Batch>();
	const listeners = new Set<() => void>();
	// `useSyncExternalStore` compares snapshots by reference, so the lists are rebuilt only on a
	// change and handed out unchanged otherwise.
	let snapshot: readonly WorkUpload[] = [];
	let batchSnapshot: readonly WorkUploadBatch[] = [];
	let seq = 0;
	let batchSeq = 0;

	const emit = () => {
		snapshot = [...entries.values()].map((e) => e.state);
		batchSnapshot = [...batches.values()].map((batch) => {
			const current = batch.current ? entries.get(batch.current) : undefined;
			return {
				id: batch.id,
				workId: batch.workId,
				target: batch.target,
				total: batch.files.length,
				waiting: batch.stopped ? 0 : batch.files.length - batch.next,
				held: current?.state.status === "failed" ? current.state.fileName : null,
			};
		});
		for (const listener of listeners) listener();
	};

	const update = (id: string, changes: Partial<WorkUpload>) => {
		const entry = entries.get(id);
		if (!entry) return;
		// A change that leaves the state where it already was must not rebuild the
		// snapshot: the direct-upload path's XHR speaks dozens of times a second, and only
		// a few of those events move the whole percent.
		const moved = (Object.keys(changes) as Array<keyof WorkUpload>).some(
			(key) => entry.state[key] !== changes[key],
		);
		if (!moved) return;
		entry.state = { ...entry.state, ...changes };
		emit();
	};

	const createEntry = (
		workId: number,
		file: File,
		target: WorkUploadTarget,
		batch: WorkUpload["batch"],
	): string => {
		seq += 1;
		const id = `upload-${seq}`;
		entries.set(id, {
			file,
			key: null,
			controller: new AbortController(),
			state: {
				id,
				workId,
				fileName: file.name,
				fileSize: file.size,
				target,
				status: "uploading",
				progress: target.kind !== "build" && target.type === "image" ? null : 0,
				error: null,
				batch,
			},
		});
		return id;
	};

	/**
	 * Move a pick past the file that just settled, or hold it where it failed.
	 *
	 * A failure leaves the entry as the pick's `current`, so `held` names it and `waiting` still
	 * counts the rest; a retry that succeeds settles again as `done` and starts the next file.
	 */
	const settle = (
		batchId: string | undefined,
		uploadId: string,
		outcome: "done" | "failed" | "canceled",
	) => {
		const batch = batchId ? batches.get(batchId) : undefined;
		if (!batch || batch.current !== uploadId) return;
		if (outcome === "failed") {
			// Nothing left to hold behind it means the pick is over: the failed entry stays as its
			// own row (with the retry the creator may still want), and the Work is free again.
			if (batch.next >= batch.files.length) batches.delete(batch.id);
			emit();
			return;
		}
		batch.current = null;
		startNext(batch);
	};

	const startNext = (batch: Batch) => {
		if (batch.stopped) return;
		if (batch.next >= batch.files.length) {
			// Every file has begun and the last has settled, so the pick is over and its files
			// need not stay held. The finished entries remain in `list()` as the tab's record.
			batches.delete(batch.id);
			emit();
			return;
		}
		const index = batch.next;
		batch.next += 1;
		const id = createEntry(batch.workId, batch.files[index], batch.target, {
			id: batch.id,
			index: index + 1,
			total: batch.files.length,
		});
		batch.current = id;
		emit();
		void run(id);
	};

	const run = async (id: string) => {
		const entry = entries.get(id);
		if (!entry) return;
		const { file, state, controller } = entry;
		const batch = state.batch?.id;
		if (entry.key == null) {
			update(id, { status: "uploading", error: null });
			try {
				entry.key = await transport.put(
					file,
					state.target,
					(percent) => update(id, { progress: percent }),
					controller.signal,
				);
			} catch {
				// A canceled run lands here because it aborted itself; the entry is already
				// gone, so there is no state left to mark failed.
				update(id, {
					status: "failed",
					error: `${file.name} didn't finish uploading. Check your connection and try again.`,
				});
				settle(batch, id, "failed");
				return;
			}
		}
		// 🚨 A cancel that arrived while the wire was still speaking is final: the entry is
		// gone, and the run that was awaiting it stops here rather than attaching what its
		// creator told it to stop. (The orphaned key the late upload leaves is the same
		// shape a closed tab leaves; the session sweeper is what reclaims those.)
		if (!entries.get(id)) return;
		update(id, { status: "attaching", error: null });
		try {
			await transport.attach(state.workId, state.target, entry.key, file, controller.signal);
			update(id, { status: "done", progress: 100 });
			settle(batch, id, "done");
		} catch (error) {
			// The transport carries the server's own refusal through; anything it could not put
			// into words is the settled sentence, since the bytes did arrive.
			update(id, {
				status: "failed",
				error:
					error instanceof Error && error.message
						? error.message
						: `${file.name} uploaded, but the Work couldn't be told it had arrived. Try again.`,
			});
			settle(batch, id, "failed");
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
			const id = createEntry(workId, file, target, null);
			emit();
			void run(id);
			return id;
		},
		startBatch(workId, files, target) {
			if (files.length === 0) return "";
			batchSeq += 1;
			const batch: Batch = {
				id: `batch-${batchSeq}`,
				workId,
				target,
				files: [...files],
				next: 0,
				current: null,
				stopped: false,
			};
			batches.set(batch.id, batch);
			emit();
			startNext(batch);
			return batch.id;
		},
		retry(uploadId) {
			if (entries.get(uploadId)?.state.status === "failed") void run(uploadId);
		},
		dismiss(uploadId) {
			const entry = entries.get(uploadId);
			if (!entry) return;
			const batch = entry.state.batch?.id;
			const current = batch ? batches.get(batch)?.current === uploadId : false;
			entries.delete(uploadId);
			emit();
			// Skipping the file a pick is held on lets the rest of the add continue.
			const held = batch ? batches.get(batch) : undefined;
			if (current && held) {
				held.current = null;
				startNext(held);
			}
		},
		cancel(uploadId) {
			const entry = entries.get(uploadId);
			if (!entry) return;
			if (entry.state.status !== "uploading" && entry.state.status !== "attaching") return;
			const batch = entry.state.batch?.id;
			// Aborting first, then forgetting: the run's rejected promise lands on an entry
			// that is already gone, so nothing marks it failed over the creator's own stop.
			entry.controller.abort();
			entries.delete(uploadId);
			emit();
			// A canceled file is a deletion rather than a failure: the pick moves on to the next.
			settle(batch, uploadId, "canceled");
		},
		cancelBatch(batchId) {
			const batch = batches.get(batchId);
			if (!batch) return;
			batch.stopped = true;
			batches.delete(batchId);
			if (batch.current) {
				const live = entries.get(batch.current);
				if (live && (live.state.status === "uploading" || live.state.status === "attaching")) {
					live.controller.abort();
					entries.delete(live.state.id);
				}
			}
			emit();
		},
		list: () => snapshot,
		listBatches: () => batchSnapshot,
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

/** Every multi-file pick this tab is still working through. */
export function useWorkBatches(): readonly WorkUploadBatch[] {
	return useSyncExternalStore(
		workUploads.subscribe,
		workUploads.listBatches,
		workUploads.listBatches,
	);
}

/** The set-row pick running on one Work in this tab, or null when nothing is being added. */
export function useSetRowBatch(workId: number): WorkUploadBatch | null {
	const batches = useWorkBatches();
	return useMemo(
		() => batches.find((b) => b.workId === workId && b.target.kind === "set-row") ?? null,
		[batches, workId],
	);
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
