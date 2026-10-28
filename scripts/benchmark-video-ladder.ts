// SPDX-License-Identifier: Apache-2.0
/**
 * The video ladder's rate-control benchmark: **how do today's one-pass ABR targets compare with
 * CRF under a VBV cap, on quality, bytes and wall time?**
 *
 * The ladder in `apps/api/src/jobs/transcode-video.ts` encodes each rung with `-b:v <target>`,
 * which is x264's weakest rate control: it guesses one complexity spread for the whole file and
 * spends bits where the average demanded. CRF targets quality directly and a VBV cap
 * (`-maxrate`/`-bufsize`) holds it under the rung's old target, so simple passages spend less
 * than ABR would and only complex ones reach the ceiling. This script is how that claim is
 * measured rather than assumed — the protocol is the 2026-10-11 preset benchmark's: a real
 * production source, the job's own encode flags including its thread pin, and PSNR/SSIM against
 * the source scaled to each rung.
 *
 * ⚠️ **The source must be real, not synthetic.** Synthetic frames decode and compress unlike
 * anything a creator uploads and flatter whichever arm is more forgiving; the 2026-10-11 and
 * 2026-10-19 protocols both used `Curtains.mp4` (1920×1080 H.264 24 fps, 12.16 Mbps, 295 s)
 * for that reason, and the numbers in the task bodies are only comparable when it is that file.
 *
 * ⚠️ **Pin the encode and leave the measurement unpinned.** Each arm runs `-threads 2` through
 * the worker's own `ffmpegCommand` and, when `--cpu` is given, under `taskset`, so arms are
 * comparable to the worker's two dedicated vCPUs; the PSNR/SSIM pass then runs wide, because it
 * is measuring pixels rather than the thing the worker pays for.
 *
 * Usage:
 *
 *     bun run scripts/benchmark-video-ladder.ts --source ~/"Downloads/Anthers Media/Performances 2017-2018/Curtains.mp4"
 *
 *     --source <path>   the real video to benchmark (required)
 *     --out <dir>       where the encodes and the report land (default /tmp/opencode/crf-bench)
 *     --cpu <list>      taskset CPU list for the encodes, e.g. 4,5
 *     --arms <list>     default `abr,20,21,22,23`
 *     --rungs <list>    default `480,720,1080`
 *     --crop <arm:arm>  write 1:1 crops of the 720p pair at `--at` for a human's eye
 *     --at <seconds>    the crop's timestamp (default 120)
 *     --measure-only    re-measure encodes an earlier run left in `--out`, encoding nothing
 *     --caps <h=k,…>    override a rung's ceiling, e.g. `1080=4000,720=2000`, to audit the
 *                       targets themselves rather than only the rate-control mode
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FFMPEG_THREADS, ffmpegCommand } from "../apps/api/src/lib/ffmpeg.js";

/** The rung definitions under test — the production ladder's own targets, as a cap and as ABR. */
const LADDER = [
	{ name: "480p", height: 480, targetKbps: 1000 },
	{ name: "720p", height: 720, targetKbps: 2500 },
	{ name: "1080p", height: 1080, targetKbps: 5000 },
];

/** The audio every rung carries, in the job's own words (`-b:a 128k`). */
const AUDIO_KBPS = 128;

interface Args {
	source: string;
	out: string;
	cpu: string | null;
	arms: string[];
	rungs: number[];
	crop: string | null;
	at: number;
	measureOnly: boolean;
	/** Rung height → a ceiling other than the ladder's own, for auditing the targets. */
	caps: Map<number, number>;
}

function parseArgs(argv: string[]): Args {
	const value = (flag: string): string | null => {
		const i = argv.indexOf(flag);
		return i >= 0 ? (argv[i + 1] ?? null) : null;
	};
	const source = value("--source");
	if (!source) {
		console.error("--source is required: a real video file, not a synthetic one.");
		process.exit(64);
	}
	return {
		source: source.startsWith("~") ? join(process.env.HOME ?? "", source.slice(1)) : source,
		out: value("--out") ?? "/tmp/opencode/crf-bench",
		cpu: value("--cpu"),
		arms: (value("--arms") ?? "abr,20,21,22,23").split(",").map((s) => s.trim()),
		rungs: (value("--rungs") ?? "480,720,1080")
			.split(",")
			.map((s) => Number.parseInt(s.trim(), 10)),
		crop: value("--crop"),
		at: Number.parseFloat(value("--at") ?? "120"),
		measureOnly: argv.includes("--measure-only"),
		caps: new Map(
			(value("--caps") ?? "")
				.split(",")
				.filter(Boolean)
				.map((pair) => {
					const [height, kbps] = pair.split("=");
					return [Number.parseInt(height ?? "0", 10), Number.parseInt(kbps ?? "0", 10)] as const;
				}),
		),
	};
}

/** `ffmpeg …` or `taskset -c <list> ffmpeg …`, for a comparable two-core pin. */
function spawnFfmpeg(command: string[], cpu: string | null, stdout: "pipe" | "ignore" = "ignore") {
	const argv = cpu ? ["taskset", "-c", cpu, ...command] : command;
	return Bun.spawn(argv, { stdout, stderr: "pipe" });
}

async function ffprobe(source: string) {
	const proc = Bun.spawn(
		["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", source],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if ((await proc.exited) !== 0) {
		throw new Error(`ffprobe failed: ${await new Response(proc.stderr).text()}`);
	}
	return JSON.parse(await new Response(proc.stdout).text());
}

/** The arm's rate-control arguments — the whole difference between the rows of this table. */
function rateControl(arm: string, targetKbps: number): string[] {
	if (arm === "abr") return ["-b:v", `${targetKbps}k`];
	return [
		"-crf",
		arm,
		"-maxrate",
		`${targetKbps}k`,
		// Two seconds of buffer, the usual pairing: enough room for a short complex passage to
		// borrow against the cap without letting it run at the cap for long.
		"-bufsize",
		`${targetKbps * 2}k`,
	];
}

/** The job's own HLS shape for one rung, with the arm's rate control. */
function encodeArgs(arm: string, rung: (typeof LADDER)[number], dir: string): string[] {
	return [
		"-vf",
		`scale=-2:${rung.height}`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		...rateControl(arm, rung.targetKbps),
		"-c:a",
		"aac",
		"-b:a",
		`${AUDIO_KBPS}k`,
		"-hls_time",
		"6",
		"-hls_list_size",
		"0",
		"-hls_segment_filename",
		join(dir, `${rung.name}_%03d.ts`),
		"-f",
		"hls",
		join(dir, `${rung.name}.m3u8`),
		"-progress",
		"pipe:1",
		"-nostats",
		"-y",
	];
}

interface Measurement {
	bytes: number;
	/** Sum of the segment files' bytes over the source's duration — what a viewer averages. */
	averageBps: number;
	/** The largest single segment's rate, which is what RFC 8216's BANDWIDTH means. */
	peakSegmentBps: number;
}

/**
 * A rung's realized rate, read from the files it actually produced: segment sizes beside the
 * playlist's own `#EXTINF` durations. This is the honest input for the master playlist's
 * BANDWIDTH under CRF, where the realized rate is a property of the content rather than a
 * constant someone chose.
 */
async function measureRung(dir: string, name: string, durationSec: number): Promise<Measurement> {
	const playlist = await readFile(join(dir, `${name}.m3u8`), "utf8");
	const lines = playlist.split("\n");
	let bytes = 0;
	let peakSegmentBps = 0;
	let pending: number | null = null;
	for (const line of lines) {
		const extinf = line.match(/^#EXTINF:([\d.]+)/);
		if (extinf) {
			pending = Number.parseFloat(extinf[1]);
			continue;
		}
		if (!line || line.startsWith("#") || pending == null) continue;
		const segmentBytes = (await stat(join(dir, line.trim()))).size;
		bytes += segmentBytes;
		if (pending > 0) peakSegmentBps = Math.max(peakSegmentBps, (segmentBytes * 8) / pending);
		pending = null;
	}
	return {
		bytes,
		averageBps: durationSec > 0 ? (bytes * 8) / durationSec : 0,
		peakSegmentBps: Math.round(peakSegmentBps),
	};
}

/** PSNR and SSIM of one encode against the source scaled to its own height, in `yuv420p`. */
async function quality(
	encodedPath: string,
	source: string,
	height: number,
): Promise<{ psnr: number | null; ssim: number | null }> {
	const run = async (filter: string, pattern: RegExp) => {
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"info",
				"-i",
				encodedPath,
				"-i",
				source,
				"-lavfi",
				`[1:v]scale=-2:${height},format=yuv420p[ref];[0:v]format=yuv420p[enc];[enc][ref]${filter}`,
				"-f",
				"null",
				"-",
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		if ((await proc.exited) !== 0) {
			throw new Error(`${filter} failed: ${await new Response(proc.stderr).text()}`);
		}
		const stderr = await new Response(proc.stderr).text();
		const match = stderr.match(pattern);
		return match ? Number.parseFloat(match[1]) : null;
	};
	return {
		// The plane AVERAGE, not the Y plane: the 2026-10-11 and 2026-10-19 records quote it,
		// so the numbers here stay comparable to the ones the ladder's decisions rest on.
		psnr: await run("psnr", /average:([\d.]+)/),
		ssim: await run("ssim", /All:([\d.]+)/),
	};
}

interface Row extends Measurement {
	arm: string;
	rung: string;
	durationSec: number;
	encodeMs: number;
	psnr: number | null;
	ssim: number | null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const probe = await ffprobe(args.source);
	const durationSec = Number.parseFloat(probe.format?.duration ?? "0");
	const sourceHeight = Number.parseInt(
		probe.streams?.find((s: { codec_type: string }) => s.codec_type === "video")?.height ?? "0",
		10,
	);
	const hasAudio = Boolean(
		probe.streams?.some((s: { codec_type: string }) => s.codec_type === "audio"),
	);
	console.log(
		`source: ${args.source}\n  ${durationSec.toFixed(0)} s, ${sourceHeight}p, audio ${hasAudio ? "yes" : "no"}, ` +
			`threads ${FFMPEG_THREADS}${args.cpu ? `, cpu ${args.cpu}` : ""}`,
	);

	const rungs = LADDER.filter((r) => args.rungs.includes(r.height) && r.height <= sourceHeight + 1);
	await mkdir(args.out, { recursive: true });
	/**
	 * A `--measure-only` pass re-reads encodes an earlier run left in `--out`; their wall
	 * times come from that run's report, because a measurement cannot reproduce them.
	 */
	const previous = new Map<string, number>();
	try {
		const prior = JSON.parse(await readFile(join(args.out, "report.json"), "utf8"));
		for (const row of prior.rows ?? []) previous.set(`${row.arm} ${row.rung}`, row.encodeMs);
	} catch {
		// No earlier report: a measure-only pass reports no wall time.
	}
	const rows: Row[] = [];

	// A cap override renames the arm, so an audit's row cannot be mistaken for the ladder's own.
	const capLabel = [...args.caps.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([height, kbps]) => `${height}-${kbps}`)
		.join("-");
	const label = (arm: string) => (capLabel ? `${arm}@${capLabel}` : arm);

	for (const arm of args.arms) {
		for (const planned of rungs) {
			const rung =
				args.caps.has(planned.height) && args.caps.get(planned.height)
					? { ...planned, targetKbps: args.caps.get(planned.height) as number }
					: planned;
			const dir = join(
				args.out,
				arm === "abr" ? "abr" : `crf${arm}`,
				capLabel ? `${rung.name}-cap${rung.targetKbps}` : rung.name,
			);
			let encodeMs = previous.get(`${arm} ${rung.name}`) ?? 0;
			if (!args.measureOnly) {
				await rm(dir, { recursive: true, force: true });
				await mkdir(dir, { recursive: true });
				const started = Date.now();
				const proc = spawnFfmpeg(ffmpegCommand(args.source, encodeArgs(arm, rung, dir)), args.cpu);
				const exit = await proc.exited;
				if (exit !== 0) {
					throw new Error(
						`${arm} ${rung.name} failed: ${(await new Response(proc.stderr).text()).slice(0, 800)}`,
					);
				}
				encodeMs = Date.now() - started;
			}
			const measured = await measureRung(dir, rung.name, durationSec);
			const { psnr, ssim } = await quality(
				// The segments concatenate into one valid MPEG-TS; the playlist's order is the file's.
				await concatSegments(dir, rung.name),
				args.source,
				rung.height,
			);
			rows.push({
				arm: label(arm),
				rung: rung.name,
				durationSec,
				encodeMs,
				psnr,
				ssim,
				...measured,
			});
			console.log(
				`${label(arm).padEnd(4)} ${rung.name.padEnd(6)} ${(measured.bytes / 1e6).toFixed(1)} MB ` +
					`avg ${(measured.averageBps / 1e3).toFixed(0)}k peak ${(measured.peakSegmentBps / 1e3).toFixed(0)}k ` +
					`PSNR ${psnr?.toFixed(2)} SSIM ${ssim?.toFixed(4)} ${(encodeMs / 1000).toFixed(0)} s`,
			);
		}
	}

	const report = { source: args.source, durationSec, rows };
	await Bun.write(join(args.out, "report.json"), JSON.stringify(report, null, "\t"));
	await Bun.write(join(args.out, "report.md"), markdown(report));
	console.log(`\n${markdown(report)}`);
	console.log(`\nwrote ${join(args.out, "report.md")}`);

	if (args.crop) {
		const [a, b] = args.crop.split(":");
		await writeCrops(args.out, [a, b], args.at);
	}
}

/**
 * The segments as one stream, in playlist order, at a path `quality` can read.
 *
 * `cat` is how MPEG-TS segments are joined — each is independently decodable and the container
 * carries no index — so the deliverable on disk is measured rather than a re-encode of it.
 */
async function concatSegments(dir: string, name: string): Promise<string> {
	const playlist = await readFile(join(dir, `${name}.m3u8`), "utf8");
	const segments = playlist
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
	const parts: Uint8Array[] = [];
	for (const segment of segments) parts.push(await readFile(join(dir, segment)));
	const out = join(dir, `${name}-joined.ts`);
	await Bun.write(out, new Uint8Array(Buffer.concat(parts)));
	return out;
}

/** The comparison a person's eye can settle: the same frame, 1:1 crops, one arm above the other. */
async function writeCrops(out: string, arms: string[], at: number) {
	const cropsDir = join(out, "crops");
	await mkdir(cropsDir, { recursive: true });
	const files: string[] = [];
	for (const arm of arms) {
		const dir = join(out, arm === "abr" ? "abr" : `crf${arm}`, "720p");
		const joined = join(dir, "720p-joined.ts");
		const crop = join(cropsDir, `720p-${arm}.png`);
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-ss",
				String(at),
				"-i",
				joined,
				"-frames:v",
				"1",
				"-vf",
				"crop=640:360:320:180",
				crop,
				"-y",
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		if ((await proc.exited) !== 0) {
			throw new Error(`crop for ${arm} failed: ${await new Response(proc.stderr).text()}`);
		}
		files.push(crop);
	}
	const labelled: string[] = [];
	for (const [i, file] of files.entries()) {
		const labelledPath = join(cropsDir, `labelled-${i}.png`);
		const proc = Bun.spawn(
			[
				"convert",
				file,
				"-background",
				"#101010",
				"-fill",
				"white",
				"-pointsize",
				"22",
				"-gravity",
				"northwest",
				"-splice",
				"0x34",
				"-annotate",
				"+10+6",
				`720p ${arms[i]} — t=${at}s, 1:1 crop`,
				labelledPath,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		if ((await proc.exited) !== 0) throw new Error("labelling a crop failed");
		labelled.push(labelledPath);
	}
	const stacked = join(cropsDir, `720p-${arms.join("-vs-")}.png`);
	const proc = Bun.spawn(["convert", ...labelled, "-append", stacked], {
		stdout: "ignore",
		stderr: "pipe",
	});
	if ((await proc.exited) !== 0) throw new Error("stacking the crops failed");
	await Promise.all(labelled.map((f) => rm(f).catch(() => {})));
	console.log(`crops: ${stacked}`);
}

function markdown(report: { source: string; durationSec: number; rows: Row[] }): string {
	const lines = [
		"| arm | rung | MB | avg kbps | peak kbps | PSNR (plane avg) | SSIM | encode s |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const r of report.rows) {
		lines.push(
			`| ${r.arm} | ${r.rung} | ${(r.bytes / 1e6).toFixed(1)} | ${(r.averageBps / 1e3).toFixed(0)} | ` +
				`${(r.peakSegmentBps / 1e3).toFixed(0)} | ${r.psnr?.toFixed(2) ?? "—"} | ` +
				`${r.ssim?.toFixed(4) ?? "—"} | ${(r.encodeMs / 1000).toFixed(0)} |`,
		);
	}
	return lines.join("\n");
}

await main();
