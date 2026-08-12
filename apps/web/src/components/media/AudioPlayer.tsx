// SPDX-License-Identifier: AGPL-3.0-or-later
import { PauseIcon, PlayIcon } from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { PublicAccessFooter, PublicAccessWall } from "./PublicAccessNotice";
import WaveformDisplay from "./WaveformDisplay";

interface AudioPlayerProps {
	src: string;
	waveform?: number[] | null;
	onPlayInMiniPlayer?: () => void;
	/**
	 * Whose Time Pool minutes this playback earns. Omit on surfaces where playback
	 * shouldn't be credited (previews, the Studio); the player then just plays.
	 */
	attention?: { creatorId: number | null; workId: number | null };
	/**
	 * Whether this Work draws the viewer's Public Access allowance. Same meaning as on
	 * `VideoPlayer` — see there for why gated, bought and own-catalogue playback are all
	 * exempt.
	 */
	publicAccess?: boolean;
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
	attention,
	publicAccess = false,
}: AudioPlayerProps) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);
	/** Delivery refused — the backstop for an allowance emptied between flushes. */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();

	/*
	 * Decided from the budget, not from the element's error.
	 *
	 * 🚨 A media element cannot tell you *why* it failed: a 402 arrives as
	 * `MEDIA_ERR_SRC_NOT_SUPPORTED` with no status anywhere on the event, which is the
	 * same thing a corrupt file or a dead network gives. Reading the budget instead means
	 * the player knows before the request is even made, and never mislabels an outage as
	 * "you're out of hours".
	 */
	const spent = publicAccess && (refused || (!!budget && !budget.allowed));

	// Audio credits time only while it is actually playing — and keeps crediting
	// in a hidden tab, because listening while working elsewhere is real listening.
	useAttentionClaim({
		creatorId: attention?.creatorId ?? null,
		workId: attention?.workId ?? null,
		contentType: "audio",
		playing: isPlaying,
		active: !!attention,
	});

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		const onTimeUpdate = () => setProgress(audio.currentTime);
		const onDurationChange = () => setDuration(audio.duration || 0);
		const onEnded = () => setIsPlaying(false);
		// Mirror the element's own state so pausing via anything other than our
		// button (media keys, another tab claiming audio focus) is reflected.
		const onPlay = () => setIsPlaying(true);
		const onPause = () => setIsPlaying(false);
		// The element cannot say 402, so treat any load failure on a Public Access Work
		// as worth re-reading the budget for. If the allowance is intact the store is
		// unchanged and this stays silent, which is the correct outcome for a genuine
		// network blip.
		const onError = () => {
			if (!publicAccess) return;
			setRefused(true);
			refreshBudget();
		};

		audio.addEventListener("error", onError);
		audio.addEventListener("timeupdate", onTimeUpdate);
		audio.addEventListener("durationchange", onDurationChange);
		audio.addEventListener("ended", onEnded);
		audio.addEventListener("play", onPlay);
		audio.addEventListener("pause", onPause);

		return () => {
			audio.removeEventListener("error", onError);
			audio.removeEventListener("timeupdate", onTimeUpdate);
			audio.removeEventListener("durationchange", onDurationChange);
			audio.removeEventListener("ended", onEnded);
			audio.removeEventListener("play", onPlay);
			audio.removeEventListener("pause", onPause);
			setIsPlaying(false);
		};
	}, [publicAccess]);

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

	// Stop the buffered tail rather than letting it run on under the wall — otherwise the
	// limit visibly does not apply, and attention keeps being credited past it.
	useEffect(() => {
		if (spent) audioRef.current?.pause();
	}, [spent]);

	if (spent && budget) return <PublicAccessWall budget={budget} />;

	return (
		<div className="rounded-lg bg-base-200 p-4">
			<audio ref={audioRef} src={src} preload="metadata" />

			<div className="flex items-center gap-3">
				<button type="button" onClick={togglePlay} className="btn btn-circle btn-primary btn-sm">
					{isPlaying ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
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
				<button type="button" onClick={onPlayInMiniPlayer} className="btn btn-ghost btn-xs mt-2">
					Play in mini-player
				</button>
			)}

			{publicAccess && <PublicAccessFooter playing={isPlaying} />}
		</div>
	);
}
