// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DORMANT — deferred groundwork, not currently imported (E50 Phase 2 deferred).
 * `@ffmpeg/core-mt` hangs at pthread-pool spawn in-browser (workers-spawning-workers);
 * kept in place so a future in-browser debug session / newer core / the desktop
 * Studio can pick up the MT path without rebuilding it. Until then the Studio uses
 * the parallel single-thread encode from `@anthers/web-shared` (lib/transcode), same
 * as the main site. See epic E50 - Creator Studio, "MT encoding — DEFERRED".
 *
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
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const VENDOR_BASE = "/vendor/ffmpeg";

/** Last ffmpeg log lines — surfaced in the UI if a load/encode fails. */
const recentLogs: string[] = [];
export function getRecentLogs(): string[] {
	return recentLogs.slice(-8);
}

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

/** Reject if `p` doesn't settle within `ms`, naming the stage that stalled. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							`${what} did not finish within ${ms / 1000}s. Recent ffmpeg logs: ${getRecentLogs().join(" | ") || "(none)"} — check DevTools → Console.`,
						),
					),
				ms,
			),
		),
	]);
}

/**
 * Load the multi-threaded core once. Core/wasm/worker are fetched into blob URLs (the
 * documented core-mt config), and the vendored core is patched to spawn its pthread
 * workers as MODULE workers so their dynamic `import()` of the core resolves (classic
 * workers silently hang on it). `onStage` + a per-step timeout make a stall visible.
 */
function loadFFmpeg(onStage?: (stage: string) => void): Promise<FFmpeg> {
	if (ffmpegPromise) return ffmpegPromise;
	ffmpegPromise = (async () => {
		const ffmpeg = new FFmpeg();
		ffmpeg.on("log", ({ message }) => {
			recentLogs.push(message);
			if (recentLogs.length > 40) recentLogs.shift();
		});

		onStage?.("Fetching encoder core (~32 MB)…");
		const [coreURL, wasmURL, workerURL] = await withTimeout(
			Promise.all([
				toBlobURL(`${VENDOR_BASE}/ffmpeg-core.js`, "text/javascript"),
				toBlobURL(`${VENDOR_BASE}/ffmpeg-core.wasm`, "application/wasm"),
				toBlobURL(`${VENDOR_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
			]),
			60_000,
			"Downloading the encoder core",
		);

		onStage?.("Initializing multi-threaded core (spawning threads)…");
		await withTimeout(
			ffmpeg.load({ classWorkerURL: `${VENDOR_BASE}/worker.js`, coreURL, wasmURL, workerURL }),
			90_000,
			"Initializing the multi-threaded core",
		);
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
	onProgress?.({ stage: "Reading video…", percent: 1, etaSeconds: null });
	const { duration, width, height } = await probeSource(file);

	const ffmpeg = await loadFFmpeg((stage) => onProgress?.({ stage, percent: 2, etaSeconds: null }));
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
