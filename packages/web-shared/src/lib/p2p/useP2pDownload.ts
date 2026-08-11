// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * React binding for the P2P download engine.
 *
 * The engine itself is framework-free and tested without React (`download.test.ts`); this
 * is only the part that turns its progress callbacks into state a component can render.
 * Keeping the split means the interesting logic never needs a component test to exercise.
 *
 * ── This is the ONLY download path, deliberately ───────────────────────────────────
 *
 * Parker, 2026-08-10: *"all downloads will use the P2P architecture, even if the Anthers
 * hub host is the only host. That way, we don't have to maintain two separate download
 * protocols."* That is 45.01 § 3's "one architecture, not two", and it is why there is no
 * signed-URL button beside this one any more.
 *
 * The concern that reading raised — that P2P assembles in origin-private storage and pays
 * a second copy on the way out, where a signed URL streamed natively to disk — turns out
 * to be about the **sink**, not the protocol. `showSaveFilePicker` writes verified chunks
 * straight into a file the user chose, over the same P2P transport. So the choice is not
 * "one protocol or good UX"; it is one protocol with the best available destination:
 *
 *   1. `FileSystemSink`  — Chromium. Straight to the user's chosen file, no staging copy.
 *   2. `OpfsSink`        — everywhere else. Stages in origin-private storage, then hands
 *                          over a blob. Costs 2x disk during that final copy, which is the
 *                          price of `showSaveFilePicker` being Chromium-only.
 *   3. `MemorySink`      — no OPFS at all, and only under a hard size ceiling.
 *
 * ⚠️ **The picker must be called before any `await`.** It needs transient user activation,
 * so fetching the manifest first and then asking would throw `SecurityError`. `start()`
 * therefore picks first and fetches second, which is why it cannot use the manifest's size
 * to decide whether to bother asking.
 *
 * What P2P buys beyond not maintaining two protocols: every chunk is **verified against
 * the manifest** rather than trusted for coming from our CDN, and once the swarm is warm,
 * peer-served bytes **cost Anthers nothing** (45.01 § 6).
 */

import { useCallback, useRef, useState } from "react";
import {
	AccessError,
	type DownloadProgress,
	downloadAsset,
	IntegrityError,
	saveBlob,
} from "./download.js";
import {
	type DownloadSink,
	FileSystemSink,
	MemorySink,
	OpfsSink,
	opfsAvailable,
	requestPersistence,
} from "./sink.js";

/** Above this, assembling in memory is not acceptable and OPFS is required. */
const MEMORY_SINK_CEILING = 256 * 1024 * 1024;

export type P2pDownloadState = "idle" | "starting" | "downloading" | "done" | "error";

export interface UseP2pDownload {
	state: P2pDownloadState;
	progress: DownloadProgress | null;
	error: string | null;
	/** Fraction 0–1, or null before the manifest arrives. */
	fraction: number | null;
	start(): Promise<void>;
	cancel(): void;
}

export function useP2pDownload(params: {
	workId: number | string;
	assetId: number;
	filename: string;
	mimeType?: string;
}): UseP2pDownload {
	const [state, setState] = useState<P2pDownloadState>("idle");
	const [progress, setProgress] = useState<DownloadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const cancel = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setState("idle");
		setProgress(null);
	}, []);

	const start = useCallback(async () => {
		setError(null);
		setState("starting");
		const controller = new AbortController();
		abortRef.current = controller;

		let sink: DownloadSink | null = null;
		try {
			// ⚠️ The picker FIRST, before any await — it needs transient user activation, and
			// awaiting the manifest would spend it. That is why the sink is chosen without
			// knowing the file's size: the cost of asking is a dialog, and the cost of not
			// asking is a staging copy of a multi-gigabyte file.
			let picked: FileSystemSink | null = null;
			try {
				picked = await FileSystemSink.pick(params.filename);
			} catch (err) {
				// A cancelled picker is the user declining the download, not a reason to fall
				// through to a worse sink and download it anyway.
				if (err instanceof DOMException && err.name === "AbortError") {
					setState("idle");
					return;
				}
				picked = null;
			}

			const { fetchManifest } = await import("./download.js");
			const { manifest } = await fetchManifest(params.workId, params.assetId);
			const mimeType = params.mimeType ?? manifest.assetMimeType;

			if (picked) {
				await picked.open();
				sink = picked;
			} else if (opfsAvailable()) {
				await requestPersistence();
				const opfs = new OpfsSink(
					"anthers-downloads",
					`${params.assetId}-${params.filename}`,
					mimeType,
				);
				await opfs.open();
				sink = opfs;
			} else if (manifest.assetSize <= MEMORY_SINK_CEILING) {
				// No OPFS and a small file: memory is fine, and refusing would be worse.
				sink = new MemorySink(manifest.assetSize, mimeType);
			} else {
				// Refusing beats crashing the tab. "This browser can't do it" is a far better
				// message than a page that dies four gigabytes in with no explanation.
				throw new Error(
					"This browser can't handle a download this large. Try Chrome or Edge, or the desktop app.",
				);
			}

			setState("downloading");
			const result = await downloadAsset({
				workId: params.workId,
				assetId: params.assetId,
				sink,
				onProgress: setProgress,
				signal: controller.signal,
			});

			// Null means the sink already put the file where the user asked for it, so there is
			// nothing to hand over — the whole point of the FileSystemSink path.
			if (result.blob) saveBlob(result.blob, manifest.assetFilename || params.filename);
			setState("done");
		} catch (err) {
			if (controller.signal.aborted) {
				setState("idle");
				return;
			}
			// Each of these means something different to the person reading it, and collapsing
			// them into "download failed" throws away the only useful part.
			if (err instanceof AccessError) setError("You don't have access to this download.");
			else if (err instanceof IntegrityError) {
				setError("The file failed its integrity check and was discarded. Please try again.");
			} else setError(err instanceof Error ? err.message : "The download failed.");
			setState("error");
		} finally {
			abortRef.current = null;
		}
	}, [params.workId, params.assetId, params.filename, params.mimeType]);

	const fraction =
		progress && progress.totalBytes > 0 ? progress.receivedBytes / progress.totalBytes : null;

	return { state, progress, error, fraction, start, cancel };
}
