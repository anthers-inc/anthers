// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side video transcoding via ffmpeg.wasm.
 *
 * The creator's browser encodes an H.264/AAC MP4 variant ladder (the CPU-heavy
 * step), then uploads the source + variants + a poster thumbnail; the server only
 * remuxes the ready-made variants into HLS with `-c copy` (cheap, no re-encode).
 * This gets our single-vCPU worker out of the transcode business for browser
 * uploads — the encode runs on the creator's hardware — and mirrors what a future
 * desktop "studio" app would do locally.
 *
 * The ffmpeg core is self-hosted and same-origin (`/vendor/ffmpeg/*`, see
 * scripts/vendor-ffmpeg.ts) with the SINGLE-THREADED core, so there's no CDN/CSP
 * dependency and no COOP/COEP requirement — cross-origin Spaces images and embeds
 * keep working. Trade-off: single-threaded wasm is slower and memory-bounded
 * (~2-4GB), so large sources fall back to server-side encoding (see MAX_SOURCE_BYTES
 * and the caller's try/catch).
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

/** Same-origin base for the vendored ffmpeg runtime. */
const VENDOR_BASE = "/vendor/ffmpeg";

/**
 * Above this source size we skip the browser encode and let the server transcode
 * (the wasm heap can't hold arbitrarily large decodes). Conservative on purpose.
 */
export const MAX_SOURCE_BYTES = 300 * 1024 * 1024; // 300MB

/** Descriptor for one rung of the variant ladder (metadata the server needs). */
export interface VariantSpec {
	name: string; // "480p"
	height: number;
	width: number;
	bitrate: string; // "1000k"
	bandwidth: number; // bits/s, for the HLS master playlist
}

/** An encoded variant: its spec plus the MP4 bytes to upload. */
export interface EncodedVariant extends VariantSpec {
	data: Uint8Array;
}

/** Result handed back to the uploader. */
export interface TranscodeResult {
	variants: EncodedVariant[];
	thumbnail: Uint8Array | null; // JPEG poster, or null if extraction failed
	durationSeconds: number;
	width: number;
	height: number;
}

/** Progress callback payload. `percent` is overall 0–100 across the whole job. */
export interface TranscodeProgress {
	stage: string;
	percent: number;
	etaSeconds: number | null;
}

/** Whether a source is a candidate for browser-side transcoding. */
export function canTranscodeInBrowser(file: File): boolean {
	return file.type.startsWith("video/") && file.size <= MAX_SOURCE_BYTES;
}

// ─── ffmpeg singleton ──────────────────────────────────────────────────────────

let ffmpegPromise: Promise<FFmpeg> | null = null;

/**
 * Load the single-threaded ffmpeg core from the vendored, same-origin runtime.
 * `classWorkerURL` points at our copied ESM worker (whose sibling modules live
 * alongside it), so we never rely on the app bundler resolving ffmpeg's internal
 * `new Worker(new URL("./worker.js", import.meta.url))`.
 */
function loadFFmpeg(): Promise<FFmpeg> {
	if (ffmpegPromise) return ffmpegPromise;
	ffmpegPromise = (async () => {
		const ffmpeg = new FFmpeg();
		await ffmpeg.load({
			classWorkerURL: `${VENDOR_BASE}/worker.js`,
			coreURL: `${VENDOR_BASE}/ffmpeg-core.js`,
			wasmURL: `${VENDOR_BASE}/ffmpeg-core.wasm`,
		});
		return ffmpeg;
	})();
	// If load fails, don't cache the rejection — allow a later retry.
	ffmpegPromise.catch(() => {
		ffmpegPromise = null;
	});
	return ffmpegPromise;
}

// ─── Source probing ──────────────────────────────────────────────────────────

/** Read duration + intrinsic dimensions from a video File via a <video> element. */
function probeSource(file: File): Promise<{ duration: number; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		const cleanup = () => URL.revokeObjectURL(url);
		video.onloadedmetadata = () => {
			const duration = Number.isFinite(video.duration) ? video.duration : 0;
			const width = video.videoWidth;
			const height = video.videoHeight;
			cleanup();
			if (!width || !height) {
				reject(new Error("Could not read video dimensions"));
				return;
			}
			resolve({ duration, width, height });
		};
		video.onerror = () => {
			cleanup();
			reject(new Error("Could not read video metadata"));
		};
		video.src = url;
	});
}

/** Build the source-gated variant ladder (same rungs as the server encoder). */
function ladderFor(sourceWidth: number, sourceHeight: number): VariantSpec[] {
	const rungs: Omit<VariantSpec, "width">[] = [];
	if (sourceHeight >= 1080)
		rungs.push({ name: "1080p", height: 1080, bitrate: "5000k", bandwidth: 5_000_000 });
	if (sourceHeight >= 720)
		rungs.push({ name: "720p", height: 720, bitrate: "2500k", bandwidth: 2_500_000 });
	rungs.push({ name: "480p", height: 480, bitrate: "1000k", bandwidth: 1_000_000 });

	const aspect = sourceWidth / sourceHeight;
	return rungs.map((r) => ({
		...r,
		// Even width, preserving aspect (matches the server's scale=-2:H behaviour).
		width: Math.round((r.height * aspect) / 2) * 2,
	}));
}

// ─── Encode ──────────────────────────────────────────────────────────────────

function sourceExt(file: File): string {
	const dot = file.name.lastIndexOf(".");
	const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
	return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "mp4";
}

/**
 * Transcode a video File into an MP4 variant ladder + poster thumbnail, entirely in
 * the browser. Rejects if the wasm encode fails (e.g. OOM) — the caller should fall
 * back to a plain source upload + server-side transcode.
 */
export async function transcodeInBrowser(
	file: File,
	onProgress?: (p: TranscodeProgress) => void,
): Promise<TranscodeResult> {
	const startedAt = performance.now();

	// Mutable band the progress handler maps ffmpeg's 0–1 into (set per exec below).
	let bandBase = 0;
	let bandSpan = 0;
	let stage = "Preparing";

	const report = (fraction: number) => {
		const percent = Math.max(0, Math.min(99, Math.round(bandBase + fraction * bandSpan)));
		const elapsed = (performance.now() - startedAt) / 1000;
		// ETA from overall throughput so far; needs a little progress to be meaningful.
		const eta =
			percent >= 5 && percent < 100 ? Math.round((elapsed / percent) * (100 - percent)) : null;
		onProgress?.({ stage, percent, etaSeconds: eta });
	};

	onProgress?.({ stage: "Loading encoder", percent: 1, etaSeconds: null });
	const [{ duration, width, height }, ffmpeg] = await Promise.all([
		probeSource(file),
		loadFFmpeg(),
	]);

	const variants = ladderFor(width, height);
	const ext = sourceExt(file);
	const inputName = `input.${ext}`;

	// ffmpeg's progress event fires with { progress: 0..1 } during each exec.
	const onTick = ({ progress }: { progress: number; time: number }) => {
		report(Number.isFinite(progress) ? progress : 0);
	};
	ffmpeg.on("progress", onTick);

	const result: TranscodeResult = {
		variants: [],
		thumbnail: null,
		durationSeconds: Math.round(duration),
		width,
		height,
	};

	try {
		await ffmpeg.writeFile(inputName, await fetchFile(file));

		// Encode band: 3%→92%, split evenly across the ladder.
		const ENCODE_START = 3;
		const ENCODE_END = 92;
		const per = (ENCODE_END - ENCODE_START) / variants.length;

		for (let i = 0; i < variants.length; i++) {
			const v = variants[i];
			stage = `Encoding ${v.name}`;
			bandBase = ENCODE_START + i * per;
			bandSpan = per;
			report(0);

			const outName = `${v.name}.mp4`;
			await ffmpeg.exec([
				"-i",
				inputName,
				"-vf",
				`scale=-2:${v.height}`,
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-b:v",
				v.bitrate,
				"-maxrate",
				v.bitrate,
				"-bufsize",
				`${Number.parseInt(v.bitrate, 10) * 2}k`,
				// Force a keyframe every 6s so the server can segment HLS on copy (no re-encode).
				"-force_key_frames",
				"expr:gte(t,n_forced*6)",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-movflags",
				"+faststart",
				outName,
			]);

			const data = (await ffmpeg.readFile(outName)) as Uint8Array;
			result.variants.push({ ...v, data });
			await ffmpeg.deleteFile(outName).catch(() => {});
		}

		// Poster thumbnail at ~25% (bounded to ≥1s), best-effort.
		stage = "Extracting thumbnail";
		bandBase = ENCODE_END;
		bandSpan = 99 - ENCODE_END;
		report(0);
		try {
			const at = Math.max(1, Math.round(duration * 0.25));
			await ffmpeg.exec([
				"-ss",
				String(at),
				"-i",
				inputName,
				"-frames:v",
				"1",
				"-q:v",
				"3",
				"thumb.jpg",
			]);
			result.thumbnail = (await ffmpeg.readFile("thumb.jpg")) as Uint8Array;
			await ffmpeg.deleteFile("thumb.jpg").catch(() => {});
		} catch {
			// Thumbnail is optional — the server can still derive one.
		}

		onProgress?.({ stage: "Done", percent: 100, etaSeconds: 0 });
		return result;
	} finally {
		ffmpeg.off("progress", onTick);
		await ffmpeg.deleteFile(inputName).catch(() => {});
	}
}
