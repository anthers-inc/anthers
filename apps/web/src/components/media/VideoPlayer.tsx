// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { refreshBudget, useMeteredBudget } from "../../lib/public-access";
import { PublicAccessFooter, PublicAccessWall } from "./PublicAccessNotice";

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
	const videoRef = useRef<HTMLVideoElement>(null);
	const hlsRef = useRef<any>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	/**
	 * Set when delivery itself refuses — the backstop for an allowance that empties
	 * *between* attention flushes, where the store has not caught up yet.
	 */
	const [refused, setRefused] = useState(false);
	const budget = useMeteredBudget();

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

		video.addEventListener("play", onPlay);
		video.addEventListener("pause", onPause);
		video.addEventListener("ended", onEnded);
		video.addEventListener("waiting", onWaiting);
		video.addEventListener("playing", onPlaying);

		return () => {
			video.removeEventListener("play", onPlay);
			video.removeEventListener("pause", onPause);
			video.removeEventListener("ended", onEnded);
			video.removeEventListener("waiting", onWaiting);
			video.removeEventListener("playing", onPlaying);
			setIsPlaying(false);
		};
	}, []);

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
		};
	}, [src, autoPlay]);

	// Stop what is already playing the moment the allowance goes. Without this the
	// buffered tail keeps running under the wall — which credits attention the viewer is
	// no longer entitled to spend, and looks like the limit did not apply.
	useEffect(() => {
		if (spent) videoRef.current?.pause();
	}, [spent]);

	if (spent && budget) return <PublicAccessWall budget={budget} />;

	return (
		<>
			<video
				ref={videoRef}
				poster={poster}
				controls
				playsInline
				className="w-full rounded-lg bg-black aspect-video"
			/>
			{publicAccess && <PublicAccessFooter playing={isPlaying} />}
		</>
	);
}
