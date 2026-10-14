// SPDX-License-Identifier: Apache-2.0
/**
 * The scrub surface, shared by every player.
 *
 * What is shared is the *interaction* — drag, click-to-seek, arrow keys, the focus ring,
 * the hover time bubble — and what differs is only what gets painted underneath. Video
 * paints a rail with a buffered band; audio paints its FFmpeg waveform; a user could
 * paint page ticks. Passing that in as `track` is the whole reason this is one component
 * instead of three that behave subtly differently.
 *
 * The control itself is a real `<input type="range">` held invisibly over the painting,
 * which is what buys keyboard operation, pointer capture during a drag and the right
 * screen-reader semantics for free. Hand-rolling it from pointer events is how a player
 * ends up unusable without a mouse.
 */

import type { WorkChapter } from "@anthers/shared/chapters";
import { chapterIndexFor } from "@anthers/shared/chapters";
import { type ReactNode, useRef, useState } from "react";
import { formatTime, spokenDuration } from "./format";

export default function SeekBar({
	position,
	duration,
	buffered,
	chapters,
	onSeek,
	onScrubStart,
	onScrubEnd,
	label = "Seek",
	track,
	className = "",
	disabled = false,
}: {
	position: number;
	duration: number;
	/** Seconds buffered from the start, if the medium knows. Painted on the default rail. */
	buffered?: number;
	/**
	 * The Work's chapter cues, painted as ticks over the default rail and named in the
	 * hover bubble. A painted `track` hides the rail but keeps the bubble — the
	 * waveform players pass none, list-side chapters being theirs.
	 */
	chapters?: WorkChapter[];
	onSeek: (seconds: number) => void;
	/** Called as a drag begins/ends, for players that want to suppress their own updates. */
	onScrubStart?: () => void;
	onScrubEnd?: () => void;
	label?: string;
	/** What to paint under the control. Omit for the default rail. */
	track?: ReactNode;
	className?: string;
	disabled?: boolean;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	/** Pointer x within the bar, 0–1, while hovering. Null when the pointer is away. */
	const [hover, setHover] = useState<number | null>(null);

	const usable = Number.isFinite(duration) && duration > 0;
	const played = usable ? Math.min(1, Math.max(0, position / duration)) : 0;
	const bufferedFrac =
		usable && buffered != null ? Math.min(1, Math.max(played, buffered / duration)) : 0;

	const trackHover = (clientX: number) => {
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0) return;
		setHover(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
	};

	return (
		<div
			ref={wrapRef}
			className={`group/seek relative flex items-center rounded-full py-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/60 ${className}`}
			onPointerMove={(e) => trackHover(e.clientX)}
			onPointerLeave={() => setHover(null)}
		>
			{/* The painted surface. Never interactive — the input above owns every event. */}
			<div className="pointer-events-none w-full">
				{track ?? (
					<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-base-content/15">
						<div
							className="absolute inset-y-0 left-0 bg-base-content/25"
							style={{ width: `${bufferedFrac * 100}%` }}
						/>
						<div
							className="absolute inset-y-0 left-0 bg-primary"
							style={{ width: `${played * 100}%` }}
						/>
						{/*
						 * Chapter boundaries, as ticks: where this Work divides. Light on the
						 * rail's own grays in either theme, and only between the ends — a cue
						 * named before zero or past the last second marks nothing.
						 */}
						{(chapters ?? [])
							.filter((c) => c.seconds > 0 && c.seconds < duration)
							.map((c) => (
								<span
									key={c.seconds}
									aria-hidden
									className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-white/80"
									style={{ left: `${(c.seconds / duration) * 100}%` }}
								/>
							))}
					</div>
				)}
			</div>

			{/* The knob. Only on the default rail — a waveform marks its own position by
			    color, and a second marker over it just adds noise. */}
			{!track && (
				<span
					className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-primary shadow transition-transform duration-150 group-hover/seek:scale-100 group-has-[:focus-visible]/seek:scale-100"
					style={{ left: `${played * 100}%` }}
				/>
			)}

			{/* Hover time, and the chapter it lands in. Suppressed until the duration is
			    known, so it can never offer to seek somewhere that does not exist yet. */}
			{hover != null && usable && (
				<span
					className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded bg-neutral px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-content shadow"
					style={{ left: `${hover * 100}%` }}
				>
					{(() => {
						const hovered = chapters ? chapterIndexFor(chapters, hover * duration) : -1;
						const title = hovered >= 0 ? chapters?.[hovered]?.title : null;
						return (
							<>
								{title && (
									// Wide enough to be read, clipped where it would collide
									// with the neighboring bubble — names, not walls of text.
									<span className="block max-w-40 truncate">{title}</span>
								)}
								{formatTime(hover * duration)}
							</>
						);
					})()}
				</span>
			)}

			<input
				type="range"
				min={0}
				max={usable ? duration : 1}
				step="any"
				value={position}
				disabled={disabled || !usable}
				onChange={(e) => onSeek(Number(e.target.value))}
				onPointerDown={onScrubStart}
				onPointerUp={onScrubEnd}
				onBlur={onScrubEnd}
				aria-label={label}
				aria-valuetext={`${formatTime(position)} of ${spokenDuration(duration)}`}
				// Invisible but present: the painting below is the visual, this is the control.
				// Focus lands here and the wrapper's `has-[:focus-visible]` draws the ring.
				className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
			/>
		</div>
	);
}
