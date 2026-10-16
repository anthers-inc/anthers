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
 *
 * ## Two ownership modes, and only one renders an element
 *
 * - **Local** (default): the page owns a `<audio>` element, a claim, resume writes and
 *   the meter's wall — the Studio preview's mode, and the Work page's when the account's
 *   Use Persistent Miniplayer is off.
 * - **Bar-driven** (`persistent` set to the Work's queue track): pressing play queues
 *   the track into `MediaPlayerProvider` — the persistent footer bar, which survives
 *   navigation — and everything below mirrors the bar instead of owning a second
 *   element. The bar already carries the spoken resume, the rate and the position
 *   writes, so mirroring it is not a second engine; claiming here too would put two
 *   claims on one (creator, Work), and two elements would play the episode twice.
 */

import type { WorkChapter } from "@anthers/shared/chapters";
import {
	ArrowUturnLeftIcon,
	ArrowUturnRightIcon,
	PauseIcon,
	PlayIcon,
} from "@heroicons/react/24/solid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import {
	LISTEN_RESUME_FLOOR_SECONDS,
	readPosition,
	writePosition,
} from "../../lib/listen-positions";
import { useMediaPlayer } from "../../lib/media-player";
import type { QueueTrack } from "../../lib/music-queue";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { SPOKEN_RATE_EVENT, stepSpokenRate, useSpokenRate } from "../../lib/spoken-rate";
import { useBindPlayerSeek } from "../../lib/work-player";
import ChapterList from "./ChapterList";
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
	 * The Work's queue track (`trackFromWork`), present only when the persistent bar
	 * owns this page's playback — the account's Use Persistent Miniplayer setting.
	 */
	persistent?: QueueTrack;
	/**
	 * Restore from a remembered position and persist as it moves. Off only where resume
	 * would be a lie — the Studio's own preview, which is not the listening the Work is for.
	 */
	remember?: boolean;
	/**
	 * Whose Time Pool minutes this playback earns. Omit on surfaces where playback
	 * shouldn't be credited (previews, the Studio); the player then just plays.
	 * Bar-driven playback claims through the bar instead, so this never double-claims.
	 */
	attention?: { creatorId: number | null; workId: number | null };
	/**
	 * Whether this Work draws the user's Public Access allowance. Same meaning as on
	 * `AudioPlayer` — see there for why gated, bought and own-catalog playback are exempt.
	 */
	publicAccess?: boolean;
	/** The Work's chapters, parsed from its description — the list under the transport. */
	chapters?: WorkChapter[];
	/** Where the Work opens — the `?t` a timestamp link put in the address. */
	startSeconds?: number | null;
}

export default function SpokenPlayer({
	src,
	workId,
	waveform,
	persistent,
	remember = true,
	attention,
	publicAccess = false,
	chapters,
	startSeconds = null,
}: SpokenPlayerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const [elPlaying, setElPlaying] = useState(false);
	const [elProgress, setElProgress] = useState(0);
	const [elDuration, setElDuration] = useState(0);
	/** Delivery refused — the backstop for an allowance emptied between flushes. */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { volume, effective: effectiveVolume } = useVolume();
	const [rate, setRate] = useSpokenRate();

	// The bar to drive in persistent mode — a ref because the callbacks below must
	// stay stable (the seek binding and the shortcuts re-bind on identity changes)
	// while the context re-renders on every playback tick.
	const player = useMediaPlayer();
	const playerRef = useRef(player);
	playerRef.current = player;
	const trackRef = useRef<QueueTrack | null>(persistent ?? null);
	trackRef.current = persistent ?? null;
	/** The bar is currently carrying this Work's track. */
	const onBar = persistent != null && player.currentTrack?.workId === persistent.workId;

	// Local mode reads the element; bar-driven mode reads the bar. When the bar holds
	// some *other* track, the transport reads zeros — nothing is playing *here* — and
	// its play button queues this Work.
	const isPlaying = persistent ? onBar && player.isPlaying : elPlaying;
	const progress = persistent ? (onBar ? player.progress : 0) : elProgress;
	const duration = persistent ? (onBar ? player.duration : 0) : elDuration;

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
	// Bar-driven playback claims through the bar's own hook; claiming here too would
	// put two claims on one (creator, Work).
	useAttentionClaim({
		creatorId: attention?.creatorId ?? null,
		workId: attention?.workId ?? null,
		contentType: "audio",
		playing: isPlaying,
		active: !!attention && persistent == null,
	});

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		const onTimeUpdate = () => {
			setElProgress(audio.currentTime);
			if (remember) writePosition(workId, audio.currentTime, audio.duration || null);
		};
		const onDurationChange = () => setElDuration(audio.duration || 0);
		const onEnded = () => {
			setElPlaying(false);
			if (remember)
				writePosition(workId, audio.currentTime, audio.duration || null, { force: true });
		};
		const onPlay = () => setElPlaying(true);
		// Mirror the element's own state so pausing via anything other than our button
		// (media keys, another tab claiming audio focus) is reflected and flushed.
		const onPause = () => {
			setElPlaying(false);
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
			setElPlaying(false);
		};
	}, [publicAccess, remember, workId]);

	// Resume once the metadata is there to seek into — before anyone presses play, so
	// the bar already reads the position when the page settles. Below the floor the
	// episode starts over, which is the rule in `listen-positions.ts`.
	// ⚠️ A landed `?t` outranks the resume: a link that names a moment means that
	// moment, not wherever the listener was last.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !remember || !elDuration || startSeconds != null) return;
		const stored = readPosition(workId);
		if (stored != null && stored <= elDuration - LISTEN_RESUME_FLOOR_SECONDS) {
			audio.currentTime = stored;
			setElProgress(stored);
		}
	}, [remember, elDuration, workId, startSeconds]);

	// The app-wide remembered volume, so turning a video down turns this down too.
	// Bar-driven playback gets its volume from the bar, which reads the same store.
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
	// limit visibly does not apply, and attention keeps being credited past it. The bar
	// pauses its own element for bar-driven playback.
	useEffect(() => {
		if (spent) audioRef.current?.pause();
	}, [spent]);

	const togglePlay = useCallback(() => {
		const track = trackRef.current;
		if (track) {
			const bar = playerRef.current;
			if (bar.currentTrack?.workId === track.workId && startSeconds == null) {
				// The bar already carries this Work: the button is its transport.
				if (bar.isPlaying) {
					bar.pause();
				} else {
					bar.resume();
				}
			} else {
				// Queue the Work into the bar — including again, when `?t` says the
				// moment a link named has to land even though the bar holds the track.
				bar.playTracks([track], 0, startSeconds != null ? { startAt: startSeconds } : {});
			}
			return;
		}
		const audio = audioRef.current;
		if (!audio) return;
		if (elPlaying) {
			audio.pause();
			setElPlaying(false);
		} else {
			audio.play().catch(() => {});
			setElPlaying(true);
		}
	}, [startSeconds, elPlaying]);

	const seekTo = useCallback((seconds: number) => {
		const track = trackRef.current;
		if (track) {
			const bar = playerRef.current;
			if (bar.currentTrack?.workId === track.workId) {
				bar.seek(seconds);
			} else {
				// The bar holds no track of this Work, and the page has no element of
				// its own: a seek that names a moment starts listening at it. A
				// chapter cue or a timestamp link that did nothing would be a page
				// whose links lie, so "start here" is what the unreachable seek means.
				bar.playTracks([track], 0, { startAt: seconds });
			}
			return;
		}
		const audio = audioRef.current;
		if (!audio) return;
		/*
		 * Read the element's own duration, not the `duration` state — the state trails the
		 * element by a `durationchange` event, and a render that remounted the element has
		 * the real value while the state is still catching up. A zero-duration element (no
		 * metadata yet) cannot seek, and clamping against Infinity keeps the tap harmless
		 * rather than refused.
		 */
		const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
		audio.currentTime = Math.min(Math.max(0, seconds), max);
		setElProgress(audio.currentTime);
	}, []);

	// The page's timestamp links — description and reviews both — seek through here.
	useBindPlayerSeek(seekTo);

	// The landed `?t`, applied once the element has a duration to seek into, once —
	// re-applied after a rate change or a stall it would be a second entry point, not one.
	// (Bar-driven playback opens at it through `playTracks`' `startAt` instead — and
	// a seek naming a moment starts the bar there, via seekTo above.)
	const [startApplied, setStartApplied] = useState(false);
	useEffect(() => {
		if (persistent || startApplied || startSeconds == null || !duration) return;
		setStartApplied(true);
		seekTo(startSeconds);
	}, [persistent, duration, startSeconds, startApplied, seekTo]);

	const skipBy = useCallback(
		(seconds: number) => {
			const track = trackRef.current;
			if (track) {
				const bar = playerRef.current;
				if (bar.currentTrack?.workId === track.workId) {
					bar.seek(bar.progress + seconds);
				} else {
					// Nothing in the bar: the skip starts the Work at its stepped
					// moment, the same meaning the seek bar's unreachable drag has.
					bar.playTracks([track], 0, { startAt: Math.max(0, seconds) });
				}
				return;
			}
			seekTo((audioRef.current?.currentTime ?? 0) + seconds);
		},
		[seekTo],
	);
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

	const defaultWaveform = useMemo(
		() => Array.from({ length: 64 }, () => 0.3 + Math.random() * 0.5),
		[],
	);
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
			{/* Bar-driven mode renders no element — the bar owns the one <audio>. */}
			{!persistent && (
				// biome-ignore lint/a11y/useMediaCaption: Anthers has no caption tracks to offer yet — the `captions` roadmap entry. The element has no native controls; everything a person uses is the transport below.
				<audio ref={audioRef} src={src} preload="metadata" />
			)}

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

			{/* The creator's chapters, inside the transport — the list that answers "what
			    am I listening to", and the reason a titled lecture or interview episode
			    doesn't read as one unbroken bar of waveform. */}
			{chapters && chapters.length > 0 && (
				<ChapterList chapters={chapters} position={progress} duration={duration} onSeek={seekTo} />
			)}

			{publicAccess && <PublicAccessFooter />}
		</div>
	);
}
