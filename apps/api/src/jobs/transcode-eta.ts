// SPDX-License-Identifier: Apache-2.0
/**
 * How long a video's encode has left, for the estimate a creator reads while they wait.
 *
 * A video is encoded as up to three variants, one after another and highest first, and ffmpeg
 * reports the speed of the one running. What is left is the rest of that variant plus every
 * variant still to come, and the variants are not the same amount of work.
 *
 * ⭐ **A variant's cost is weighted by its HEIGHT, not by its pixel count, and that was measured
 * rather than assumed.** Timed on one thread with the job's own settings, a 720p encode cost 0.68
 * of a 1080p one and a 480p encode 0.45, where their pixel counts would say 0.44 and 0.20: every
 * variant decodes the whole source and encodes the audio again, and that part does not shrink
 * with the output. The heights say 0.67 and 0.44. From a 4K source the same encodes cost 0.70 and
 * 0.52, a little more than the heights say, which the clamp below absorbs. Treating every variant
 * as costing what the running one costs overstates the first stretch of every job.
 */

/**
 * Seconds of wall time left in the encode, or null while ffmpeg has reported no speed to
 * project from.
 *
 * `heights` are the variants in encoding order, `current` is the index of the one running, and
 * `outSec` is how far into the source it has got.
 */
export function remainingEncodeSeconds(
	heights: readonly number[],
	current: number,
	outSec: number,
	duration: number,
	speed: number,
): number | null {
	if (!(speed > 0) || !(duration > 0)) return null;
	const running = heights[current];
	let left = Math.max(0, duration - outSec);
	for (let j = current + 1; j < heights.length; j++) left += duration * (heights[j] / running);
	return Math.round(left / speed);
}

/**
 * The estimate as a job writes it: never higher than the last one written, and held rather than
 * blanked while there is none. One clamp per run of a job.
 *
 * Each variant is a new ffmpeg whose first speed readings are low, so a fresh variant's first
 * estimate is higher than the previous variant's last, and a creator watching the figure climb
 * reads it as a job going backwards (Parker, 2026-09-17: *less precise but more confident*).
 * Where the model underestimates, the figure holds until the job catches up with it, and a figure
 * that holds reads better than one that climbs.
 */
export function createEtaClamp(): (estimate: number | null) => number | null {
	let last: number | null = null;
	return (estimate) => {
		if (estimate == null) return last;
		last = last == null ? estimate : Math.min(last, estimate);
		return last;
	};
}
