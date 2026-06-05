import { PauseIcon, PlayIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { Link } from "react-router-dom";
import { useMediaPlayer } from "../../lib/media-player";

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function MiniPlayer() {
	const { currentTrack, isPlaying, progress, duration, pause, resume, seek, close } =
		useMediaPlayer();

	if (!currentTrack) return null;

	const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

	return (
		<div className="fixed bottom-0 left-0 right-0 bg-base-200 border-t border-base-300 z-50 shadow-lg">
			{/* Progress bar */}
			<div
				className="h-1 bg-primary transition-all duration-200"
				style={{ width: `${progressPercent}%` }}
			/>

			<div className="flex items-center gap-3 px-4 py-2 max-w-screen-xl mx-auto">
				{/* Thumbnail */}
				{currentTrack.thumbnail ? (
					<img src={currentTrack.thumbnail} alt="" className="w-10 h-10 rounded object-cover" />
				) : (
					<div className="w-10 h-10 rounded bg-base-300 flex items-center justify-center">
						<PlayIcon className="w-5 h-5 text-base-content/30" />
					</div>
				)}

				{/* Title + creator */}
				<div className="flex-1 min-w-0">
					<Link
						to={`/posts/${currentTrack.postId}`}
						className="text-sm font-medium truncate block link link-hover"
					>
						{currentTrack.title}
					</Link>
					<span className="text-xs text-base-content/50 truncate block">
						{currentTrack.creator}
					</span>
				</div>

				{/* Time */}
				<span className="text-xs font-mono text-base-content/50 hidden sm:block">
					{formatTime(progress)} / {formatTime(duration)}
				</span>

				{/* Play/Pause */}
				<button
					type="button"
					onClick={isPlaying ? pause : resume}
					className="btn btn-circle btn-sm btn-ghost"
				>
					{isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />}
				</button>

				{/* Seek bar */}
				<input
					type="range"
					min={0}
					max={duration || 1}
					value={progress}
					onChange={(e) => seek(Number(e.target.value))}
					className="range range-xs range-primary w-24 hidden md:block"
				/>

				{/* Close */}
				<button type="button" onClick={close} className="btn btn-circle btn-xs btn-ghost">
					<XMarkIcon className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}
