// SPDX-License-Identifier: Apache-2.0
/**
 * The spoken player — the on-page surface for an `audio` Work: a podcast episode, an
 * interview, a lecture. Music's player is for music; this one is for listening to talk,
 * and the differences are exactly what talk wants: a playback-rate control the listener
 * sets once, fixed-step skips, and remembering where they got to.
 *
 * The rate is *not* a daisyUI dropdown, for the reason the video controls give: the menu
 * must stay usable in any stacking context. Resume state lives in
 * `lib/listen-positions.ts` and is deliberately local; the floor and the finish rules
 * there are what keep a resume from feeling creepy.
 */
import {
	ArrowUturnLeftIcon,
	ArrowUturnRightIcon,
	PauseIcon,
	PlayIcon,
} from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import {
	LISTEN_RESUME_FLOOR_SECONDS,
	readPosition,
	writePosition,
} from "../../lib/listen-positions";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { SPOKEN_RATE_EVENT, stepSpokenRate, useSpokenRate } from "../../lib/spoken-rate";
import { PublicAccessFooter, PublicAccessWall } from "./PublicAccessNotice";
import { formatTime } from "./transport/format";
import SeekBar from "./transport/SeekBar";
import SpeedMenu from "./transport/SpeedMenu";
import TransportButton from "./transport/TransportButton";
import { useMediaShortcuts } from "./transport/useMediaShortcuts";
import VolumeControl from "./transport/VolumeControl";
import { useVolume } from "./transport/volume";
import WaveformDisplay from "./WaveformDisplay";

/** How far the two skip buttons move, in seconds — the podcast player's pair. */
export const SPOKEN_SKIP_BACK_SECONDS = 15;
export const SPOKEN_SKIP_FORWARD_SECONDS = 30;

interface SpokenPlayerProps {
	src: string;
	/** The Work being played — resume state and the attention claim are keyed on it. */
	workId: number;
	waveform?: number[] | null;
	/**
	 * Restore from a remembered position and persist as it moves. Off only where resume
	 * would be a lie — the Studio's own preview, which is not the listening the Work is for.
	 */
	remember?: boolean;
	/**
	 * Whose Time Pool minutes this playback earns. Omit on surfaces where playback
	 * shouldn't be credited (previews, the Studio); the player then just plays.
	 */
	attention?: { creatorId: number | null; workId: number | null };
	/**
	 * Whether this Work draws the viewer's Public Access allowance. Same meaning as on
	 * `AudioPlayer` — see there for why gated, bought and own-catalog playback are exempt.
	 */
	publicAccess?: boolean;
	onPlayInMiniPlayer?: () => void;
}

export default function SpokenPlayer({
	src,
	workId,
	waveform,
	remember = true,
	attention,
	publicAccess = false,
	onPlayInMiniPlayer,
}: SpokenPlayerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);
	/** Delivery refused — the backstop for an allowance emptied between flushes. */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { volume, effective: effectiveVolume } = useVolume();
	const [rate, setRate] = useSpokenRate();

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

		const onTimeUpdate = () => {
			setProgress(audio.currentTime);
			if (remember) writePosition(workId, audio.currentTime, audio.duration || null);
		};
		const onDurationChange = () => setDuration(audio.duration || 0);
		const onEnded = () => {
			setIsPlaying(false);
			if (remember)
				writePosition(workId, audio.currentTime, audio.duration || null, { force: true });
		};
		const onPlay = () => setIsPlaying(true);
		// Mirror the element's own state so pausing via anything other than our button
		// (media keys, another tab claiming audio focus) is reflected and flushed.
		const onPause = () => {
			setIsPlaying(false);
			if (remember)
				writePosition(workId, audio.currentTime, audio.duration || null, { force: true });
		};
		// The element cannot say 402, so treat any load failure on a Public Access Work
		// as worth re-reading the budget for. If the allowance is intact the store is
		// unchanged and this stays silent, which is the correct outcome for a genuine
		// network blip.
		const onError = () => {
			if (!publicAccess) return;
			setRefused(true);
			refreshBudget();
		};
		// The flush that survives nothing else: navigate, close, crash.
		const onPageHide = () => {
			if (remember)
				writePosition(workId, audio.currentTime, audio.duration || null, { force: true });
		};

		audio.addEventListener("error", onError);
		audio.addEventListener("timeupdate", onTimeUpdate);
		audio.addEventListener("durationchange", onDurationChange);
		audio.addEventListener("ended", onEnded);
		audio.addEventListener("play", onPlay);
		audio.addEventListener("pause", onPause);
		window.addEventListener("pagehide", onPageHide);

		return () => {
			audio.removeEventListener("error", onError);
			audio.removeEventListener("timeupdate", onTimeUpdate);
			audio.removeEventListener("durationchange", onDurationChange);
			audio.removeEventListener("ended", onEnded);
			audio.removeEventListener("play", onPlay);
			audio.removeEventListener("pause", onPause);
			window.removeEventListener("pagehide", onPageHide);
			setIsPlaying(false);
		};
	}, [publicAccess, remember, workId]);

	// Resume once the metadata is there to seek into — before anyone presses play, so
	// the bar already reads the position when the page settles. Below the floor the
	// episode starts over, which is the rule in `listen-positions.ts`.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !remember || !duration) return;
		const stored = readPosition(workId);
		if (stored != null && stored <= duration - LISTEN_RESUME_FLOOR_SECONDS) {
			audio.currentTime = stored;
			setProgress(stored);
		}
	}, [remember, duration, workId]);

	// The app-wide remembered volume, so turning a video down turns this down too.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.volume = effectiveVolume;
		audio.muted = volume.muted;
	}, [effectiveVolume, volume.muted]);

	// The shared spoken preference — see `lib/spoken-rate.ts` for why it persists — and a
	// rate changed in the persistent bar lands here too, so both surfaces stay in step.
	useEffect(() => {
		const audio = audioRef.current;
		if (audio) audio.playbackRate = rate;
	}, [rate]);
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		const apply = (e: Event) => {
			audio.playbackRate = (e as CustomEvent<number>).detail;
		};
		window.addEventListener(SPOKEN_RATE_EVENT, apply);
		return () => window.removeEventListener(SPOKEN_RATE_EVENT, apply);
	}, []);

	// Stop the buffered tail rather than letting it run on under the wall — otherwise the
	// limit visibly does not apply, and attention keeps being credited past it.
	useEffect(() => {
		if (spent) audioRef.current?.pause();
	}, [spent]);

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

	const seekTo = (seconds: number) => {
		const audio = audioRef.current;
		if (audio && duration > 0) {
			audio.currentTime = Math.min(Math.max(0, seconds), duration);
			setProgress(audio.currentTime);
		}
	};

	const skipBy = (seconds: number) => seekTo(progress + seconds);
	const stepRate = (direction: 1 | -1) => setRate(stepSpokenRate(rate, direction));

	// The shortcut keymap, scoped to this container. No arrow-key ±5s nudge: spoken uses
	// the fixed-step buttons, and the seek bar's own arrows must keep meaning seeking.
	// j/l are the podcast pair — back fifteen, ahead thirty — so they map to the skips
	// rather than to the shared ±10 the video player binds them to.
	const onKeyDown = useMediaShortcuts({
		togglePlay,
		jump: (direction) => {
			skipBy(direction === -1 ? -SPOKEN_SKIP_BACK_SECONDS : SPOKEN_SKIP_FORWARD_SECONDS);
		},
		stepRate,
	});

	const defaultWaveform = Array.from({ length: 64 }, () => 0.3 + Math.random() * 0.5);
	const peaks = waveform && waveform.length > 0 ? waveform : defaultWaveform;

	if (spent && budget) return <PublicAccessWall budget={budget} />;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the keymap is scoped to the player by design — see useMediaShortcuts.ts for why there is no global listener.
		<div
			ref={containerRef}
			onKeyDown={onKeyDown}
			className="rounded-lg bg-base-200 p-4 focus-visible:outline-primary/50"
			tabIndex={-1}
			data-testid="spoken-player"
		>
			{/* biome-ignore lint/a11y/useMediaCaption: Anthers has no caption tracks to offer yet — the `captions` roadmap entry. The element has no native controls; everything a person uses is the transport below. */}
			<audio ref={audioRef} src={src} preload="metadata" />

			<div className="flex items-center gap-3">
				<TransportButton
					label={`Skip back ${SPOKEN_SKIP_BACK_SECONDS} seconds`}
					icon={ArrowUturnLeftIcon}
					onClick={() => skipBy(-SPOKEN_SKIP_BACK_SECONDS)}
					badge={
						<span className="absolute right-0 top-0 text-[8px] font-bold leading-none">
							{SPOKEN_SKIP_BACK_SECONDS}
						</span>
					}
				/>
				<TransportButton
					label={isPlaying ? "Pause" : "Play"}
					icon={isPlaying ? PauseIcon : PlayIcon}
					onClick={togglePlay}
					tone="primary"
				/>
				<TransportButton
					label={`Skip forward ${SPOKEN_SKIP_FORWARD_SECONDS} seconds`}
					icon={ArrowUturnRightIcon}
					onClick={() => skipBy(SPOKEN_SKIP_FORWARD_SECONDS)}
					badge={
						<span className="absolute right-0 top-0 text-[8px] font-bold leading-none">
							{SPOKEN_SKIP_FORWARD_SECONDS}
						</span>
					}
				/>

				{/*
				 * The waveform IS the scrub surface, so it goes inside the shared SeekBar
				 * rather than handling its own clicks. That is what gives audio the same
				 * keyboard seeking, focus ring and hover time the video rail has — the
				 * painting differs, the interaction does not.
				 */}
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
							height={40}
						/>
					}
				/>

				<span className="min-w-[4rem] text-right text-xs tabular-nums text-base-content/60">
					{formatTime(progress)} / {formatTime(duration)}
				</span>

				{/* The speed menu is shared with the persistent bar, so both read the same. */}
				<SpeedMenu rate={rate} onRate={setRate} />

				<div className="hidden sm:block">
					<VolumeControl collapsible size="xs" />
				</div>
			</div>

			{/*
			 * Hand the track to the persistent bar, which survives navigation.
			 *
			 * ⚠️ This player pauses ITSELF first, here rather than in the caller — the same
			 * reasoning `AudioPlayer` carries: two elements playing the same Work at once is
			 * not merely untidy, both register an attention claim on it and the listener
			 * hears the episode twice, slightly out of phase.
			 */}
			{onPlayInMiniPlayer && (
				<button
					type="button"
					onClick={() => {
						audioRef.current?.pause();
						onPlayInMiniPlayer();
					}}
					className="btn btn-ghost btn-xs mt-2"
				>
					Listen while you browse
				</button>
			)}

			{publicAccess && <PublicAccessFooter />}
		</div>
	);
}
