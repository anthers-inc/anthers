// SPDX-License-Identifier: Apache-2.0
/**
 * The hover preview's scrub strip: a slim rail along the band's bottom that shows
 * where the preview has reached and lets the pointer move it anywhere in the work.
 *
 * A preview otherwise always starts at the first second, so a viewer who wants to
 * see a later moment has to sit through the beginning — the thing a hover is least
 * able to ask of someone. Dragging the strip (or clicking a point on it) seeks the
 * element the preview is playing, and the preview keeps playing from there.
 *
 * It is the preview's control, not the Work page's transport: it exists only while
 * a preview is mounted, has no play/pause or volume of its own, and never replaces
 * what opening the Work gives you. That is also why it is hand-built rather than
 * `SeekBar` — the strip has no room for a rail's padding, its hover bubble and knob
 * are sized for a thumbnail, and it never shows buffered ranges or chapters.
 *
 * The control itself is still a real `<input type="range">` held invisibly over the
 * painting, so keyboard operation, pointer capture during a drag and screen-reader
 * semantics come for free. It rides above the tile's stretched link overlay, so a
 * press is a seek and never a navigation.
 */

import { type RefObject, useEffect, useRef, useState } from "react";
import { formatTime, spokenDuration } from "../media/transport/format";

function clampFraction(n: number): number {
	return Math.min(1, Math.max(0, n));
}

export default function PreviewScrubber({
	mediaRef,
}: {
	/** The element the preview is playing — the video, or the listened family's audio. */
	mediaRef: RefObject<HTMLMediaElement | null>;
}) {
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	/** Pointer x within the strip, 0–1, while hovering. Null when the pointer is away. */
	const [hover, setHover] = useState<number | null>(null);
	const stripRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const media = mediaRef.current;
		if (!media) return;
		const readPosition = () => {
			setPosition(Number.isFinite(media.currentTime) ? media.currentTime : 0);
		};
		const readDuration = () => {
			setDuration(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0);
		};
		readPosition();
		readDuration();
		media.addEventListener("timeupdate", readPosition);
		// A seek lands before the next `timeupdate`; `seeked` makes the fill follow a
		// click immediately rather than a beat behind it.
		media.addEventListener("seeked", readPosition);
		media.addEventListener("loadedmetadata", readDuration);
		media.addEventListener("durationchange", readDuration);
		return () => {
			media.removeEventListener("timeupdate", readPosition);
			media.removeEventListener("seeked", readPosition);
			media.removeEventListener("loadedmetadata", readDuration);
			media.removeEventListener("durationchange", readDuration);
		};
	}, [mediaRef]);

	const usable = duration > 0;
	const played = usable ? clampFraction(position / duration) : 0;

	const fractionAt = (clientX: number): number | null => {
		const rect = stripRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0) return null;
		return clampFraction((clientX - rect.left) / rect.width);
	};

	const seekTo = (seconds: number) => {
		const media = mediaRef.current;
		if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
		media.currentTime = Math.min(Math.max(0, seconds), media.duration);
		setPosition(media.currentTime);
	};

	return (
		<div
			ref={stripRef}
			data-testid="preview-scrub"
			className="group/scrub absolute inset-x-2 bottom-0 z-10 flex h-6 items-end pb-1.5"
			onPointerMove={(e) => setHover(fractionAt(e.clientX))}
			onPointerLeave={() => setHover(null)}
		>
			{/* The hover time, on the same light-on-dark chip the band uses for its
			    duration — the strip is over the picture, not on a themed surface. */}
			{hover != null && usable && (
				<span
					className="pointer-events-none absolute bottom-full left-0 mb-1 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] tabular-nums text-white shadow"
					// Kept a half-bubble inside the strip at either end: a time clipped by
					// the band's rounded edge is a control that looks broken at 0:00.
					style={{ left: `clamp(1.5rem, ${hover * 100}%, calc(100% - 1.5rem))` }}
				>
					{formatTime(hover * duration)}
				</span>
			)}

			{/* The painted rail. Never interactive — the input over it owns every event. */}
			<div className="pointer-events-none relative h-1 w-full overflow-hidden rounded-full bg-white/35 ring-1 ring-black/40 transition-[height] group-hover/scrub:h-1.5 group-has-[:focus-visible]/scrub:ring-2 group-has-[:focus-visible]/scrub:ring-primary">
				<div
					className="h-full rounded-full bg-white transition-[width] duration-200 ease-linear"
					style={{ width: `${played * 100}%` }}
				/>
			</div>

			{/* The playhead knob: present while the preview is, so the strip reads as a
			    transport rather than a progress line; it grows under the pointer. */}
			{usable && (
				<span
					className="pointer-events-none absolute bottom-1 size-2 -translate-x-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.55)] transition-transform group-hover/scrub:scale-125"
					style={{ left: `${played * 100}%` }}
				/>
			)}

			<input
				type="range"
				min={0}
				max={usable ? duration : 1}
				step="any"
				value={usable ? position : 0}
				// Enabled while the duration is still unknown on purpose: a disabled range
				// takes no pointer events, so the press would fall through to the tile's
				// stretched link and open the Work instead of doing nothing for a moment.
				aria-disabled={!usable}
				onChange={(e) => seekTo(Number(e.target.value))}
				// 🚨 The strip sits at the band's bottom edge, so a drag leaves the tile
				// almost immediately — and a preview tears down on the tile's pointerleave.
				// Native range drags do not win that race on their own; capturing the
				// pointer keeps the whole gesture on this control, and releasing it outside
				// the tile lets the browser deliver the leave the teardown is waiting for.
				onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
				onPointerUp={(e) => {
					if (e.currentTarget.hasPointerCapture(e.pointerId)) {
						e.currentTarget.releasePointerCapture(e.pointerId);
					}
				}}
				aria-label="Seek preview"
				aria-valuetext={
					usable ? `${formatTime(position)} of ${spokenDuration(duration)}` : undefined
				}
				// Invisible but present: the rail above is the visual, this is the control.
				className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
			/>
		</div>
	);
}
