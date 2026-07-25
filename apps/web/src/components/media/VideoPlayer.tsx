// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";

interface VideoPlayerProps {
	src: string;
	poster?: string;
	autoPlay?: boolean;
	/**
	 * Whose Time Pool minutes this playback earns. Omit on surfaces where playback
	 * shouldn't be credited (previews, the Studio); the player then just plays.
	 */
	attention?: { creatorId: number | null; postId: number | null };
}

export default function VideoPlayer({
	src,
	poster,
	autoPlay = false,
	attention,
}: VideoPlayerProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const hlsRef = useRef<any>(null);
	const [isPlaying, setIsPlaying] = useState(false);

	// Video credits time only while it is actually playing — a paused player on an
	// open tab earns nothing, whatever else is on the page.
	useAttentionClaim({
		creatorId: attention?.creatorId ?? null,
		postId: attention?.postId ?? null,
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
							// Gated posts stream through our access-checked manifest endpoint,
							// which needs the session cookie. Segment requests go to the CDN via
							// signed URLs and must NOT carry credentials (would fail CORS).
							xhrSetup: (xhr: XMLHttpRequest, url: string) => {
								if (/\/api\/content\/posts\/[^/]+\/hls\//.test(url)) {
									xhr.withCredentials = true;
								}
							},
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

	return (
		<video
			ref={videoRef}
			poster={poster}
			controls
			playsInline
			className="w-full rounded-lg bg-black aspect-video"
		/>
	);
}
