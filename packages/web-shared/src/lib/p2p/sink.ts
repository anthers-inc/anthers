// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a P2P download's bytes actually go.
 *
 * The engine in `download.ts` decides *which* chunks to pull, from whom, and whether they
 * verify. It must not also know how a browser stores a multi-gigabyte file, because that
 * answer differs per engine and is the part most likely to change. So the engine writes
 * through this interface, and the two implementations below are the whole of the storage
 * story: an in-memory one for small files and tests, and an OPFS one for real downloads.
 *
 * ── Why the OPFS sink runs in a Worker ──────────────────────────────────────────────
 *
 * **Verified against MDN's browser-compat-data on 2026-08-10** (read the BCD JSON — MDN's
 * compat tables render client-side, so fetching the page shows you nothing):
 *
 *   OPFS root, `navigator.storage.getDirectory()` ......  Chrome 86 · Firefox 111 · Safari 15.2
 *   `createSyncAccessHandle()`, Worker-only ............  Chrome 102 · Firefox 111 · Safari 15.2
 *   `createWritable()`, main thread ....................  Chrome 86 · Firefox 111 · Safari **26**
 *   `showSaveFilePicker()` .............................  Chrome 86 · Firefox **never** · Safari **never**
 *
 * The obvious implementation is main-thread `createWritable()`, and it is the one that
 * silently excludes every Safari before 26. Sync access handles go back to Safari 15.2 and
 * exist in every engine, so **the portable write path is a Worker** — which is also where
 * per-chunk SHA-256 over a multi-gigabyte file belongs regardless.
 *
 * ── Why the worker is a blob URL rather than a module ───────────────────────────────
 *
 * 🚨 **Bun's bundler does not follow `new Worker(new URL("./w.ts", import.meta.url))`.** It
 * emits that expression verbatim and never compiles or copies the target, so the built app
 * would request a `.ts` file that does not exist — a 404 in production and nothing in dev,
 * from code that looks correct and typechecks. Verified against `bun build` before this
 * file was written, not discovered later.
 *
 * The alternatives were a second build entrypoint (which every consuming app would have to
 * wire up, and which Bun's dev server does not read) or this: the worker source as a string,
 * instantiated from a blob URL. Blob workers inherit the page's origin, and no app here
 * sets a CSP, so `worker-src` does not block it. The cost is that the worker body is not
 * typechecked — paid down by keeping it as close to nothing as possible. It opens a handle,
 * writes at an offset, and closes. Every decision worth testing is in `download.ts`.
 */

/** Where the engine puts verified bytes. Offsets are absolute within the finished file. */
export interface DownloadSink {
	/** Write `bytes` at `offset`. Chunks may arrive out of order. */
	write(offset: number, bytes: Uint8Array): Promise<void>;
	/**
	 * Flush and hand back the finished file — or `null` when the sink has already put it
	 * where the user wanted it and there is nothing left to hand over.
	 *
	 * That second case is `FileSystemSink`, which writes straight to a location the user
	 * picked. Returning a Blob there would mean materialising a file that is already on
	 * disk, purely to satisfy a return type.
	 */
	finish(): Promise<Blob | null>;
	/** Release everything without producing a file — cancellation and failure both land here. */
	abort(): Promise<void>;
}

/**
 * The whole file in memory.
 *
 * Correct for small assets and for tests, and wrong for the case this feature exists to
 * serve — hence the explicit ceiling rather than a silent one. A 40 GB game assembled here
 * would take the tab down, and "the tab crashed" is a far worse diagnosis to hand a user
 * than "this file is too large for this path".
 */
export class MemorySink implements DownloadSink {
	private readonly buffer: Uint8Array;
	private readonly mimeType: string;

	constructor(size: number, mimeType = "application/octet-stream") {
		this.buffer = new Uint8Array(size);
		this.mimeType = mimeType;
	}

	async write(offset: number, bytes: Uint8Array): Promise<void> {
		this.buffer.set(bytes, offset);
	}

	async finish(): Promise<Blob> {
		return new Blob([this.buffer as BufferSource], { type: this.mimeType });
	}

	async abort(): Promise<void> {
		// Nothing to release — the buffer is garbage once the sink is dropped.
	}
}

/**
 * The worker body. Deliberately tiny, because none of it is typechecked.
 *
 * Sync access handles are synchronous by design (that is the point — no await between the
 * seek and the write), which is exactly why they are Worker-only: the same calls on the
 * main thread would block paint.
 */
const WRITER_SOURCE = `
let handle = null;
self.onmessage = async (event) => {
	const msg = event.data;
	try {
		if (msg.t === "open") {
			const root = await navigator.storage.getDirectory();
			const dir = await root.getDirectoryHandle(msg.dir, { create: true });
			const file = await dir.getFileHandle(msg.name, { create: true });
			handle = await file.createSyncAccessHandle();
			// Truncate: a resumed or retried download must not inherit a previous run's tail.
			handle.truncate(0);
		} else if (msg.t === "write") {
			handle.write(msg.bytes, { at: msg.offset });
		} else if (msg.t === "close") {
			if (handle) { handle.flush(); handle.close(); handle = null; }
		}
		self.postMessage({ id: msg.id, ok: true });
	} catch (err) {
		self.postMessage({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
	}
};
`;

/**
 * Stream straight to a file the user chose. Chromium only, and the best sink when it exists.
 *
 * This is what makes "one architecture, not two" cost nothing in user experience. The old
 * signed-URL download streamed natively to disk; the P2P path assembles and then hands over
 * a blob, which is a second copy. `showSaveFilePicker` removes that step entirely — the
 * engine writes verified chunks directly into the user's file as they arrive, so the P2P
 * protocol carries the download and the destination is the one they picked.
 *
 * ⚠️ **It requires transient user activation**, so `showSaveFilePicker()` must be called
 * synchronously in the click handler, before any `await`. Awaiting the manifest first and
 * then asking would throw `SecurityError` — see `useP2pDownload`, which picks first and
 * fetches second for exactly this reason.
 *
 * Honest about the disk cost: Chrome implements a writable file stream with a swap file and
 * commits on close, so this is not guaranteed to be strictly single-copy. What it does
 * remove is the OPFS staging directory and the in-page blob hand-off, which were definitely
 * a second full copy plus a quota negotiation.
 */
export class FileSystemSink implements DownloadSink {
	private writable: FileSystemWritableFileStream | null = null;

	private constructor(private readonly handle: FileSystemFileHandle) {}

	/**
	 * Ask the user where to put the file. Returns null when the browser cannot, and
	 * rethrows an `AbortError` when the user cancels — those two must not be confused: one
	 * means "try another sink", the other means "the user said no".
	 */
	static async pick(filename: string): Promise<FileSystemSink | null> {
		const picker = (
			globalThis as {
				showSaveFilePicker?: (opts: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
			}
		).showSaveFilePicker;
		if (typeof picker !== "function") return null;
		const handle = await picker({ suggestedName: filename });
		return new FileSystemSink(handle);
	}

	async open(): Promise<void> {
		this.writable = await this.handle.createWritable({ keepExistingData: false });
	}

	async write(offset: number, bytes: Uint8Array): Promise<void> {
		// Positioned writes, because chunks arrive out of order.
		await this.writable?.write({ type: "write", position: offset, data: bytes as BufferSource });
	}

	async finish(): Promise<null> {
		await this.writable?.close();
		this.writable = null;
		// Already saved where the user asked. Nothing to hand back.
		return null;
	}

	async abort(): Promise<void> {
		try {
			await this.writable?.abort();
		} catch {
			// Already closed.
		}
		this.writable = null;
	}
}

/** True when this browser can stream a large download to origin-private storage. */
export function opfsAvailable(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.storage?.getDirectory === "function" &&
		typeof Worker !== "undefined"
	);
}

/**
 * Ask the browser to keep this origin's storage rather than evicting it under pressure.
 *
 * Best-effort and deliberately not fatal: a browser that refuses still completes the
 * download, it just might lose it if storage gets tight mid-pull. Refusing to start would
 * trade a small risk for a certain failure.
 */
export async function requestPersistence(): Promise<boolean> {
	try {
		if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
		if (await navigator.storage.persisted?.()) return true;
		return await navigator.storage.persist();
	} catch {
		return false;
	}
}

/** Streams into origin-private storage through the writer worker. */
export class OpfsSink implements DownloadSink {
	private worker: Worker | null = null;
	private blobUrl: string | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

	constructor(
		private readonly dir: string,
		private readonly name: string,
		private readonly mimeType: string,
	) {}

	async open(): Promise<void> {
		const blob = new Blob([WRITER_SOURCE], { type: "text/javascript" });
		this.blobUrl = URL.createObjectURL(blob);
		this.worker = new Worker(this.blobUrl);
		this.worker.onmessage = (event: MessageEvent) => {
			const { id, ok, error } = event.data as { id: number; ok: boolean; error?: string };
			const waiter = this.pending.get(id);
			if (!waiter) return;
			this.pending.delete(id);
			if (ok) waiter.resolve();
			else waiter.reject(new Error(error ?? "OPFS writer failed"));
		};
		await this.call({ t: "open", dir: this.dir, name: this.name });
	}

	async write(offset: number, bytes: Uint8Array): Promise<void> {
		// The buffer is TRANSFERRED, not copied: a structured clone of every chunk would
		// double the allocation on a path whose entire purpose is not holding the file.
		// The engine must therefore not touch `bytes` after handing it over — it doesn't.
		const copy = bytes.slice();
		await this.call({ t: "write", offset, bytes: copy }, [copy.buffer]);
	}

	async finish(): Promise<Blob> {
		await this.call({ t: "close" });
		this.teardown();
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle(this.dir);
		const fileHandle = await dir.getFileHandle(this.name);
		const file = await fileHandle.getFile();
		// A disk-backed File, so returning it does not read the download into memory. The
		// caller's blob URL hand-off does cost a second copy on disk while the browser
		// writes it to the user's Downloads — the price of `showSaveFilePicker` being
		// Chromium-only, and the reason a 40 GB game is a bad browser download everywhere.
		return file;
	}

	async abort(): Promise<void> {
		try {
			await this.call({ t: "close" });
		} catch {
			// Already gone; the removal below is what matters.
		}
		this.teardown();
		try {
			const root = await navigator.storage.getDirectory();
			const dir = await root.getDirectoryHandle(this.dir);
			await dir.removeEntry(this.name);
		} catch {
			// Nothing to remove.
		}
	}

	private call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
		const worker = this.worker;
		if (!worker) return Promise.reject(new Error("OPFS writer is not open"));
		const id = this.nextId++;
		return new Promise<void>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ ...message, id }, transfer);
		});
	}

	private teardown(): void {
		this.worker?.terminate();
		this.worker = null;
		if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
		this.blobUrl = null;
		for (const waiter of this.pending.values()) waiter.reject(new Error("writer closed"));
		this.pending.clear();
	}
}
