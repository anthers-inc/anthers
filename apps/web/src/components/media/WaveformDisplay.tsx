// SPDX-License-Identifier: Apache-2.0
/**
 * Draws the waveform, at the resolution of the surface it is painted on.
 *
 * The peaks arrive precomputed by FFmpeg at a fixed 128 points, which is far fewer bars
 * than a wide player wants to draw — stretched across a full-width track, each bar reads
 * fat and chunky. So the peak array is interpolated here to a bar count matched to the
 * measured container width, one bar every few pixels, and the drawing keeps 1:1 CSS
 * pixels rather than relying on scaling to fake it: crisp bars at any viewport width.
 *
 * Seeking belongs to the `SeekBar` this renders inside — its `group/seek` is what lets
 * the unplayed bars brighten on hover — and a playhead is painted at the position line,
 * which is the marker the shared SeekBar's own knob suppresses over a painted track.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";

/** One bar's footprint, in CSS pixels. */
const BAR_WIDTH = 2;
const BAR_GAP = 2;
const MIN_BAR_HEIGHT = 2;

/** How tall a peak's bar can be, as a share of the box's height. Centered mirrors below. */
const PEAK_SHARE = 0.92;

/**
 * The amplitude mapping, in shares of the box's height. Every surface normalizes a
 * track's peaks to its own loud passage — the loudest point reaches (near) the top and
 * silence keeps a stub — because a quiet recording's waveform drawn by amplitude alone
 * is a thin strip in the surface: the empty look the stage exists to fix. The shape is
 * the track's own; the scale is the drawing's. The stored peaks are bucket RMS, so the
 * loudest bucket sets the scale and the arrangement's quieter passages keep their room.
 */
const WAVEFORM_FLOOR = 0.06;

/**
 * Interpolate a peak list to exactly `count` entries, lerping the two neighbors of each
 * sample point so a finer grid follows the real contour instead of repeating steps.
 */
export function resamplePeaks(peaks: number[], count: number): number[] {
	if (count <= 0) return [];
	if (count === 1) return [peaks[Math.floor((peaks.length - 1) / 2)] ?? 0];
	if (peaks.length === count) return [...peaks];
	if (peaks.length === 0) return Array(count).fill(0);
	const step = (peaks.length - 1) / (count - 1);
	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		const at = i * step;
		const lo = Math.floor(at);
		const hi = Math.min(peaks.length - 1, lo + 1);
		const t = at - lo;
		out.push(Math.round((peaks[lo] + (peaks[hi] - peaks[lo]) * t) * 1000) / 1000);
	}
	return out;
}

interface WaveformDisplayProps {
	peaks: number[];
	progress: number; // 0 to 1
	/**
	 * The drawing height, in CSS pixels — omitted in the hero mode the listened Work
	 * pages draw, where the waveform is the page's reading surface and measures its
	 * container's height instead, stretching to whatever the composition gives it.
	 */
	height?: number;
}

export default function WaveformDisplay({ peaks, progress, height }: WaveformDisplayProps) {
	const svgRef = useRef<SVGSVGElement>(null);
	/** The box's rendered size, measured — without it the viewBox cannot match at 1:1. */
	const [width, setWidth] = useState(0);
	/** Read only in fill mode (no `height` given); the fixed modes size from the prop. */
	const [measuredHeight, setMeasuredHeight] = useState(0);

	useLayoutEffect(() => {
		const el = svgRef.current;
		if (!el) return;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			setWidth(Math.floor(rect?.width ?? 0));
			if (height == null) setMeasuredHeight(Math.floor(rect?.height ?? 0));
		});
		observer.observe(el);
		setWidth(Math.floor(el.clientWidth));
		if (height == null) setMeasuredHeight(Math.floor(el.clientHeight));
		return () => observer.disconnect();
	}, [height]);

	const fill = height == null;
	/** The drawing height: the prop in the fixed modes, the measured box in fill mode. */
	const boxHeight = height ?? measuredHeight;
	const pxPerBar = BAR_WIDTH + BAR_GAP;
	const barCount = Math.floor(width / pxPerBar);
	const bars = useMemo(() => resamplePeaks(peaks, barCount), [peaks, barCount]);

	const clamped = Math.min(1, Math.max(0, progress));
	const totalWidth = bars.length * pxPerBar;
	const playheadX = Math.min(totalWidth - BAR_GAP, clamped * totalWidth);
	/** The normalize scale: the track's own loudest bucket, whichever surface draws it. */
	const loudest = Math.max(...bars, 0.0001);
	const heightShare = (peak: number) =>
		WAVEFORM_FLOOR + (PEAK_SHARE - WAVEFORM_FLOOR) * Math.min(1, peak / loudest);

	return (
		<svg
			ref={svgRef}
			role="img"
			viewBox={`0 0 ${totalWidth || 1} ${boxHeight || 1}`}
			className={fill ? "absolute inset-0 h-full w-full" : "w-full"}
			style={fill ? undefined : { height }}
			preserveAspectRatio="none"
		>
			<title>Audio waveform</title>
			{bars.map((peak, i) => {
				const barHeight = Math.max(MIN_BAR_HEIGHT, heightShare(peak) * boxHeight);
				const x = i * pxPerBar;
				const y = (boxHeight - barHeight) / 2;
				const isPlayed = i / bars.length < clamped;

				return (
					<rect
						// biome-ignore lint/suspicious/noArrayIndexKey: one bar per interpolated sample, so position is the sample.
						key={i}
						x={x}
						y={y}
						width={BAR_WIDTH}
						height={barHeight}
						rx={1}
						className={
							isPlayed
								? "fill-primary"
								: "fill-base-content/20 transition-[fill] group-hover/seek:fill-base-content/35"
						}
					/>
				);
			})}
			{/* The position caret — the thin marker on the played boundary. A rect, not the
			    SeekBar's knob, because the knob is suppressed over a painted track. */}
			{clamped > 0 && clamped < 1 && bars.length > 0 && (
				<rect
					x={playheadX}
					y={0}
					width={BAR_GAP}
					height={boxHeight}
					rx={1}
					className="fill-primary"
				/>
			)}
		</svg>
	);
}
