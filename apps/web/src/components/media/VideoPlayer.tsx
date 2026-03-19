import { useEffect, useRef } from "react";

interface VideoPlayerProps {
	src: string;
	poster?: string;
	autoPlay?: boolean;
}

export default function VideoPlayer({ src, poster, autoPlay = false }: VideoPlayerProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const hlsRef = useRef<any>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !src) return;

		const isHls = src.endsWith(".m3u8");

		if (isHls) {
			// Try HLS.js first (most browsers)
			import("hls.js").then(({ default: Hls }) => {
				if (Hls.isSupported()) {
					const hls = new Hls({
						maxBufferLength: 30,
						maxMaxBufferLength: 60,
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
			}).catch(() => {
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
