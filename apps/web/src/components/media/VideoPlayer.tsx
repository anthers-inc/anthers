// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The video player: HLS wiring, the Public Access meter, the Time Pool claim — and, since
 * 2026-08-13, controls that are ours rather than whatever the browser happened to draw.
 *
 * The three things this file has always had to get right are unchanged and are the
 * reason it is not just a `<video>` tag:
 *
 *   1. **Delivery is refused with a 402**, not a 403, when a viewer's monthly Public
 *      Access allowance is spent — and a media element cannot report a status code, so
 *      the player decides from the *budget* rather than from the failure.
 *   2. **Attention credits on playback**, visible tab or not, keyed on the Work.
 *   3. **Every HLS URL is minted per request** at an access-re-checking endpoint, so the
 *      manifest request must carry credentials and nothing may cache it.
 *
 * The controls are built from `transport/`, shared with the music player, so the two do
 * not read as two products. Native `controls` is gone: it was the reason there was no
 * scrubber we owned, no keyboard control, no speed, no quality picker, and no consistent
 * look between Chrome and Safari.
 */
import { PlayIcon } from "@heroicons/react/24/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { PublicAccessFooter, PublicAccessWall } from "./PublicAccessNotice";
import { useMediaShortcuts } from "./transport/useMediaShortcuts";
import { useVolume } from "./transport/volume";
import VideoControls, { PLAYBACK_RATES, type QualityLevel } from "./VideoControls";

/** How long the controls linger after the pointer stops moving, while playing. */
const CONTROLS_IDLE_MS = 2500;

interface VideoPlayerProps {
	src: string;
	poster?: string;
	autoPlay?: boolean;
	/**
	 * Whose Time Pool minutes this playback earns. Omit on surfaces where playback
	 * shouldn't be credited (previews, the Studio); the player then just plays.
	 */
	attention?: { creatorId: number | null; workId: number | null };
	/**
	 * Whether this Work draws the viewer's Public Access allowance — i.e. it is ungated,
	 * streaming and free to everyone. Comes straight from the serialized Work.
	 *
	 * Omitted or false means the meter is irrelevant here and never renders: gated work
	 * the viewer cleared, work they bought, and their own catalogue are all reached
	 * without spending an allowance, so metering them would bill somebody twice.
	 */
	publicAccess?: boolean;
}

export default function VideoPlayer({
	src,
	poster,
	autoPlay = false,
	attention,
	publicAccess = false,
}: VideoPlayerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const hlsRef = useRef<any>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [buffered, setBuffered] = useState(0);
	const [rate, setRate] = useState(1);
	const [levels, setLevels] = useState<QualityLevel[]>([]);
	const [currentLevel, setCurrentLevel] = useState(-1);
	const [activeLevelHeight, setActiveLevelHeight] = useState<number | null>(null);
	const [fullscreen, setFullscreen] = useState(false);
	const [controlsVisible, setControlsVisible] = useState(true);
	/**
	 * Set when delivery itself refuses — the backstop for an allowance that empties
	 * *between* attention flushes, where the store has not caught up yet.
	 */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { volume, effective: effectiveVolume, setLevel: setVolumeLevel, toggleMuted } = useVolume();

	/*
	 * 🚨 Decided from the BUDGET, not from the media error.
	 *
	 * The obvious implementation waits for the request to fail and reads the status, and
	 * it does not work: hls.js surfaces a 402 as a generic fatal network error on a
	 * fragment, and a plain media element gives `MEDIA_ERR_SRC_NOT_SUPPORTED` with no
	 * status at all. Both are indistinguishable from a genuine network problem, so a
	 * player built that way either mislabels outages as "you're out of hours" or says
	 * nothing — and saying nothing is the bug this whole task exists to fix.
	 *
	 * The budget arrives on every attention write, which for a playing video is every 30
	 * seconds, so this is both earlier and more certain than the failure would be.
	 */
	const spent = publicAccess && (refused || (!!budget && !budget.allowed));

	// Video credits time only while it is actually playing — a paused player on an
	// open tab earns nothing, whatever else is on the page.
	useAttentionClaim({
		creatorId: attention?.creatorId ?? null,
		workId: attention?.workId ?? null,
		contentType: "video",
		playing: isPlaying,
		active: !!attention,
	});

	// Playback state drives attention, so it's tracked on the element itself
	// rather than from our own play()/pause() calls — that way controls, keyboard
	// shortcuts, picture-in-picture, and stalls are all reflected honestly.
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		const onPlay = () => setIsPlaying(true);
		const onPause = () => setIsPlaying(false);
		const onEnded = () => setIsPlaying(false);
		const onWaiting = () => setIsPlaying(false);
		const onPlaying = () => setIsPlaying(true);
		const onTimeUpdate = () => {
			setPosition(video.currentTime);
			// Buffered ahead of the playhead, which is the only part a viewer can see the
			// benefit of. `buffered` is a list of ranges after a seek, so ask for the one
			// the playhead is actually in rather than assuming a single range from zero.
			const ranges = video.buffered;
			for (let i = 0; i < ranges.length; i++) {
				if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
					setBuffered(ranges.end(i));
					break;
				}
			}
		};
		const onDurationChange = () => setDuration(video.duration || 0);
		const onRateChange = () => setRate(video.playbackRate);

		video.addEventListener("play", onPlay);
		video.addEventListener("pause", onPause);
		video.addEventListener("ended", onEnded);
		video.addEventListener("waiting", onWaiting);
		video.addEventListener("playing", onPlaying);
		video.addEventListener("timeupdate", onTimeUpdate);
		video.addEventListener("durationchange", onDurationChange);
		video.addEventListener("ratechange", onRateChange);

		return () => {
			video.removeEventListener("play", onPlay);
			video.removeEventListener("pause", onPause);
			video.removeEventListener("ended", onEnded);
			video.removeEventListener("waiting", onWaiting);
			video.removeEventListener("playing", onPlaying);
			video.removeEventListener("timeupdate", onTimeUpdate);
			video.removeEventListener("durationchange", onDurationChange);
			video.removeEventListener("ratechange", onRateChange);
			setIsPlaying(false);
		};
	}, []);

	// The remembered volume is the app's, not this element's — so it applies on mount and
	// on every later change, including one made from a different player on the page.
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.volume = effectiveVolume;
		video.muted = volume.muted;
	}, [effectiveVolume, volume.muted]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !src) return;

		const isHls = src.endsWith(".m3u8");

		if (isHls) {
			// Try HLS.js first (most browsers)
			import("hls.js")
				.then(({ default: Hls }) => {
					if (Hls.isSupported()) {
						const hls = new Hls({
							maxBufferLength: 30,
							maxMaxBufferLength: 60,
							// Gated Works stream through our access-checked manifest endpoint,
							// which needs the session cookie. Segment requests go to the CDN via
							// signed URLs and must NOT carry credentials (would fail CORS).
							//
							// ⚠️ This tested `/api/content/posts/…/hls/` until 2026-08-12, while
							// manifests have been built at `/api/content/works/:id/hls/:file`
							// since delivery became Work-scoped. It was harmless only by
							// accident: `publicOrigin()` is `FRONTEND_URL`, so the request is
							// same-origin, and a same-origin XHR sends cookies whether or not
							// `withCredentials` is set. Move the API to its own origin and the
							// old pattern would have 403'd gated video **and silently stopped
							// metering Public Access**, since an anonymous manifest request is
							// handed the full free allowance.
							xhrSetup: (xhr: XMLHttpRequest, url: string) => {
								if (/\/api\/content\/works\/[^/]+\/hls\//.test(url)) {
									xhr.withCredentials = true;
								}
							},
						});

						// The backstop. `spent` is normally decided from the budget the
						// attention stream carries, but an allowance can empty between
						// flushes — in which case delivery refuses first and this is how the
						// player finds out. hls.js does not expose the status as anything
						// richer than a number on the response, so read it directly rather
						// than trying to classify the error.
						hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
							if (data?.response?.code === 402) {
								setRefused(true);
								refreshBudget();
								video.pause();
							}
						});

						// The variants the transcode produced. Sorted tallest-first so the
						// quality menu reads the way people expect (1080p above 480p), and
						// held in state rather than read from hls on render because a level
						// list is only known after the manifest parses.
						hls.on(Hls.Events.MANIFEST_PARSED, () => {
							setLevels(
								hls.levels
									.map((l: any, index: number) => ({
										index,
										height: l.height ?? 0,
										bitrate: l.bitrate ?? 0,
									}))
									.sort((a: QualityLevel, b: QualityLevel) => b.height - a.height),
							);
							setCurrentLevel(hls.currentLevel);
						});
						// What automatic is actually doing right now, so "Auto" can say so.
						hls.on(Hls.Events.LEVEL_SWITCHED, (_e: unknown, data: any) => {
							setActiveLevelHeight(hls.levels[data.level]?.height ?? null);
						});

						hls.loadSource(src);
						hls.attachMedia(video);
						hlsRef.current = hls;

						if (autoPlay) {
							hls.on(Hls.Events.MANIFEST_PARSED, () => {
								video.play().catch(() => {});
							});
						}
					} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
						// Safari native HLS
						video.src = src;
						if (autoPlay) video.play().catch(() => {});
					}
				})
				.catch(() => {
					// hls.js not available, try native
					video.src = src;
				});
		} else {
			// Direct file playback
			video.src = src;
			if (autoPlay) video.play().catch(() => {});
		}

		return () => {
			if (hlsRef.current) {
				hlsRef.current.destroy();
				hlsRef.current = null;
			}
			setLevels([]);
			setCurrentLevel(-1);
			setActiveLevelHeight(null);
		};
	}, [src, autoPlay]);

	// Stop what is already playing the moment the allowance goes. Without this the
	// buffered tail keeps running under the wall — which credits attention the viewer is
	// no longer entitled to spend, and looks like the limit did not apply.
	useEffect(() => {
		if (spent) videoRef.current?.pause();
	}, [spent]);

	// ── Controls ──────────────────────────────────────────────────────────────

	const togglePlay = useCallback(() => {
		const video = videoRef.current;
		if (!video) return;
		if (video.paused) video.play().catch(() => {});
		else video.pause();
	}, []);

	const seekTo = useCallback((seconds: number) => {
		const video = videoRef.current;
		if (!video) return;
		const max = Number.isFinite(video.duration) ? video.duration : seconds;
		video.currentTime = Math.min(Math.max(0, seconds), max);
		setPosition(video.currentTime);
	}, []);

	const applyRate = useCallback((next: number) => {
		const video = videoRef.current;
		if (!video) return;
		video.playbackRate = next;
		setRate(next);
	}, []);

	// -1 is hls.js's "automatic". Kept as the same value the library uses rather than a
	// separate boolean, so there is one representation of the choice and no way for a
	// pinned level and an "auto" flag to disagree.
	const applyLevel = useCallback((index: number) => {
		if (hlsRef.current) hlsRef.current.currentLevel = index;
		setCurrentLevel(index);
	}, []);

	const toggleFullscreen = useCallback(() => {
		const container = containerRef.current;
		const video = videoRef.current;
		if (!container) return;
		if (document.fullscreenElement) {
			void document.exitFullscreen();
			return;
		}
		if (container.requestFullscreen) {
			// The CONTAINER, not the element: fullscreening the <video> hands control back
			// to the browser's own chrome, which is the thing we just replaced.
			void container.requestFullscreen().catch(() => {});
		} else if (video && "webkitEnterFullscreen" in video) {
			// iPhone Safari refuses fullscreen on anything but the video element itself, so
			// there it genuinely is the native player — the one platform where that is not
			// our choice to make.
			(video as any).webkitEnterFullscreen();
		}
	}, []);

	useEffect(() => {
		const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	// Controls hide after a moment of stillness, but only while playing — a paused player
	// keeps them, because a viewer who paused is looking for a control.
	const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wakeControls = useCallback(() => {
		setControlsVisible(true);
		if (idleTimer.current) clearTimeout(idleTimer.current);
		idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
	}, []);
	useEffect(() => {
		if (!isPlaying) {
			if (idleTimer.current) clearTimeout(idleTimer.current);
			setControlsVisible(true);
			return;
		}
		wakeControls();
		return () => {
			if (idleTimer.current) clearTimeout(idleTimer.current);
		};
	}, [isPlaying, wakeControls]);

	const onKeyDown = useMediaShortcuts({
		togglePlay,
		nudge: (seconds) => seekTo((videoRef.current?.currentTime ?? 0) + seconds),
		seekFraction: (fraction) => seekTo((videoRef.current?.duration ?? 0) * fraction),
		adjustVolume: (delta) => setVolumeLevel(volume.level + delta),
		toggleMuted,
		toggleFullscreen,
		stepFrame: (direction) => {
			// Not a true frame — the element cannot tell us the frame rate — but a step
			// small enough to land on a neighbouring one at ordinary rates. Named for what
			// it is for rather than pretending to a precision it does not have.
			videoRef.current?.pause();
			seekTo((videoRef.current?.currentTime ?? 0) + direction / 24);
		},
		stepRate: (direction) => {
			const i = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number]);
			const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, i + direction))];
			if (next) applyRate(next);
		},
	});

	if (spent && budget) return <PublicAccessWall budget={budget} />;

	return (
		<>
			{/*
			 * The container IS the player: focusable, carries the keymap, and the thing
			 * fullscreen is requested on. A <section> with a label rather than a div with
			 * role="region" — same semantics, one fewer ARIA attribute to get wrong.
			 */}
			<section
				ref={containerRef}
				tabIndex={0}
				onKeyDown={onKeyDown}
				onPointerMove={wakeControls}
				onPointerLeave={() => isPlaying && setControlsVisible(false)}
				aria-label="Video player"
				className={`group/player relative overflow-hidden rounded-lg bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
					isPlaying && !controlsVisible ? "cursor-none" : ""
				}`}
			>
				<video
					ref={videoRef}
					poster={poster}
					playsInline
					// Clicking the picture plays/pauses AND focuses the container, which is
					// what makes the keyboard shortcuts reachable without a visible hint.
					onClick={() => {
						containerRef.current?.focus();
						togglePlay();
					}}
					className="aspect-video w-full cursor-pointer bg-black"
				/>

				{/* The big idle affordance. Only while paused, and it never eats the click —
				    the picture underneath is the button. */}
				{!isPlaying && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
						<span className="flex size-16 items-center justify-center rounded-full bg-primary/90 text-primary-content shadow-lg transition-transform duration-200 group-hover/player:scale-105">
							<PlayIcon className="ml-1 size-8" />
						</span>
					</div>
				)}

				<VideoControls
					playing={isPlaying}
					position={position}
					duration={duration}
					buffered={buffered}
					rate={rate}
					levels={levels}
					currentLevel={currentLevel}
					autoLevel={currentLevel === -1}
					activeLevelHeight={activeLevelHeight}
					fullscreen={fullscreen}
					visible={controlsVisible || !isPlaying}
					onTogglePlay={togglePlay}
					onSeek={seekTo}
					onRate={applyRate}
					onLevel={applyLevel}
					onToggleFullscreen={toggleFullscreen}
				/>
			</section>
			{publicAccess && <PublicAccessFooter playing={isPlaying} />}
		</>
	);
}
