// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Multi-threaded on-device video transcoding for the Studio.
 *
 * The Studio is cross-origin isolated, so it runs the MULTI-THREADED ffmpeg core
 * (`@ffmpeg/core-mt`, vendored same-origin at /vendor/ffmpeg/*): each encode uses all
 * cores via libx264 frame threading. Variants encode SEQUENTIALLY — one MT encode
 * already saturates the CPU, so running them in parallel would just oversubscribe.
 * Contrast the main site's non-isolated path (`apps/web/src/lib/transcode.ts`), which
 * runs one single-threaded worker per rung concurrently.
 *
 * Encode args match the main site + server exactly (H.264/AAC, veryfast, keyframe
 * every 6s) so the server-side HLS packaging (`-c copy`) is unchanged.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

const VENDOR_BASE = "/vendor/ffmpeg";

export interface VariantSpec {
	name: string;
	height: number;
	width: number;
	bitrate: string;
	bandwidth: number;
}

export interface EncodedVariant extends VariantSpec {
	data: Uint8Array;
	seconds: number; // wall-clock for this rung
}

export interface TranscodeResult {
	variants: EncodedVariant[];
	durationSeconds: number;
	width: number;
	height: number;
	totalSeconds: number;
}

export interface Progress {
	stage: string;
	percent: number;
	etaSeconds: number | null;
}

let ffmpegPromise: Promise<FFmpeg> | null = null;

/** Load the multi-threaded core once (workerURL = the pthread worker). */
function loadFFmpeg(): Promise<FFmpeg> {
	if (ffmpegPromise) return ffmpegPromise;
	ffmpegPromise = (async () => {
		const ffmpeg = new FFmpeg();
		await ffmpeg.load({
			classWorkerURL: `${VENDOR_BASE}/worker.js`,
			coreURL: `${VENDOR_BASE}/ffmpeg-core.js`,
			wasmURL: `${VENDOR_BASE}/ffmpeg-core.wasm`,
			workerURL: `${VENDOR_BASE}/ffmpeg-core.worker.js`,
		});
		return ffmpeg;
	})();
	ffmpegPromise.catch(() => {
		ffmpegPromise = null;
	});
	return ffmpegPromise;
}

function probeSource(file: File): Promise<{ duration: number; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		video.onloadedmetadata = () => {
			const duration = Number.isFinite(video.duration) ? video.duration : 0;
			const width = video.videoWidth;
			const height = video.videoHeight;
			URL.revokeObjectURL(url);
			if (!width || !height) reject(new Error("Could not read video dimensions"));
			else resolve({ duration, width, height });
		};
		video.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Could not read video metadata"));
		};
		video.src = url;
	});
}

function ladderFor(w: number, h: number): VariantSpec[] {
	const rungs: Omit<VariantSpec, "width">[] = [];
	if (h >= 1080)
		rungs.push({ name: "1080p", height: 1080, bitrate: "5000k", bandwidth: 5_000_000 });
	if (h >= 720) rungs.push({ name: "720p", height: 720, bitrate: "2500k", bandwidth: 2_500_000 });
	rungs.push({ name: "480p", height: 480, bitrate: "1000k", bandwidth: 1_000_000 });
	const aspect = w / h;
	return rungs.map((r) => ({ ...r, width: Math.round((r.height * aspect) / 2) * 2 }));
}

function sourceExt(file: File): string {
	const dot = file.name.lastIndexOf(".");
	const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
	return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "mp4";
}

/**
 * Transcode a video into the MP4 variant ladder using the multi-threaded core.
 * Variants run sequentially; each saturates the CPU.
 */
export async function transcodeMultiThreaded(
	file: File,
	onProgress?: (p: Progress) => void,
): Promise<TranscodeResult> {
	const startedAt = performance.now();
	onProgress?.({ stage: "Loading multi-threaded encoder", percent: 1, etaSeconds: null });

	const [{ duration, width, height }, ffmpeg] = await Promise.all([
		probeSource(file),
		loadFFmpeg(),
	]);
	const variants = ladderFor(width, height);
	const inputName = `input.${sourceExt(file)}`;
	await ffmpeg.writeFile(inputName, await fetchFile(file));

	const ENCODE_START = 3;
	const ENCODE_END = 97;
	const per = (ENCODE_END - ENCODE_START) / variants.length;
	let base = ENCODE_START;
	const onTick = ({ progress }: { progress: number }) => {
		const frac = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
		const percent = Math.max(1, Math.min(99, Math.round(base + frac * per)));
		const elapsed = (performance.now() - startedAt) / 1000;
		const eta =
			percent >= 5 && percent < 100 ? Math.round((elapsed / percent) * (100 - percent)) : null;
		onProgress?.({ stage: "Encoding (multi-threaded)", percent, etaSeconds: eta });
	};
	ffmpeg.on("progress", onTick);

	const encoded: EncodedVariant[] = [];
	try {
		for (let i = 0; i < variants.length; i++) {
			const v = variants[i];
			base = ENCODE_START + i * per;
			const t0 = performance.now();
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
			await ffmpeg.deleteFile(outName).catch(() => {});
			encoded.push({ ...v, data, seconds: (performance.now() - t0) / 1000 });
		}
	} finally {
		ffmpeg.off("progress", onTick);
		await ffmpeg.deleteFile(inputName).catch(() => {});
	}

	onProgress?.({ stage: "Done", percent: 100, etaSeconds: 0 });
	return {
		variants: encoded,
		durationSeconds: Math.round(duration),
		width,
		height,
		totalSeconds: (performance.now() - startedAt) / 1000,
	};
}
