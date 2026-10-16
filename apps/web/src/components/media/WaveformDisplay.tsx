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
	height?: number;
}

export default function WaveformDisplay({ peaks, progress, height = 48 }: WaveformDisplayProps) {
	const svgRef = useRef<SVGSVGElement>(null);
	/** The box's rendered width, measured — without it the viewBox cannot match at 1:1. */
	const [width, setWidth] = useState(0);

	useLayoutEffect(() => {
		const el = svgRef.current;
		if (!el) return;
		const observer = new ResizeObserver((entries) => {
			setWidth(Math.floor(entries[0]?.contentRect.width ?? 0));
		});
		observer.observe(el);
		setWidth(Math.floor(el.clientWidth));
		return () => observer.disconnect();
	}, []);

	const pxPerBar = BAR_WIDTH + BAR_GAP;
	const barCount = Math.floor(width / pxPerBar);
	const bars = useMemo(() => resamplePeaks(peaks, barCount), [peaks, barCount]);

	const clamped = Math.min(1, Math.max(0, progress));
	const totalWidth = bars.length * pxPerBar;
	const playheadX = Math.min(totalWidth - BAR_GAP, clamped * totalWidth);

	return (
		<svg
			ref={svgRef}
			role="img"
			viewBox={`0 0 ${totalWidth || 1} ${height}`}
			className="w-full"
			style={{ height }}
			preserveAspectRatio="none"
		>
			<title>Audio waveform</title>
			{bars.map((peak, i) => {
				const barHeight = Math.max(MIN_BAR_HEIGHT, peak * height * PEAK_SHARE);
				const x = i * pxPerBar;
				const y = (height - barHeight) / 2;
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
				<rect x={playheadX} y={0} width={BAR_GAP} height={height} rx={1} className="fill-primary" />
			)}
		</svg>
	);
}
