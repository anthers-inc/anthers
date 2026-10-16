// SPDX-License-Identifier: Apache-2.0

import type { WorkChapter } from "@anthers/shared/chapters";
import {
	ArrowUturnLeftIcon,
	ArrowUturnRightIcon,
	PauseIcon,
	PlayIcon,
} from "@heroicons/react/24/solid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { useBindPlayerSeek } from "../../lib/work-player";
import ChapterList from "./ChapterList";
import { PublicAccessFooter, PublicAccessWall } from "./PublicAccessNotice";
import { formatRemaining, formatTime } from "./transport/format";
import SeekBar from "./transport/SeekBar";
import TransportButton from "./transport/TransportButton";
import { useMediaShortcuts } from "./transport/useMediaShortcuts";
import VolumeControl from "./transport/VolumeControl";
import { useVolume } from "./transport/volume";
import WaveformDisplay from "./WaveformDisplay";

/** How far the two skip buttons move, in seconds — the same step the keyboard's j/l takes. */
const SKIP_SECONDS = 10;

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
	 * Whether this Work draws the user's Public Access allowance. Same meaning as on
	 * `VideoPlayer` — see there for why gated, bought and own-catalog playback are all
	 * exempt.
	 */
	publicAccess?: boolean;
	/** The Work's chapters, parsed from its description — the list under the transport. */
	chapters?: WorkChapter[];
	/** Where the Work opens — the `?t` a timestamp link put in the address. */
	startSeconds?: number | null;
}

export default function AudioPlayer({
	src,
	waveform,
	onPlayInMiniPlayer,
	attention,
	publicAccess = false,
	chapters,
	startSeconds = null,
}: AudioPlayerProps) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);
	/** Delivery refused — the backstop for an allowance emptied between flushes. */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { volume, effective: effectiveVolume, setLevel, toggleMuted } = useVolume();

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

	// The placeholder for a track whose waveform has not been computed yet. Held in a
	// memo — without it every `timeupdate` rolls a new shape and the bar flickers.
	const defaultWaveform = useMemo(
		() => Array.from({ length: 64 }, () => 0.3 + Math.random() * 0.5),
		[],
	);
	const peaks = waveform && waveform.length > 0 ? waveform : defaultWaveform;

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

	// The app-wide remembered volume, so turning a video down turns this down too.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.volume = effectiveVolume;
		audio.muted = volume.muted;
	}, [effectiveVolume, volume.muted]);

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

	const seekTo = useCallback((seconds: number) => {
		const audio = audioRef.current;
		if (!audio) return;
		/*
		 * The element's own duration, not the state — the state trails by a
		 * `durationchange`, and the other two players read it this way.
		 */
		const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
		audio.currentTime = Math.min(Math.max(0, seconds), max);
		setProgress(audio.currentTime);
	}, []);

	const skipBy = useCallback(
		(seconds: number) => {
			seekTo((audioRef.current?.currentTime ?? 0) + seconds);
		},
		[seekTo],
	);

	// The keyboard keymap, scoped to the player — see useMediaShortcuts.ts. Arrows nudge
	// five seconds and j/l take the buttons' ten, which for a song's skips is the whole map.
	const onKeyDown = useMediaShortcuts({
		togglePlay,
		nudge: skipBy,
		seekFraction: (fraction) => seekTo(fraction * (audioRef.current?.duration ?? 0)),
		adjustVolume: (delta) => setLevel(volume.level + delta),
		toggleMuted,
	});

	// The page's timestamp links — description and reviews both — seek through here.
	useBindPlayerSeek(seekTo);

	// The landed `?t`, applied once the element has a duration to seek into, once.
	const [startApplied, setStartApplied] = useState(false);
	useEffect(() => {
		if (startApplied || startSeconds == null || !duration) return;
		setStartApplied(true);
		seekTo(startSeconds);
	}, [duration, startSeconds, startApplied, seekTo]);

	// Stop the buffered tail rather than letting it run on under the wall — otherwise the
	// limit visibly does not apply, and attention keeps being credited past it.
	useEffect(() => {
		if (spent) audioRef.current?.pause();
	}, [spent]);

	if (spent && budget) return <PublicAccessWall budget={budget} />;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the keymap is scoped to the player by design — see useMediaShortcuts.ts for why there is no global listener.
		<div
			tabIndex={-1}
			onKeyDown={onKeyDown}
			data-testid="audio-player"
			className="rounded-lg bg-base-200 p-4 focus-visible:outline-primary/50 sm:p-5"
		>
			{/* biome-ignore lint/a11y/useMediaCaption: Anthers has no caption tracks to offer yet — the `captions` roadmap entry. The element has no native controls; everything a person uses is the transport below. */}
			<audio ref={audioRef} src={src} preload="metadata" />

			<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
				{/* ── Transport: skip, play (the card's own centerpiece), skip ── */}
				<div className="flex items-center gap-1">
					<TransportButton
						label={`Skip back ${SKIP_SECONDS} seconds`}
						icon={ArrowUturnLeftIcon}
						onClick={() => skipBy(-SKIP_SECONDS)}
						size="lg"
						badge={
							<span className="absolute right-0 top-0 text-[8px] font-bold leading-none">
								{SKIP_SECONDS}
							</span>
						}
					/>
					<TransportButton
						label={isPlaying ? "Pause" : "Play"}
						icon={isPlaying ? PauseIcon : PlayIcon}
						onClick={togglePlay}
						tone="primary"
						size="lg"
					/>
					<TransportButton
						label={`Skip forward ${SKIP_SECONDS} seconds`}
						icon={ArrowUturnRightIcon}
						onClick={() => skipBy(SKIP_SECONDS)}
						size="lg"
						badge={
							<span className="absolute right-0 top-0 text-[8px] font-bold leading-none">
								{SKIP_SECONDS}
							</span>
						}
					/>
				</div>

				{/*
				 * The waveform IS the scrub surface, so it goes inside the shared SeekBar
				 * rather than handling its own clicks. That is what gives audio the same
				 * keyboard seeking, focus ring and hover time the video rail has — the
				 * painting differs, the interaction does not.
				 */}
				<div className="flex min-w-[14rem] flex-1 items-center gap-3">
					<span
						data-testid="audio-elapsed"
						className="min-w-[3rem] text-xs tabular-nums text-base-content/60"
					>
						{formatTime(progress)}
					</span>
					<SeekBar
						position={progress}
						duration={duration}
						onSeek={seekTo}
						label="Seek audio"
						className="flex-1"
						track={
							<WaveformDisplay
								peaks={peaks}
								progress={duration > 0 ? progress / duration : 0}
								height={64}
							/>
						}
					/>
					<span
						data-testid="audio-remaining"
						className="min-w-[3rem] text-right text-xs tabular-nums text-base-content/60"
					>
						{formatRemaining(progress, duration)}
					</span>
				</div>

				<div className="hidden sm:block">
					<VolumeControl collapsible size="xs" />
				</div>
			</div>

			{/* The creator's chapters from the description, inside the transport — a song
			    whose creator cues verse and chorus by the clock keeps its listeners there. */}
			{chapters && chapters.length > 0 && (
				<ChapterList chapters={chapters} position={progress} duration={duration} onSeek={seekTo} />
			)}

			{/*
			 * Hand the track to the persistent bar, which survives navigation.
			 *
			 * ⚠️ This player pauses ITSELF first, here rather than in the caller. Two
			 * elements playing the same track at once is not merely untidy — both register
			 * an attention claim on the same (creator, Work), and although the policy
			 * resolves that centrally rather than double-crediting, the listener hears the
			 * song twice, slightly out of phase. Leaving it to every caller to remember is
			 * how one of them eventually doesn't.
			 */}
			{onPlayInMiniPlayer && (
				<button
					type="button"
					onClick={() => {
						audioRef.current?.pause();
						onPlayInMiniPlayer();
					}}
					className="btn btn-ghost btn-xs mt-3"
				>
					Listen while you browse
				</button>
			)}

			{publicAccess && <PublicAccessFooter />}
		</div>
	);
}
