// SPDX-License-Identifier: Apache-2.0
/**
 * Every ffmpeg command the worker runs, built so that its memory is bounded.
 *
 * 🚨 **Left to itself, ffmpeg sizes its thread pools from the CPU count it can see, and in a
 * container that is the host's rather than the plan's.** Each decoder and encoder thread holds
 * frames of its own, so memory grows with hardware nobody chose: measured on a 16-core machine,
 * an unpinned 1080p encode peaked at 1,051 MB and a 4K source encoded to 1080p at 1,418 MB. The
 * worker's plan is one shared vCPU, where the extra threads buy no speed at all, and pinned to
 * one thread the same two encodes peaked at 381 MB and 400 MB.
 *
 * ⚠️ **The flag is positional, which is why this builds the whole command.** Before `-i` it
 * sets the decoder's threads and after it the encoder's, and pinning only the encoder still
 * peaked at 505 MB, because a frame-threaded decoder holds a frame per thread.
 * `scripts/ffmpeg-threads-guard.test.ts` refuses a worker source that spawns ffmpeg any other way.
 */

/** Threads per ffmpeg stage. Raise it with the worker's vCPU count and never above it. */
export const FFMPEG_THREADS = 1;

const THREAD_ARGS = ["-threads", String(FFMPEG_THREADS)];

/**
 * `ffmpeg [before] -threads N -i <input> -threads N [output]`.
 *
 * `before` holds the options that must precede the input, such as `-v error`; everything that
 * describes the output, including the output path, goes in `output`.
 */
export function ffmpegCommand(input: string, output: string[], before: string[] = []): string[] {
	return ["ffmpeg", ...before, ...THREAD_ARGS, "-i", input, ...THREAD_ARGS, ...output];
}
