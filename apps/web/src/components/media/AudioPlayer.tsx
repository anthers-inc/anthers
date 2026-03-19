import { useEffect, useRef, useState } from "react";
import { PlayIcon, PauseIcon } from "@heroicons/react/24/solid";
import WaveformDisplay from "./WaveformDisplay";

interface AudioPlayerProps {
	src: string;
	waveform?: number[] | null;
	onPlayInMiniPlayer?: () => void;
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function AudioPlayer({
	src,
	waveform,
	onPlayInMiniPlayer,
}: AudioPlayerProps) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		const onTimeUpdate = () => setProgress(audio.currentTime);
		const onDurationChange = () => setDuration(audio.duration || 0);
		const onEnded = () => setIsPlaying(false);

		audio.addEventListener("timeupdate", onTimeUpdate);
		audio.addEventListener("durationchange", onDurationChange);
		audio.addEventListener("ended", onEnded);

		return () => {
			audio.removeEventListener("timeupdate", onTimeUpdate);
			audio.removeEventListener("durationchange", onDurationChange);
			audio.removeEventListener("ended", onEnded);
		};
	}, []);

	const togglePlay = () => {
		const audio = audioRef.current;
		if (!audio) return;
		if (isPlaying) {
			audio.pause();
			setIsPlaying(false);
		} else {
			audio.play().catch(() => {});
			setIsPlaying(true);
		}
	};

	const handleSeek = (percent: number) => {
		const audio = audioRef.current;
		if (audio && duration > 0) {
			audio.currentTime = percent * duration;
		}
	};

	const defaultWaveform = Array.from({ length: 64 }, () => 0.3 + Math.random() * 0.5);
	const peaks = waveform && waveform.length > 0 ? waveform : defaultWaveform;

	return (
		<div className="rounded-lg bg-base-200 p-4">
			<audio ref={audioRef} src={src} preload="metadata" />

			<div className="flex items-center gap-3">
				<button
					onClick={togglePlay}
					className="btn btn-circle btn-primary btn-sm"
				>
					{isPlaying ? (
						<PauseIcon className="w-4 h-4" />
					) : (
						<PlayIcon className="w-4 h-4 ml-0.5" />
					)}
				</button>

				<div className="flex-1">
					<WaveformDisplay
						peaks={peaks}
						progress={duration > 0 ? progress / duration : 0}
						onSeek={handleSeek}
						height={40}
					/>
				</div>

				<span className="text-xs font-mono text-base-content/60 min-w-[4rem] text-right">
					{formatTime(progress)} / {formatTime(duration)}
				</span>
			</div>

			{onPlayInMiniPlayer && (
				<button
					onClick={onPlayInMiniPlayer}
					className="btn btn-ghost btn-xs mt-2"
				>
					Play in mini-player
				</button>
			)}
		</div>
	);
}
