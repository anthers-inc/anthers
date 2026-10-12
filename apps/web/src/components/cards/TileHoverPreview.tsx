// SPDX-License-Identifier: Apache-2.0
/**
 * The feed tile's hover-preview player: muted, chromeless, in-place playback of
 * a video or listened Work the viewer can open, torn down the moment the
 * pointer moves on.
 *
 * This is mounted only while the tile's preview is active — the hover wiring
 * (debounce, one-at-a-time, leave) lives in `FeedTile.tsx`, which renders one
 * of these inside the tile's band when its store says it is the tile. Only the
 * things a player owes the record live here, and they are the same three the
 * Work page's players exist for:
 *
 * 1. **Delivery is minted per request** through the access-checked endpoints,
 *    so the preview never caches a payload the feed did not send. The HLS
 *    manifest needs the session cookie; the signed segment requests must not
 *    carry credentials.
 * 2. **The attention claim is an ordinary playback claim** — preview playback
 *    earns like opened playback (Parker, 2026-10-12), with no limit on how long
 *    a hover may hold. The claim carries the Work's own type, which is what the
 *    shared policy keys events on.
 * 3. **A refusal is met by the budget, not guessed from the element.** HLS can
 *    read the 402 for the ladder; a media element cannot, so its errors only
 *    end the preview. Neither path mislabels an outage as anything else: there
 *    is no wall here, the poster is simply what a stopped preview looks like.
 */

import type HlsInstance from "hls.js";
import { useEffect, useRef, useState } from "react";
import { useAttentionClaim } from "../../lib/attention";
import { previewOriginalSourceFor, previewSourceFor } from "../../lib/tile-preview";

export interface TilePreviewWork {
	id: number;
	/** The Work's own type — video, or the listened family. Gate and claim both key on it. */
	type: string;
	/**
	 * The claim's creator. The feed always sends one; the serializers' optionality
	 * is the Work type's, not the endpoint's. A null claim is Time-Pool-ineligible
	 * by the shared policy — it never earns — which is the safe direction for the
	 * one row where the join missed.
	 */
	creatorId: number | null;
}

interface TileHoverPreviewProps {
	work: TilePreviewWork;
	/** Called when the preview is finished for good — a fatal failure, or a short video that ended — so the tile returns to its poster rather than freezing on a last frame. */
	onDone: () => void;
}

/** Video: HLS over the same ladder the Work page plays, with the original-file fallback beneath it. */
function TileVideoPreview({ work, onDone }: TileHoverPreviewProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const hlsRef = useRef<HlsInstance | null>(null);
	const [playing, setPlaying] = useState(false);

	// Video counts while it is playing, on the feed as on any page.
	useAttentionClaim({
		creatorId: work.creatorId,
		workId: work.id,
		contentType: work.type,
		playing,
		active: true,
	});

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		// The ladder-less fallback: the original, streamed by the element itself
		// through its access-checked route's 302 — the same deliverable the Work
		// page falls back to, tried once when the manifest is simply not there.
		let fellBack = false;
		const fallbackToOriginal = () => {
			if (fellBack) return;
			fellBack = true;
			hlsRef.current?.destroy();
			hlsRef.current = null;
			const onError = () => {
				video.removeEventListener("error", onError);
				onDone();
			};
			video.addEventListener("error", onError);
			video.src = previewOriginalSourceFor(work.id);
			void video.play().catch(() => {});
		};

		let canceled = false;
		void import("hls.js").then(({ default: Hls }) => {
			if (canceled) return;
			if (!Hls.isSupported()) {
				// Safari's native HLS answers the manifest directly; the cookie rule
				// is the same one the manifest endpoint enforces.
				video.src = previewSourceFor(work);
				void video.play().catch(() => {});
				return;
			}
			const hls = new Hls({
				// Same cookie rule as the Work page's player: our manifest endpoint is
				// access-checked and same-origin; signed CDN segments must not carry
				// credentials.
				xhrSetup: (xhr: XMLHttpRequest, url: string) => {
					if (/\/api\/content\/works\/[^/]+\/hls\//.test(url)) {
						xhr.withCredentials = true;
					}
				},
			});
			hls.on(Hls.Events.ERROR, (_evt, data) => {
				if (!data?.fatal) return;
				if (data?.response?.code === 404) {
					// No ladder exists yet — the original is the deliverable.
					fallbackToOriginal();
					return;
				}
				if (data?.response?.code === 402) {
					// The allowance emptied between budget reads; let the store catch
					// up so the next hover gate answers honestly, and end the preview.
					onDone();
					return;
				}
				// Anything else fatal is not a preview problem worth reporting on.
				onDone();
			});
			hls.loadSource(previewSourceFor(work));
			hls.attachMedia(video);
			hlsRef.current = hls;
			// Start the moment the manifest has given the element something to play —
			// the same explicit play the Work page's player makes, because autoplay
			// alone is not reliable once a MediaSource is attached.
			hls.on(Hls.Events.MANIFEST_PARSED, () => {
				void video.play().catch(() => {});
			});
		});

		// Keyed on the whole `work` — the parent renders from stable feed entry
		// objects, so identity changes mean a genuinely different Work here, which
		// is exactly the case that should re-tear the delivery down.
		return () => {
			canceled = true;
			hlsRef.current?.destroy();
			hlsRef.current = null;
			video.removeAttribute("src");
			video.load();
		};
	}, [work, onDone]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		// Playback state drives the claim, read from the element rather than from
		// our own play() calls — stalls and refusals are honest states.
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		const onWaiting = () => setPlaying(false);
		const onPlaying = () => setPlaying(true);
		video.addEventListener("play", onPlay);
		video.addEventListener("pause", onPause);
		video.addEventListener("waiting", onWaiting);
		video.addEventListener("playing", onPlaying);
		return () => {
			video.removeEventListener("play", onPlay);
			video.removeEventListener("pause", onPause);
			video.removeEventListener("waiting", onWaiting);
			video.removeEventListener("playing", onPlaying);
			setPlaying(false);
		};
	}, []);

	return (
		<video
			ref={videoRef}
			// Muted and silent is the whole preview: attention counts it, and nothing
			// audible rides the cursor.
			muted
			playsInline
			autoPlay
			className="absolute inset-0 h-full w-full object-cover"
			onEnded={onDone}
		/>
	);
}

/** Listened family: the audio endpoint's stream, invisible, with no bar takeover. */
function TileAudioPreview({ work, onDone }: TileHoverPreviewProps) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [playing, setPlaying] = useState(false);

	// The listened family counts while playing, keyed on the Work's own type.
	useAttentionClaim({
		creatorId: work.creatorId,
		workId: work.id,
		contentType: work.type,
		playing,
		active: true,
	});

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		// Delivery is the backstop: the element cannot report a status code, so a
		// refusal (usually a meter gone spent between budget reads) ends the
		// preview like any other failure — refetch the budget anyway, because it
		// is the one honest signal a 402 leaves.
		const onError = () => onDone();
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		const onWaiting = () => setPlaying(false);
		const onPlaying = () => setPlaying(true);
		audio.addEventListener("error", onError);
		audio.addEventListener("play", onPlay);
		audio.addEventListener("pause", onPause);
		audio.addEventListener("waiting", onWaiting);
		audio.addEventListener("playing", onPlaying);
		return () => {
			audio.removeEventListener("error", onError);
			audio.removeEventListener("play", onPlay);
			audio.removeEventListener("pause", onPause);
			audio.removeEventListener("waiting", onWaiting);
			audio.removeEventListener("playing", onPlaying);
			setPlaying(false);
		};
	}, [onDone]);

	// A track that ends under the hover returns the tile to its poster, exactly
	// as a short preview video does — an ended element frozen forever is not a
	// state the tile has.
	return <audio ref={audioRef} src={previewSourceFor(work)} muted autoPlay onEnded={onDone} />;
}

export default function TileHoverPreview({ work, onDone }: TileHoverPreviewProps) {
	return work.type === "video" ? (
		<TileVideoPreview work={work} onDone={onDone} />
	) : (
		<TileAudioPreview work={work} onDone={onDone} />
	);
}
