// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useAttentionClaim } from "./attention";

interface Track {
	src: string;
	title: string;
	creator: string;
	creatorId?: number;
	thumbnail?: string | null;
	postId: number;
	waveform?: number[] | null;
}

interface MediaPlayerContextValue {
	currentTrack: Track | null;
	isPlaying: boolean;
	progress: number;
	duration: number;
	playTrack: (track: Track) => void;
	pause: () => void;
	resume: () => void;
	seek: (time: number) => void;
	close: () => void;
}

const MediaPlayerContext = createContext<MediaPlayerContextValue | null>(null);

export function MediaPlayerProvider({ children }: { children: ReactNode }) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);

	// Create audio element once
	useEffect(() => {
		const audio = new Audio();
		audio.preload = "metadata";
		audioRef.current = audio;

		const onTimeUpdate = () => setProgress(audio.currentTime);
		const onDurationChange = () => setDuration(audio.duration || 0);
		const onEnded = () => setIsPlaying(false);
		const onPlay = () => setIsPlaying(true);
		const onPause = () => setIsPlaying(false);

		audio.addEventListener("timeupdate", onTimeUpdate);
		audio.addEventListener("durationchange", onDurationChange);
		audio.addEventListener("ended", onEnded);
		audio.addEventListener("play", onPlay);
		audio.addEventListener("pause", onPause);

		return () => {
			audio.removeEventListener("timeupdate", onTimeUpdate);
			audio.removeEventListener("durationchange", onDurationChange);
			audio.removeEventListener("ended", onEnded);
			audio.removeEventListener("play", onPlay);
			audio.removeEventListener("pause", onPause);
			audio.pause();
			audio.src = "";
		};
	}, []);

	const playTrack = useCallback((track: Track) => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.src = track.src;
		audio.play().catch(() => {});
		setCurrentTrack(track);
		setProgress(0);
	}, []);

	const pause = useCallback(() => {
		audioRef.current?.pause();
	}, []);

	const resume = useCallback(() => {
		audioRef.current?.play().catch(() => {});
	}, []);

	const seek = useCallback((time: number) => {
		const audio = audioRef.current;
		if (audio) {
			audio.currentTime = time;
			setProgress(time);
		}
	}, []);

	const close = useCallback(() => {
		const audio = audioRef.current;
		if (audio) {
			audio.pause();
			audio.src = "";
		}
		setCurrentTrack(null);
		setIsPlaying(false);
		setProgress(0);
		setDuration(0);
	}, []);

	// Background audio playback. This claims the same (creator, post) pair as the
	// post page's own player, so when both are up the policy credits one of them —
	// the double-count is resolved centrally rather than by either side knowing
	// about the other.
	useAttentionClaim({
		creatorId: currentTrack?.creatorId ?? null,
		postId: currentTrack?.postId ?? null,
		contentType: "audio",
		playing: isPlaying,
		active: !!currentTrack,
	});

	return (
		<MediaPlayerContext.Provider
			value={{
				currentTrack,
				isPlaying,
				progress,
				duration,
				playTrack,
				pause,
				resume,
				seek,
				close,
			}}
		>
			{children}
		</MediaPlayerContext.Provider>
	);
}

export function useMediaPlayer(): MediaPlayerContextValue {
	const context = useContext(MediaPlayerContext);
	if (!context) {
		throw new Error("useMediaPlayer must be used within a MediaPlayerProvider");
	}
	return context;
}
