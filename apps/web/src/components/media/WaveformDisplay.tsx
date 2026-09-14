// SPDX-License-Identifier: Apache-2.0
interface WaveformDisplayProps {
	peaks: number[];
	progress: number; // 0 to 1
	height?: number;
}

/**
 * Draws the peaks and nothing else. Seeking belongs to the `SeekBar` this renders inside, which
 * is what gives the waveform the same keyboard and pointer handling as every other track.
 */
export default function WaveformDisplay({ peaks, progress, height = 48 }: WaveformDisplayProps) {
	const barWidth = 3;
	const gap = 1;
	const totalWidth = peaks.length * (barWidth + gap);

	return (
		<svg
			role="img"
			viewBox={`0 0 ${totalWidth} ${height}`}
			className="w-full"
			style={{ height }}
			preserveAspectRatio="none"
		>
			<title>Audio waveform</title>
			{peaks.map((peak, i) => {
				const barHeight = Math.max(2, peak * height * 0.9);
				const x = i * (barWidth + gap);
				const y = (height - barHeight) / 2;
				const barProgress = i / peaks.length;
				const isPlayed = barProgress < progress;

				return (
					<rect
						// biome-ignore lint/suspicious/noArrayIndexKey: one bar per precomputed peak, so position is the sample.
						key={i}
						x={x}
						y={y}
						width={barWidth}
						height={barHeight}
						rx={1}
						className={isPlayed ? "fill-primary" : "fill-base-content/20"}
					/>
				);
			})}
		</svg>
	);
}
