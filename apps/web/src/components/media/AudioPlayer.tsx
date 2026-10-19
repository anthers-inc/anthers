// SPDX-License-Identifier: Apache-2.0
/**
 * The music player — the on-page surface for a music Work: a waveform scrubber you
 * can click, chapters if the creator cued them, lyrics under it.
 *
 * The player has two ownership modes and only one renders an element:
 *
 * - **Local** (default): the page owns a `<audio>` element, an attention claim, the
 *   meter's wall and the full element wiring. This is the Studio preview's mode, and
 *   the Work page's when the account's Use Persistent Miniplayer is off.
 * - **Bar-driven** (`persistent` set to the Work's queue track): pressing play queues
 *   the track into `MediaPlayerProvider` — the persistent footer bar, which survives
 *   navigation — and everything below mirrors the bar instead of owning a second
 *   element. Two elements playing one Work at once is the double-claim bug whose
 *   hand-off comment this design retires: the bar is the single engine, so it cannot
 *   come back.
 *
 * And two layouts: the **strip** (below) is where the medium stands alone — the embed
 * route's bare window, the fallback branches — and the **stage** (`stage`, set by
 * `WorkDeliverable` when the media frame holds this page) is the frame's fill, where
 * the waveform is the page's reading surface (`ListenStage`), the transport sits at
 * its foot, and a song's words open as a drawer over the waveform's right side. Both
 * layouts read their state identically, by the two-mode rule above.
 *
 * The element's state and the bar's mirror are both named `isPlaying` / `progress` /
 * `duration` below so the transport JSX never branches on mode.
 */

import type { WorkChapter } from "@anthers/shared/chapters";
import {
	ArrowUturnLeftIcon,
	ArrowUturnRightIcon,
	PauseIcon,
	PlayIcon,
} from "@heroicons/react/24/solid";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { useMediaPlayer } from "../../lib/media-player";
import type { QueueTrack } from "../../lib/music-queue";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { useBindPlayerSeek } from "../../lib/work-player";
import ChapterList from "./ChapterList";
import { AsideDrawer, AsideToggle } from "./ListenStage";
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
	/**
	 * The Work's queue track (`trackFromWork`), present only when the persistent bar
	 * owns this page's playback — the account's Use Persistent Miniplayer setting.
	 * Nothing renders the bar itself; the player just drives and mirrors it.
	 */
	persistent?: QueueTrack;
	/**
	 * The stage layout — the media frame's fill — where this page's media area is
	 * held by `WorkMediaFrame` and the waveform is the page's reading surface rather
	 * than a strip inside the row. Absent (the embed's bare window, and the
	 * fallback branches that have no frame to fill): yesterday's strip.
	 */
	stage?: boolean;
	/**
	 * What the stage's aside drawer holds when it is open — a song's words on the read;
	 * the creator's lyrics field there. Null means the Work carries nothing to open,
	 * and no toggle renders. It always starts closed: the drawer is the toggle's to
	 * open, whichever face is inside it (Parker, 2026-10-19).
	 */
	aside?: ReactNode;
	/**
	 * Whose Time Pool minutes this playback earns. Omit on surfaces where playback
	 * shouldn't be credited (previews, the Studio); the player then just plays.
	 * Bar-driven playback claims through the bar instead, so this never double-claims.
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
	persistent,
	stage = false,
	aside = null,
	attention,
	publicAccess = false,
	chapters,
	startSeconds = null,
}: AudioPlayerProps) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [elPlaying, setElPlaying] = useState(false);
	const [elProgress, setElProgress] = useState(0);
	const [elDuration, setElDuration] = useState(0);
	/** Delivery refused — the backstop for an allowance emptied between flushes. */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { volume, effective: effectiveVolume, setLevel, toggleMuted } = useVolume();

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
	// some *other* track (an album queued from the Library, say), the page transport
	// reads zeros — nothing is playing *here* — and its play button queues this Work.
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

	// The placeholder for a track whose waveform has not been computed yet. Held in a
	// memo — without it every `timeupdate` rolls a new shape and the bar flickers.
	const defaultWaveform = useMemo(
		() => Array.from({ length: 64 }, () => 0.3 + Math.random() * 0.5),
		[],
	);
	const peaks = waveform && waveform.length > 0 ? waveform : defaultWaveform;

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

		const onTimeUpdate = () => setElProgress(audio.currentTime);
		const onDurationChange = () => setElDuration(audio.duration || 0);
		const onEnded = () => setElPlaying(false);
		// Mirror the element's own state so pausing via anything other than our
		// button (media keys, another tab claiming audio focus) is reflected.
		const onPlay = () => setElPlaying(true);
		const onPause = () => setElPlaying(false);
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
			setElPlaying(false);
		};
	}, [publicAccess]);

	// The app-wide remembered volume, so turning a video down turns this down too.
	// Bar-driven playback gets its volume from the bar, which reads the same store.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.volume = effectiveVolume;
		audio.muted = volume.muted;
	}, [effectiveVolume, volume.muted]);

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
		 * The element's own duration, not the state — the state trails by a
		 * `durationchange`, and the other two players read it this way.
		 */
		const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
		audio.currentTime = Math.min(Math.max(0, seconds), max);
		setElProgress(audio.currentTime);
	}, []);

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

	// The keyboard keymap, scoped to the player — see useMediaShortcuts.ts. Arrows nudge
	// five seconds and j/l take the buttons' ten, which for a song's skips is the whole map.
	// Bar-driven playback reads the bar's duration for the percentage seek and drives the
	// bar's transport for everything else.
	const onKeyDown = useMediaShortcuts({
		togglePlay,
		nudge: skipBy,
		seekFraction: (fraction) => seekTo(fraction * (audioRef.current?.duration ?? duration ?? 0)),
		adjustVolume: (delta) => setLevel(volume.level + delta),
		toggleMuted,
	});

	// The page's timestamp links — description and reviews both — seek through here.
	useBindPlayerSeek(seekTo);

	// The landed `?t`, applied once the element has a duration to seek into, once.
	// (Bar-driven playback opens at it through `playTracks`' `startAt` instead — and
	// a seek naming a moment starts the bar there, via seekTo above.)
	const [startApplied, setStartApplied] = useState(false);
	useEffect(() => {
		if (persistent || startApplied || startSeconds == null || !duration) return;
		setStartApplied(true);
		seekTo(startSeconds);
	}, [persistent, duration, startSeconds, startApplied, seekTo]);

	// Stop the buffered tail rather than letting it run on under the wall — otherwise the
	// limit visibly does not apply, and attention keeps being credited past it. The bar
	// pauses its own element for bar-driven playback.
	useEffect(() => {
		if (spent) audioRef.current?.pause();
	}, [spent]);

	/** The aside drawer's state — closed until the transport's toggle asks for it. */
	const [asideShown, setAsideShown] = useState(false);

	if (spent && budget) return <PublicAccessWall budget={budget} />;

	const skipCluster = (
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
	);

	if (stage) {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the keymap is scoped to the player by design — see useMediaShortcuts.ts for why there is no global listener.
			<div
				tabIndex={-1}
				onKeyDown={onKeyDown}
				data-testid="audio-player"
				className="flex h-full min-h-0 w-full flex-col gap-3 focus-visible:outline-primary/50 sm:gap-4"
			>
				{/* Bar-driven mode renders no element — the bar owns the one <audio>. */}
				{!persistent && (
					// biome-ignore lint/a11y/useMediaCaption: Anthers has no caption tracks to offer yet — the `captions` roadmap entry. The element has no native controls; everything a person uses is the transport below.
					<audio ref={audioRef} src={src} preload="metadata" />
				)}

				{/*
				 * The stage's hero: the waveform IS the page's reading surface here, the
				 * playhead and the hover time it carries are the shared SeekBar's, and
				 * filling the media frame's profile is the composition's own flex. On a
				 * phone the hero does not stand — a box two hundred pixels tall holds no
				 * reading surface — and the transport's strip carries the shape instead;
				 * it stands only while the aside is open, because the drawer needs an
				 * area to cover and the words need somewhere to scroll.
				 *
				 * ⭐ The aside is an overlay inside this row, not a column beside it
				 * (Parker, 2026-10-19): its height is the waveform area's rather than the
				 * lyrics', so the media card is the same size whatever the song's words
				 * fill. Nothing here may let the aside make this row grow.
				 */}
				<div
					className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${
						aside != null && asideShown ? "block max-sm:min-h-[45vh]" : "hidden"
					} sm:block`}
				>
					<SeekBar
						position={progress}
						duration={duration}
						onSeek={seekTo}
						label="Seek audio"
						stretch
						track={
							<WaveformDisplay peaks={peaks} progress={duration > 0 ? progress / duration : 0} />
						}
					/>
					{aside != null && (
						<AsideDrawer label="Lyrics" open={asideShown} onClose={() => setAsideShown(false)}>
							{aside}
						</AsideDrawer>
					)}
				</div>

				{/*
				 * The transport, at the stage's foot, with the play cluster centered: the
				 * times flank it as one group, and only the volume and the lyrics toggle
				 * sit at the row's edges. A `1fr auto 1fr` grid centers the cluster on the
				 * page rather than on the space the side controls leave (Parker,
				 * 2026-10-19). The waveform strip above it is the phone's, where the hero
				 * does not stand.
				 */}
				<div className="flex w-full flex-col gap-3">
					<div className="min-w-0 sm:hidden">
						<SeekBar
							position={progress}
							duration={duration}
							onSeek={seekTo}
							label="Seek audio"
							track={
								<WaveformDisplay
									peaks={peaks}
									progress={duration > 0 ? progress / duration : 0}
									height={48}
								/>
							}
						/>
					</div>
					<div className="flex w-full flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-x-2">
						<span aria-hidden className="hidden sm:block" />
						<div className="flex items-center justify-center gap-2 sm:gap-4">
							<span
								data-testid="audio-elapsed"
								className="min-w-[2.5rem] text-right text-xs tabular-nums text-base-content/60"
							>
								{formatTime(progress)}
							</span>
							{skipCluster}
							<span
								data-testid="audio-remaining"
								className="min-w-[2.5rem] text-xs tabular-nums text-base-content/60"
							>
								{formatRemaining(progress, duration)}
							</span>
						</div>
						<div className="flex items-center justify-end gap-1">
							<div className="hidden sm:block">
								<VolumeControl collapsible size="xs" />
							</div>
							{aside != null && (
								<AsideToggle
									label="Lyrics"
									open={asideShown}
									onToggle={() => setAsideShown((o) => !o)}
								/>
							)}
						</div>
					</div>
				</div>

				{/* The creator's chapters from the description, inside the transport — a song
				    whose creator cues verse and chorus by the clock keeps its listeners there. */}
				{chapters && chapters.length > 0 && (
					<ChapterList
						chapters={chapters}
						position={progress}
						duration={duration}
						onSeek={seekTo}
					/>
				)}

				{publicAccess && <PublicAccessFooter />}
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the keymap is scoped to the player by design — see useMediaShortcuts.ts for why there is no global listener.
		<div
			tabIndex={-1}
			onKeyDown={onKeyDown}
			data-testid="audio-player"
			className="rounded-lg bg-base-200 p-4 focus-visible:outline-primary/50 sm:p-5"
		>
			{/* Bar-driven mode renders no element — the bar owns the one <audio>. */}
			{!persistent && (
				// biome-ignore lint/a11y/useMediaCaption: Anthers has no caption tracks to offer yet — the `captions` roadmap entry. The element has no native controls; everything a person uses is the transport below.
				<audio ref={audioRef} src={src} preload="metadata" />
			)}

			<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
				{skipCluster}

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

			{publicAccess && <PublicAccessFooter />}
		</div>
	);
}
