// SPDX-License-Identifier: Apache-2.0
/**
 * The video player: HLS wiring, the Public Access meter, the Time Pool claim — and, since
 * 2026-08-13, controls that are ours rather than whatever the browser happened to draw.
 *
 * The three things this file has always had to get right are unchanged and are the
 * reason it is not just a `<video>` tag:
 *
 *   1. **Delivery is refused with a 402**, not a 403, when a user's monthly Public
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

import type { WorkChapter } from "@anthers/shared/chapters";
import { apiFetch } from "@anthers/web-shared/rpc";
import type { WorkCaptionTrack } from "@anthers/web-shared/types";
import { PlayIcon } from "@heroicons/react/24/solid";
import type HlsInstance from "hls.js";
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { useMediaPlayer } from "../../lib/media-player";
import type { QueueTrack } from "../../lib/music-queue";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { useBindPlayerSeek } from "../../lib/work-player";
import ChapterList from "./ChapterList";
import { PublicAccessFooter, PublicAccessWall } from "./PublicAccessNotice";
import { useMediaShortcuts } from "./transport/useMediaShortcuts";
import { useVolume } from "./transport/volume";
import VideoControls, { PLAYBACK_RATES, type QualityLevel } from "./VideoControls";

/** How long the controls linger after the pointer stops moving, while playing. */
const CONTROLS_IDLE_MS = 2500;

/**
 * The remembered captions choice — on/off only, shared across every video the app plays,
 * because a viewer who fixed "this talks to me" once does not want to say it again. The
 * language picked is a per-video choice; the preference answers whether captions are
 * wanted at all. Never-set and "off" both play silent, which is the mainstream player
 * default and the smaller surprise.
 */
const CAPTIONS_PREF_KEY = "anthers.captions";
function readCaptionPref(): "on" | "off" {
	try {
		return localStorage.getItem(CAPTIONS_PREF_KEY) === "on" ? "on" : "off";
	} catch {
		return "off";
	}
}
function writeCaptionPref(value: "on" | "off") {
	try {
		localStorage.setItem(CAPTIONS_PREF_KEY, value);
	} catch {
		// Storage can refuse in private modes; the choice then is per-video, which is
		// degraded remembering, not broken captions.
	}
}

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
	 * Whether this Work draws the user's Public Access allowance — i.e. it is ungated,
	 * streaming and free to everyone. Comes straight from the serialized Work.
	 *
	 * Omitted or false means the meter is irrelevant here and never renders: gated work
	 * the user cleared, work they bought, and their own catalog are all reached
	 * without spending an allowance, so metering them would bill somebody twice.
	 */
	publicAccess?: boolean;
	/**
	 * Called when the video ends. The Channel Guide's auto-advance rides this (its
	 * preference is opt-in; nothing else wires it today). Deliberately **called on the
	 * ended event only** — a pause or a stall is not an end — and the caller decides
	 * what "next" even is.
	 */
	onEnded?: () => void;
	/**
	 * Handed the `<video>` element, for a caller that reads the picture it is showing — the
	 * Studio's *Use This Frame*, which draws the paused frame into a thumbnail.
	 */
	elementRef?: MutableRefObject<HTMLVideoElement | null>;
	/**
	 * The Podcast-This hand-off: everything needed to put this video's audio rendition
	 * into the listening queue as spoken word. Absent when the Work carries no audio
	 * rendition — the settings panel then renders no such row.
	 */
	podcast?: {
		audioManifestUrl: string;
		track: Omit<QueueTrack, "src" | "kind">;
	};
	/**
	 * "Original Media": the Work's original file at its access-checked route, offered in
	 * the quality menu as an opted-into alternative to the ladder. Absent for a user the
	 * serialization refused (the gate already bit) and for a video before its ladder —
	 * which plays the original *by default*, so the menu then has nothing to offer.
	 */
	originalUrl?: string | null;
	/**
	 * The Work's caption tracks, as the detail payload carries them, gated with the video
	 * like every other deliverable. Each renders as a `<track>` child whose bytes come
	 * from the same access-checked captions route the payload built the URL with, so a
	 * share-link viewer's token rides and a stranger gets the gate. Absent or empty means
	 * no menu and no shortcut — the a11y lint note on the `<video>` element says why it
	 * is still satisfied.
	 */
	captions?: WorkCaptionTrack[];
	/**
	 * The Work's chapters, parsed from its description by the shared parser — the rows
	 * the seek bar segments over and the list this player mounts beneath the picture.
	 * Absent or empty leaves both out; the transport reads unchanged.
	 */
	chapters?: WorkChapter[];
	/**
	 * Where the Work opens — the `?t` a timestamp link put in the address, landed back
	 * at the moment it named. Overrides nothing here (video keeps no resume state);
	 * the spoken player's resume yields to it.
	 */
	startSeconds?: number | null;
}

export default function VideoPlayer({
	src,
	poster,
	autoPlay = false,
	attention,
	publicAccess = false,
	elementRef,
	podcast,
	originalUrl,
	captions,
	chapters,
	startSeconds = null,
	onEnded,
}: VideoPlayerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (!elementRef) return;
		elementRef.current = videoRef.current;
		return () => {
			elementRef.current = null;
		};
	}, [elementRef]);
	const hlsRef = useRef<HlsInstance | null>(null);
	/** The native-file branch's error listener, so its cleanup stays inside the source effect. */
	const nativeErrorHandler = useRef<(() => void) | null>(null);
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
	 * Which address plays. The manifest rungs are the default and the only thing the
	 * ladder mode streams; Original Media is the explicit choice, at the file as uploaded.
	 * A caller-level `src` change (a different Work, the ladder arriving) resets it: the
	 * opt-in never outlives the thing it opted out of.
	 */
	const [mode, setMode] = useState<"adaptive" | "original">("adaptive");
	const playedSrc = mode === "original" && originalUrl ? originalUrl : src;
	/**
	 * The level to pin on rejoining the ladder. Leaving Original Media tears the hls
	 * instance down (the source effect's cleanup) and rebuilds it from an import promise,
	 * so a rung clicked there cannot be applied through `applyLevel` — the instance does
	 * not exist yet. The manifest handler picks it up instead; `-1` rejoins as automatic.
	 */
	const pendingLevel = useRef<number | null>(null);
	/**
	 * Set when delivery itself refuses — the backstop for an allowance that empties
	 * *between* attention flushes, where the store has not caught up yet.
	 */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();
	const { playTracks } = useMediaPlayer();

	/**
	 * The caption track showing right now, or null for none. Initialized from the shared
	 * on/off preference once captions arrive, and re-derived whenever the Work changes —
	 * a remembered "on" re-lights the new video's first track, because the preference is
	 * about captions, not about one video's track ids.
	 */
	const [activeCaptionId, setActiveCaptionId] = useState<number | null>(null);
	useEffect(() => {
		setActiveCaptionId((current) => {
			if (current != null && captions?.some((t) => t.id === current)) return current;
			if (readCaptionPref() === "on" && captions?.length) return captions[0].id;
			return null;
		});
	}, [captions]);

	/**
	 * Each track's bytes, fetched with the app's own transport and handed to the element
	 * as a same-origin blob URL.
	 *
	 * ⚠️ This is deliberate rather than a `<track src="/api…">` direct: in production the
	 * API is same-origin and the direct form would work, but everywhere the page does NOT
	 * share the API's origin — the Studio preview, a desktop app, any future split — a
	 * native text-track fetch runs CORS-anonymous, dropping the session cookie and 401ing,
	 * which reads on screen as "captions are missing" instead of "fetch failed". `apiFetch`
	 * is the one place credentials are resolved; the menu's bytes then belong to whatever
	 * origin the document is.
	 */
	const [trackBlobUrls, setTrackBlobUrls] = useState<Record<number, string>>({});
	useEffect(() => {
		if (!captions?.length) {
			setTrackBlobUrls({});
			return;
		}
		let dead = false;
		const urls: Record<number, string> = {};
		void (async () => {
			for (const t of captions) {
				try {
					const res = await apiFetch(t.url);
					if (!res.ok) continue;
					urls[t.id] = URL.createObjectURL(new Blob([await res.text()], { type: "text/vtt" }));
				} catch {
					// A track that cannot be read is skipped: the menu loses a language, it
					// does not error the page — the degraded case the reader still controls.
				}
			}
			if (!dead) setTrackBlobUrls(urls);
		})();
		return () => {
			dead = true;
			for (const url of Object.values(urls)) URL.revokeObjectURL(url);
		};
	}, [captions]);

	/** Push the active choice onto the element's text tracks — the one place modes are set, so the browser's own menu and ours can never disagree. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-applying after a source rebuild, a blob arrival or an addtrack is the point — the element's text tracks reset with its media, and a track's own TextTrack only exists once its resource has attached
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		const applyModes = () => {
			video.querySelectorAll("track[data-caption-track-id]").forEach((el) => {
				const track = (el as HTMLTrackElement).track;
				if (!track) return;
				track.mode =
					Number(el.getAttribute("data-caption-track-id")) === activeCaptionId
						? "showing"
						: "disabled";
			});
		};
		applyModes();
		// The TextTrack on each `<track>` element exists only after its resource loads —
		// reading `.track` in the commit pass finds null and the mode would never land.
		// `addtrack` is the browser announcing that a TextTrack now exists, which is
		// exactly when the mode belongs on it.
		video.textTracks.addEventListener("addtrack", applyModes);
		return () => {
			video.textTracks.removeEventListener("addtrack", applyModes);
		};
	}, [activeCaptionId, playedSrc, trackBlobUrls]);

	/**
	 * Hand this video's audio rendition to the persistent bar, as spoken word.
	 *
	 * The video is fully unloaded — its hls instance destroyed and its src released — so
	 * a silent picture stops drawing bandwidth while the episode plays underneath it; two
	 * elements on the same Work are also two attention claims on one listener, and the
	 * hand-off is a switch, not a doubling.
	 */
	const podcastThis = useCallback(() => {
		if (!podcast) return;
		const video = videoRef.current;
		video?.pause();
		hlsRef.current?.destroy();
		hlsRef.current = null;
		video?.removeAttribute("src");
		video?.load();
		playTracks([{ ...podcast.track, src: podcast.audioManifestUrl, kind: "audio" }]);
	}, [podcast, playTracks]);
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
	// The caller's ended callback rides a ref so this mount-time effect (deps
	// deliberately empty — playback state reads the element, not the props) never
	// has to rebind its listeners when the callback changes.
	const onEndedRef = useRef(onEnded);
	useEffect(() => {
		onEndedRef.current = onEnded;
	});
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		const onPlay = () => setIsPlaying(true);
		const onPause = () => setIsPlaying(false);
		const onEnded = () => {
			setIsPlaying(false);
			onEndedRef.current?.();
		};
		const onWaiting = () => setIsPlaying(false);
		const onPlaying = () => setIsPlaying(true);
		const onTimeUpdate = () => {
			setPosition(video.currentTime);
			// Buffered ahead of the playhead, which is the only part a user can see the
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
		if (!video || !playedSrc) return;

		const isHls = playedSrc.endsWith(".m3u8");

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
						hls.on(Hls.Events.ERROR, (_evt, data) => {
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
									.map((l, index) => ({
										index,
										height: l.height ?? 0,
										bitrate: l.bitrate ?? 0,
									}))
									.sort((a: QualityLevel, b: QualityLevel) => b.height - a.height),
							);
							// Rejoining from Original Media applies the chosen rung here, at
							// the instance that will actually carry it — a pin issued to a
							// not-yet-existing instance would be silently lost.
							if (pendingLevel.current != null) {
								const target = pendingLevel.current;
								pendingLevel.current = null;
								hls.currentLevel = target;
								setCurrentLevel(target);
							} else {
								setCurrentLevel(hls.currentLevel);
							}
						});
						// What automatic is actually doing right now, so "Auto" can say so.
						hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
							setActiveLevelHeight(hls.levels[data.level]?.height ?? null);
						});

						hls.loadSource(playedSrc);
						hls.attachMedia(video);
						hlsRef.current = hls;

						if (autoPlay) {
							hls.on(Hls.Events.MANIFEST_PARSED, () => {
								video.play().catch(() => {});
							});
						}
					} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
						// Safari native HLS
						video.src = playedSrc;
						if (autoPlay) video.play().catch(() => {});
					}
				})
				.catch(() => {
					// hls.js not available, try native
					video.src = playedSrc;
				});
		} else {
			// Direct file playback — the original, delivered as its access-checked
			// route's 302. The status-reading backstop the HLS branch has does not
			// exist for a media element (a refused source reports
			// `MEDIA_ERR_SRC_NOT_SUPPORTED` with no status), so the budget is the
			// only honest signal a refusal arrives on — nudge it, the way a
			// 402 fragment does for the ladder.
			const onError = () => refreshBudget();
			video.addEventListener("error", onError);
			nativeErrorHandler.current = () => video.removeEventListener("error", onError);
			video.src = playedSrc;
			if (autoPlay) video.play().catch(() => {});
		}

		return () => {
			if (hlsRef.current) {
				hlsRef.current.destroy();
				hlsRef.current = null;
			}
			nativeErrorHandler.current?.();
			nativeErrorHandler.current = null;
			// The level list is deliberately NOT cleared here. A source change that leaves
			// the ladder for Original Media still needs the rungs, so the trip back shows
			// what it can rejoin; a genuinely different Work re-renders a fresh player.
		};
	}, [playedSrc, autoPlay]);

	// A caller-level source change returns the opt-in to its resting state: the ladder
	// plays by default, and whatever Original Media was chosen for a previous address
	// says nothing about the next one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the reset keys on the CALLER's address, not the played one — the played address is this opt-in's own output
	useEffect(() => {
		setMode("adaptive");
	}, [src]);

	// Stop what is already playing the moment the allowance goes. Without this the
	// buffered tail keeps running under the wall — which credits attention the user is
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

	// The page's timestamp links — description and reviews both — seek through here.
	useBindPlayerSeek(seekTo);

	/**
	 * A landed `?t` — a shared link or a clicked timestamp. Applied once the element
	 * has a duration to seek into, once: re-reading it after a source swap would jump
	 * the viewer back to their entry point every time the quality mode changed.
	 */
	const [startApplied, setStartApplied] = useState(false);
	useEffect(() => {
		if (startApplied || startSeconds == null || !duration) return;
		setStartApplied(true);
		seekTo(startSeconds);
	}, [duration, startSeconds, startApplied, seekTo]);

	const applyRate = useCallback((next: number) => {
		const video = videoRef.current;
		if (!video) return;
		video.playbackRate = next;
		setRate(next);
	}, []);

	// -1 is hls.js's "automatic". Kept as the same value the library uses rather than a
	// separate boolean, so there is one representation of the choice and no way for a
	// pinned level and an "auto" flag to disagree.
	//
	// Original Media routes the same prop: leaving it re-enters the ladder with the
	// clicked rung queued for the manifest parse (the pending-level ref above), and
	// entering it is just the mode switch — the source effect tears hls.js down itself.
	const applyLevel = useCallback(
		(index: number) => {
			if (mode === "original") {
				setActiveLevelHeight(null);
				pendingLevel.current = index;
				setMode("adaptive");
				setCurrentLevel(index);
				return;
			}
			if (hlsRef.current) hlsRef.current.currentLevel = index;
			setCurrentLevel(index);
		},
		[mode],
	);

	const selectOriginal = useCallback(() => {
		if (mode === "original") return;
		videoRef.current?.pause();
		setActiveLevelHeight(null);
		setMode("original");
	}, [mode]);

	// ── Captions ───────────────────────────────────────────────────────────

	/**
	 * One setter for the choice, whatever surface makes it — the settings language rows,
	 * the `c` shortcut — and every change through it writes the shared preference, so a
	 * viewer's second video never re-asks. Selecting a language writes "on"; turning
	 * captions off writes "off"; the per-video language rides only in state.
	 */
	const selectCaption = useCallback((id: number | null) => {
		setActiveCaptionId(id);
		writeCaptionPref(id == null ? "off" : "on");
	}, []);

	const toggleCaptions = useCallback(() => {
		selectCaption(activeCaptionId == null ? (captions?.[0]?.id ?? null) : null);
	}, [activeCaptionId, captions, selectCaption]);

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
			(video as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen();
		}
	}, []);

	useEffect(() => {
		const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	// Controls hide after a moment of stillness, but only while playing — a paused player
	// keeps them, because a user who paused is looking for a control.
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
		toggleCaptions: captions?.length ? toggleCaptions : undefined,
		stepFrame: (direction) => {
			// Not a true frame — the element cannot tell us the frame rate — but a step
			// small enough to land on a neighboring one at ordinary rates. Named for what
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
			 *
			 * The picture and its controls live in a relative wrapper of their own so
			 * the chapter list beneath (inside the container, so it stays reachable in
			 * fullscreen) reads as a section of the player rather than floating under
			 * the controls' gradient — which is anchored to the picture's own bottom
			 * edge now instead of the whole section's.
			 */}
			<section
				ref={containerRef}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the container is the player, per the comment above.
				tabIndex={0}
				onKeyDown={onKeyDown}
				onPointerMove={wakeControls}
				onPointerLeave={() => isPlaying && setControlsVisible(false)}
				aria-label="Video player"
				className={`group/player relative overflow-hidden rounded-lg bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
			>
				<div className={`relative ${isPlaying && !controlsVisible ? "cursor-none" : ""}`}>
					{/*
					 * Caption tracks render as children whose src is a blob URL built from the
					 * app's own authenticated fetch (above), so the track's modes are ours to
					 * set — the modes are never set from `default`, which would hand the choice
					 * to the element's load order rather than to the active-selection effect.
					 */}
					{/* biome-ignore lint/a11y/useMediaCaption: tracks render as children below whenever the Work carries any; the rule is static and cannot see the conditional.
					    The tracks are children of THIS element — that is what makes them text tracks
					    of it — and their src is a blob URL built from the app's own authenticated
					    fetch (above), so the bytes read no differently from the page. The modes are
					    never set from `default`, which would hand the choice to the element's load
					    order rather than to the active-selection effect. */}
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
					>
						{(captions ?? [])
							.filter((t) => trackBlobUrls[t.id])
							.map((t) => (
								<track
									key={t.id}
									data-caption-track-id={t.id}
									src={trackBlobUrls[t.id]}
									kind={t.kind === "subtitles" ? "subtitles" : "captions"}
									srcLang={t.language}
									label={t.label || t.language}
								/>
							))}
					</video>

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
						autoLevel={mode === "adaptive" && currentLevel === -1}
						originalActive={mode === "original"}
						originalAvailable={!!originalUrl}
						activeLevelHeight={activeLevelHeight}
						captionTracks={captions ?? []}
						activeCaptionId={activeCaptionId}
						fullscreen={fullscreen}
						visible={controlsVisible || !isPlaying}
						chapters={chapters ?? []}
						onTogglePlay={togglePlay}
						onSeek={seekTo}
						onRate={applyRate}
						onLevel={applyLevel}
						onOriginal={selectOriginal}
						onCaption={selectCaption}
						onToggleFullscreen={toggleFullscreen}
						onPodcastThis={podcast ? podcastThis : undefined}
					/>
				</div>

				{chapters && chapters.length > 0 && (
					<ChapterList
						chapters={chapters}
						position={position}
						duration={duration}
						onSeek={seekTo}
						dark
					/>
				)}
			</section>
			{publicAccess && <PublicAccessFooter />}
		</>
	);
}
