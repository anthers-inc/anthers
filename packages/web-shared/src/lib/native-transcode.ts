// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Native video encoding on the desktop, via the bundled ffmpeg sidecar.
 *
 * Deliberately shaped to satisfy the SAME contract as `transcodeInBrowser()` in
 * `@anthers/web-shared/transcode` — same `TranscodeResult`, same progress payload — so
 * `uploadClientTranscodedVideo()` and the server's `package-video` job are untouched.
 * The desktop is a faster engine behind an existing seam, not a second pipeline.
 *
 * What it removes, relative to the browser encoder: `ffmpeg.wasm` is single-threaded
 * per rung and capped at a 300 MB source, and the creator is tied to the tab for the
 * duration. Native x264 threads across every core, reads from disk, and the app is a
 * window the creator can leave alone.
 */
import type { TranscodeProgress, TranscodeResult } from "./transcode";

/** What the Rust encoder hands back — variants as file paths, not bytes. */
interface NativeEncodeResult {
	variants: {
		name: string;
		height: number;
		width: number;
		bitrate: string;
		bandwidth: number;
		path: string;
	}[];
	thumbnailPath: string | null;
	durationSeconds: number;
	width: number;
	height: number;
	workDir: string;
}

/**
 * Ask the creator for a video by real path.
 *
 * The desktop picker is the native dialog rather than `<input type=file>`, because a
 * `File` from the webview has no path — and a path is the whole point: ffmpeg reads
 * the source straight off disk, so a multi-gigabyte file never passes through memory.
 * Returns null if the dialog was dismissed.
 */
export async function pickVideoFile(): Promise<string | null> {
	const { open } = await import("@tauri-apps/plugin-dialog");
	const selected = await open({
		multiple: false,
		directory: false,
		filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }],
	});
	return typeof selected === "string" ? selected : null;
}

/** The trailing path segment, for showing the creator which file they picked. */
export function basename(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

/**
 * Encode a video by path into the variant ladder + poster, then read the outputs back
 * so the existing uploader can send them.
 *
 * The read-back is the one place memory still matters: variants land in JS as bytes,
 * exactly as the browser encoder produces them. That is a deliberate v1 trade — it
 * keeps the upload path identical — and it is bounded by the ENCODED size, not the
 * source, so a 4 GB camera file still becomes a few hundred MB of variants. Moving the
 * upload itself into Rust would remove even that; see the task note.
 */
export async function transcodeNative(
	path: string,
	onProgress?: (p: TranscodeProgress) => void,
): Promise<TranscodeResult> {
	const { invoke } = await import("@tauri-apps/api/core");
	const { listen } = await import("@tauri-apps/api/event");
	const { readFile } = await import("@tauri-apps/plugin-fs");

	const startedAt = performance.now();
	const unlisten = await listen<{ stage: string; percent: number }>("encode-progress", (e) => {
		const percent = e.payload.percent;
		const elapsed = (performance.now() - startedAt) / 1000;
		onProgress?.({
			stage: e.payload.stage,
			percent,
			etaSeconds:
				percent >= 5 && percent < 100 ? Math.round((elapsed / percent) * (100 - percent)) : null,
		});
	});

	let result: NativeEncodeResult;
	try {
		result = await invoke<NativeEncodeResult>("encode_video", { path });
	} finally {
		unlisten();
	}

	try {
		onProgress?.({ stage: "Reading encoded video", percent: 97, etaSeconds: null });
		const variants = await Promise.all(
			result.variants.map(async (v) => ({
				name: v.name,
				height: v.height,
				width: v.width,
				bitrate: v.bitrate,
				bandwidth: v.bandwidth,
				data: await readFile(v.path),
			})),
		);

		let thumbnail: Uint8Array | null = null;
		if (result.thumbnailPath) {
			// A poster is optional — the server can still derive one during packaging.
			thumbnail = await readFile(result.thumbnailPath).catch(() => null);
		}

		onProgress?.({ stage: "Finishing up", percent: 99, etaSeconds: null });
		return {
			variants,
			thumbnail,
			durationSeconds: result.durationSeconds,
			width: result.width,
			height: result.height,
		};
	} finally {
		// Reclaim the temp tree whether or not the read-back succeeded.
		await invoke("cleanup_encode", { workDir: result.workDir }).catch(() => {});
	}
}
