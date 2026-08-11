// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * React binding for the P2P download engine.
 *
 * The engine itself is framework-free and tested without React (`download.test.ts`); this
 * is only the part that turns its progress callbacks into state a component can render.
 * Keeping the split means the interesting logic never needs a component test to exercise.
 *
 * ── When this path is the right one, and when it is not ─────────────────────────────
 *
 * ⚠️ **This is not automatically better than the existing signed-URL download, and for
 * large files today it is worse.** A signed URL hands the browser a URL and the browser
 * streams it to disk natively: no OPFS, no second copy, no tab that has to stay open. The
 * P2P path assembles in origin-private storage and then hands the finished file over as a
 * blob, which costs 2× disk during the final copy — `showSaveFilePicker`, which would
 * write straight to a chosen location, is Chromium-only (verified against MDN's BCD on
 * 2026-08-10; Firefox and Safari have never shipped it).
 *
 * What the P2P path buys is real but different: **bytes served by peers cost Anthers
 * nothing** (45.01 § 6), every chunk is **verified against the manifest** rather than
 * trusted because it came from our CDN, and the whole path is one a third party can
 * reimplement from 45.04 — the open-client guarantee. Those are the reasons to prefer it,
 * and none of them are "it is faster for the user".
 *
 * So the honest shape while the swarm is empty is: offer it, do not force it. That changes
 * when peers exist, and it changes again for Anthers Desktop, which has a real filesystem
 * and none of these constraints — which is why Desktop is the right answer for large Works
 * rather than a fallback for one browser engine.
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
			// The manifest is fetched twice on this path — once here to learn the size so the
			// sink can be chosen, and once inside the engine. That is a small cost for not
			// having to guess, and the endpoint is cheap now that manifests are precomputed.
			const { fetchManifest } = await import("./download.js");
			const { manifest } = await fetchManifest(params.workId, params.assetId);
			const mimeType = params.mimeType ?? manifest.assetMimeType;

			if (opfsAvailable()) {
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
					"This browser can't assemble a download this large. Use the standard download, or the desktop app.",
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

			saveBlob(result.blob, manifest.assetFilename || params.filename);
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
