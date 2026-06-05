interface WaveformDisplayProps {
	peaks: number[];
	progress: number; // 0 to 1
	onSeek?: (progress: number) => void;
	height?: number;
}

export default function WaveformDisplay({
	peaks,
	progress,
	onSeek,
	height = 48,
}: WaveformDisplayProps) {
	const barWidth = 3;
	const gap = 1;
	const totalWidth = peaks.length * (barWidth + gap);

	const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
		if (!onSeek) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const percent = Math.max(0, Math.min(1, x / rect.width));
		onSeek(percent);
	};

	return (
		<svg
			role="img"
			viewBox={`0 0 ${totalWidth} ${height}`}
			className={`w-full ${onSeek ? "cursor-pointer" : ""}`}
			style={{ height }}
			onClick={handleClick}
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
