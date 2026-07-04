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
 * Parallelism: each quality rung encodes in its OWN ffmpeg worker (own core),
 * concurrently — so an 8-core machine encodes the whole ladder in about the time of
 * the single slowest rung instead of the sum. We deliberately use the SINGLE-THREADED
 * core: multi-threaded ffmpeg needs SharedArrayBuffer → top-level cross-origin
 * isolation (COOP/COEP), which our single-document SPA can't adopt without breaking
 * cross-origin game/software embeds. One worker per rung gets most of the multi-core
 * win with zero isolation and zero embed risk. (The future studio app, an isolated
 * document, can go fully multi-threaded.)
 *
 * The core is self-hosted, same-origin (`/vendor/ffmpeg/*`). Trade-off: parallel
 * workers each hold a copy of the source, so peak memory scales with concurrency;
 * large sources fall back to server-side encoding (MAX_SOURCE_BYTES + caller try/catch).
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

/** Same-origin base for the vendored ffmpeg runtime. */
const VENDOR_BASE = "/vendor/ffmpeg";

/**
 * Above this source size we skip the browser encode and let the server transcode
 * (each parallel worker holds a copy of the source, so memory multiplies). Conservative.
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

// ─── ffmpeg instances ────────────────────────────────────────────────────────

/**
 * Load a fresh single-threaded ffmpeg core from the vendored, same-origin runtime.
 * Each concurrent encode gets its own instance (own worker/core) and terminates it
 * when done. `classWorkerURL` points at our copied ESM worker (whose sibling modules
 * live alongside it), so we don't rely on the app bundler resolving ffmpeg's internal
 * `new Worker(new URL("./worker.js", import.meta.url))`.
 */
async function createFFmpeg(): Promise<FFmpeg> {
	const ffmpeg = new FFmpeg();
	await ffmpeg.load({
		classWorkerURL: `${VENDOR_BASE}/worker.js`,
		coreURL: `${VENDOR_BASE}/ffmpeg-core.js`,
		wasmURL: `${VENDOR_BASE}/ffmpeg-core.wasm`,
	});
	return ffmpeg;
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

/**
 * Extract a poster frame with a <video> + canvas (no ffmpeg instance needed). Runs
 * concurrently with the encodes. Best-effort: resolves null if the browser can't
 * decode/seek the source (the server can still derive a poster during packaging).
 */
function extractPoster(file: File, atSeconds: number): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const video = document.createElement("video");
		video.muted = true;
		video.preload = "auto";
		let settled = false;
		const finish = (val: Uint8Array | null) => {
			if (settled) return;
			settled = true;
			URL.revokeObjectURL(url);
			resolve(val);
		};
		video.onloadedmetadata = () => {
			const dur = Number.isFinite(video.duration) ? video.duration : 0;
			video.currentTime = Math.min(atSeconds, Math.max(0, dur - 0.1));
		};
		video.onseeked = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				const ctx = canvas.getContext("2d");
				if (!ctx || !canvas.width) return finish(null);
				ctx.drawImage(video, 0, 0);
				canvas.toBlob(
					(blob) => {
						if (!blob) return finish(null);
						blob
							.arrayBuffer()
							.then((buf) => finish(new Uint8Array(buf)))
							.catch(() => finish(null));
					},
					"image/jpeg",
					0.85,
				);
			} catch {
				finish(null);
			}
		};
		video.onerror = () => finish(null);
		// Safety net for sources that never fire seeked.
		setTimeout(() => finish(null), 15000);
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
 * Encode one variant in a dedicated ffmpeg worker. Reads a FRESH copy of the source
 * (writeFile transfers the buffer, so instances can't share one), and terminates the
 * worker when done to free its memory. `onFraction` reports this variant's 0–1 progress.
 */
async function encodeVariant(
	file: File,
	inputName: string,
	v: VariantSpec,
	onFraction: (f: number) => void,
): Promise<Uint8Array> {
	const ffmpeg = await createFFmpeg();
	const onTick = ({ progress }: { progress: number }) => {
		onFraction(Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0);
	};
	ffmpeg.on("progress", onTick);
	try {
		await ffmpeg.writeFile(inputName, await fetchFile(file));
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
		return (await ffmpeg.readFile(outName)) as Uint8Array;
	} finally {
		ffmpeg.off("progress", onTick);
		ffmpeg.terminate();
	}
}

/**
 * Transcode a video File into an MP4 variant ladder + poster thumbnail, entirely in
 * the browser — each rung in its own worker, running concurrently up to the core
 * count. Rejects if any encode fails (e.g. OOM); the caller should fall back to a
 * plain source upload + server-side transcode.
 */
export async function transcodeInBrowser(
	file: File,
	onProgress?: (p: TranscodeProgress) => void,
): Promise<TranscodeResult> {
	const startedAt = performance.now();

	onProgress?.({ stage: "Preparing", percent: 1, etaSeconds: null });
	const { duration, width, height } = await probeSource(file);
	const variants = ladderFor(width, height);
	const inputName = `input.${sourceExt(file)}`;

	// Poster extraction is independent of the encodes — start it concurrently.
	const posterPromise = extractPoster(file, Math.max(1, Math.round(duration * 0.25))).catch(
		() => null,
	);

	// Overall progress = mean of per-variant fractions, mapped to the 3–95 band.
	const fractions = new Array(variants.length).fill(0);
	const ENCODE_START = 3;
	const ENCODE_END = 95;
	const report = () => {
		const done = fractions.filter((f) => f >= 1).length;
		const mean = fractions.reduce((a, b) => a + b, 0) / fractions.length;
		const percent = Math.max(
			1,
			Math.min(99, Math.round(ENCODE_START + mean * (ENCODE_END - ENCODE_START))),
		);
		const elapsed = (performance.now() - startedAt) / 1000;
		const eta =
			percent >= 5 && percent < 100 ? Math.round((elapsed / percent) * (100 - percent)) : null;
		const stage =
			done < variants.length ? `Encoding video (${done}/${variants.length})` : "Finishing up";
		onProgress?.({ stage, percent, etaSeconds: eta });
	};
	report();

	// Concurrency: one encode per available core (leaving one for the UI), capped at
	// the number of rungs. A worker pool pulls rungs off a shared index.
	const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
	const maxParallel = Math.max(1, Math.min(variants.length, cores - 1));

	const encoded: EncodedVariant[] = new Array(variants.length);
	let nextIndex = 0;
	const pump = async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= variants.length) return;
			const v = variants[i];
			const data = await encodeVariant(file, inputName, v, (f) => {
				fractions[i] = f;
				report();
			});
			encoded[i] = { ...v, data };
			fractions[i] = 1;
			report();
		}
	};
	await Promise.all(Array.from({ length: maxParallel }, pump));

	const thumbnail = await posterPromise;
	onProgress?.({ stage: "Done", percent: 100, etaSeconds: 0 });
	return {
		variants: encoded,
		thumbnail,
		durationSeconds: Math.round(duration),
		width,
		height,
	};
}
