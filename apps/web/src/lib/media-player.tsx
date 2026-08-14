// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The listening session: one `<audio>` element that survives navigation, driven by the
 * pure queue model in `./music-queue`.
 *
 * This used to hold exactly one `Track` — no queue, no next, no shuffle, no notion of an
 * album being played. You could play *a* track; you could not put on a record.
 *
 * The split is deliberate and load-bearing: **`music-queue.ts` decides what should play**
 * (order, shuffle, repeat, what to do about a track the listener cannot reach) and is pure
 * and exhaustively tested without a browser; **this file owns the element** and the three
 * things that are genuinely about the browser — playback state, the Public Access meter,
 * and the Time Pool claim.
 *
 * ## Three Anthers rules the queue has to carry, all of which fail silently
 *
 * 1. **Audio URLs are minted per request.** A `QueueTrack.src` is the delivery *endpoint*
 *    (`/api/content/works/:id/audio`), which re-resolves access and redirects to a signed
 *    URL. So a queue built an hour ago is still safe to advance into: every play goes back
 *    through the check. Nothing here may cache what that endpoint redirects to.
 * 2. **A queue can hold a track the listener cannot play**, and that is ordinary rather
 *    than exceptional. Auto-advance steps over it; an explicit choice sits on it and says
 *    why. See `music-queue.ts`.
 * 3. **The attention claim must follow the queue.** It is keyed on `(creatorId, workId)`
 *    and re-registers whenever the track changes, so a queue crossing three creators pays
 *    three creators. Getting this wrong pays nobody and reports nothing — the failure the
 *    single-track hook was never built to avoid.
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { effectiveVolume, useVolume } from "../components/media/transport/volume";
import { useAttentionClaim } from "./attention";
import {
	cycleRepeat as cycleRepeatState,
	EMPTY_QUEUE,
	hasNext as hasNextIn,
	hasPrevious as hasPreviousIn,
	isPlayable,
	jumpTo as jumpToIn,
	nextPosition,
	nowPlaying as nowPlayingIn,
	previousPosition,
	type QueueState,
	type QueueTrack,
	type RepeatMode,
	startQueue,
	toggleShuffle as toggleShuffleState,
	upcoming as upcomingIn,
} from "./music-queue";
import { refreshBudget, useMeteredBudget } from "./public-access";

export type { QueueTrack, RepeatMode };

interface MediaPlayerContextValue {
	/** The track the bar is showing. Null when nothing is queued. */
	currentTrack: QueueTrack | null;
	isPlaying: boolean;
	progress: number;
	duration: number;
	shuffle: boolean;
	repeat: RepeatMode;
	/** What follows, in play order, with the position to jump to. */
	upcoming: { track: QueueTrack; pos: number }[];
	hasNext: boolean;
	hasPrevious: boolean;
	/**
	 * True when the current track is selected but cannot be played — gated, and the
	 * listener chose it anyway. The bar says so rather than stalling.
	 */
	locked: boolean;
	/**
	 * True when delivery is refusing because the monthly Public Access allowance is spent.
	 * Distinct from `locked`: the work is free, the *hours* ran out.
	 */
	allowanceSpent: boolean;

	/** Play a list of tracks from `startIndex` — an album, a shelf, a single track. */
	playTracks: (tracks: QueueTrack[], startIndex?: number, options?: { shuffle?: boolean }) => void;
	pause: () => void;
	resume: () => void;
	seek: (time: number) => void;
	next: () => void;
	previous: () => void;
	jumpTo: (pos: number) => void;
	toggleShuffle: () => void;
	cycleRepeat: () => void;
	close: () => void;
}

const MediaPlayerContext = createContext<MediaPlayerContextValue | null>(null);

export function MediaPlayerProvider({ children }: { children: ReactNode }) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [state, setState] = useState<QueueState>(EMPTY_QUEUE);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);
	/** Delivery refused — the backstop for an allowance emptied between attention flushes. */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { volume } = useVolume();

	const current = nowPlayingIn(state);
	const locked = current != null && !isPlayable(current);

	/*
	 * 🚨 Decided from the BUDGET, not from the element's error — the same reasoning as in
	 * the two players. A media element cannot report a status code: a 402 arrives as
	 * `MEDIA_ERR_SRC_NOT_SUPPORTED`, indistinguishable from a corrupt file or a dead
	 * network. The budget rides back on every attention write, so the bar knows before the
	 * request is made and never mislabels an outage as "you're out of hours".
	 */
	const allowanceSpent =
		(current?.publicAccess ?? false) && (refused || (!!budget && !budget.allowed));

	// ── The element ───────────────────────────────────────────────────────────

	useEffect(() => {
		const audio = new Audio();
		audio.preload = "metadata";
		audioRef.current = audio;

		const onTimeUpdate = () => setProgress(audio.currentTime);
		const onDurationChange = () => setDuration(audio.duration || 0);
		const onPlay = () => setIsPlaying(true);
		const onPause = () => setIsPlaying(false);

		audio.addEventListener("timeupdate", onTimeUpdate);
		audio.addEventListener("durationchange", onDurationChange);
		audio.addEventListener("play", onPlay);
		audio.addEventListener("pause", onPause);

		return () => {
			audio.removeEventListener("timeupdate", onTimeUpdate);
			audio.removeEventListener("durationchange", onDurationChange);
			audio.removeEventListener("play", onPlay);
			audio.removeEventListener("pause", onPause);
			audio.pause();
			audio.src = "";
		};
	}, []);

	/**
	 * Advance when a track ends.
	 *
	 * A separate effect from the element setup because it closes over the queue, which
	 * changes constantly — binding it once would advance against a stale queue forever,
	 * which is the classic version of this bug and looks like "next sometimes plays the
	 * wrong thing".
	 */
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		const onEnded = () => {
			if (state.repeat === "one") {
				audio.currentTime = 0;
				void audio.play().catch(() => {});
				return;
			}
			// `true`: this is the queue advancing on its own, so step over anything the
			// listener cannot play rather than stopping dead on a gate they never chose.
			const pos = nextPosition(state, true);
			if (pos === null) setIsPlaying(false);
			else setState((s) => jumpToIn(s, pos));
		};

		// The element cannot say 402, so treat a load failure on Public Access work as
		// worth re-reading the budget for. If the allowance is intact the store is
		// unchanged and this stays silent — the right outcome for a network blip.
		const onError = () => {
			if (!current?.publicAccess) return;
			setRefused(true);
			refreshBudget();
		};

		audio.addEventListener("ended", onEnded);
		audio.addEventListener("error", onError);
		return () => {
			audio.removeEventListener("ended", onEnded);
			audio.removeEventListener("error", onError);
		};
	}, [state, current]);

	/**
	 * Point the element at the current track.
	 *
	 * Keyed on `src` rather than on the track object: re-rendering with an equal-but-new
	 * object must not restart the song, which is what makes a bar that re-renders on every
	 * timeupdate survivable.
	 */
	const src = current?.src ?? null;
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		// A newly chosen track clears a previous refusal: it may be a different Work
		// entirely, and one that is gated or bought draws no allowance at all.
		setRefused(false);
		setProgress(0);
		setDuration(0);
		if (!src) {
			audio.pause();
			audio.removeAttribute("src");
			audio.load();
			return;
		}
		audio.src = src;
		void audio.play().catch(() => {
			// Autoplay refusal (no user gesture yet) is not an error worth surfacing — the
			// bar simply shows a paused track with a play button, which is the truth.
		});
	}, [src]);

	// The app-wide remembered volume, shared with both inline players.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.volume = effectiveVolume(volume);
		audio.muted = volume.muted;
	}, [volume]);

	// Stop the buffered tail the moment the allowance goes. Without this, playback runs on
	// under the notice — crediting attention the listener is no longer entitled to spend,
	// and making the limit look like it did not apply.
	useEffect(() => {
		if (allowanceSpent) audioRef.current?.pause();
	}, [allowanceSpent]);

	/*
	 * The Time Pool claim, following the queue.
	 *
	 * `workId` and `creatorId` are in the hook's dependencies, so crossing into the next
	 * track tears down one claim and registers another — which is the entire requirement,
	 * and the one that fails without any symptom. A queue spanning three creators has to
	 * pay three creators; a claim pinned to whatever was playing first would quietly pay
	 * one of them for all of it.
	 */
	useAttentionClaim({
		creatorId: current?.creatorId ?? null,
		workId: current?.workId ?? null,
		contentType: "audio",
		playing: isPlaying,
		active: !!current && !locked,
	});

	// ── Controls ──────────────────────────────────────────────────────────────

	const playTracks = useCallback(
		(tracks: QueueTrack[], startIndex = 0, options: { shuffle?: boolean } = {}) => {
			setState((s) => startQueue(s, tracks, startIndex, options));
		},
		[],
	);

	const pause = useCallback(() => audioRef.current?.pause(), []);
	const resume = useCallback(() => {
		void audioRef.current?.play().catch(() => {});
	}, []);

	const seek = useCallback((time: number) => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.currentTime = time;
		setProgress(time);
	}, []);

	// `false`: the listener pressed next, so give them the next track — even a gated one,
	// which then says why. Skipping on their behalf would play something they did not ask
	// for and hide the gate.
	const next = useCallback(() => {
		setState((s) => {
			const pos = nextPosition(s, false);
			return pos === null ? s : jumpToIn(s, pos);
		});
	}, []);

	const previous = useCallback(() => {
		setState((s) => {
			const pos = previousPosition(s);
			return pos === null ? s : jumpToIn(s, pos);
		});
	}, []);

	const jumpTo = useCallback((pos: number) => setState((s) => jumpToIn(s, pos)), []);
	const toggleShuffle = useCallback(() => setState(toggleShuffleState), []);
	const cycleRepeat = useCallback(() => setState(cycleRepeatState), []);

	const close = useCallback(() => {
		const audio = audioRef.current;
		if (audio) {
			audio.pause();
			audio.removeAttribute("src");
			audio.load();
		}
		setState(EMPTY_QUEUE);
		setIsPlaying(false);
		setProgress(0);
		setDuration(0);
		setRefused(false);
	}, []);

	const value = useMemo<MediaPlayerContextValue>(
		() => ({
			currentTrack: current,
			isPlaying,
			progress,
			duration,
			shuffle: state.shuffle,
			repeat: state.repeat,
			upcoming: upcomingIn(state),
			hasNext: hasNextIn(state),
			hasPrevious: hasPreviousIn(state),
			locked,
			allowanceSpent,
			playTracks,
			pause,
			resume,
			seek,
			next,
			previous,
			jumpTo,
			toggleShuffle,
			cycleRepeat,
			close,
		}),
		[
			current,
			isPlaying,
			progress,
			duration,
			state,
			locked,
			allowanceSpent,
			playTracks,
			pause,
			resume,
			seek,
			next,
			previous,
			jumpTo,
			toggleShuffle,
			cycleRepeat,
			close,
		],
	);

	return <MediaPlayerContext.Provider value={value}>{children}</MediaPlayerContext.Provider>;
}

export function useMediaPlayer(): MediaPlayerContextValue {
	const context = useContext(MediaPlayerContext);
	if (!context) {
		throw new Error("useMediaPlayer must be used within a MediaPlayerProvider");
	}
	return context;
}
