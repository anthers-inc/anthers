// SPDX-License-Identifier: Apache-2.0
/**
 * The video transport — everything the browser used to draw, drawn by us.
 *
 * Built from the same pieces as the music bar (`transport/`), so the two read as one
 * product: same play button, same scrub interaction, same volume control, same time
 * formatting. What differs is only what a video needs and audio does not — speed,
 * quality, fullscreen, theater mode — and those sit together in one settings panel
 * rather than sprawling across the bar.
 *
 * ⚠️ **The settings panel is a plain positioned element, not a daisyUI `dropdown`.**
 * The canonical dropdown uses the popover API with CSS anchor positioning, which is not
 * yet everywhere — and this control has to work *inside the fullscreen element*, where a
 * mispositioned popover is not a cosmetic problem but a menu the user cannot reach.
 */

import type { WorkChapter } from "@anthers/shared/chapters";
import { chapterIndexFor } from "@anthers/shared/chapters";
import {
	ArrowsPointingInIcon,
	ArrowsPointingOutIcon,
	Cog6ToothIcon,
	PauseIcon,
	PlayIcon,
	SpeakerWaveIcon,
} from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";
import { useWorkTheater } from "@/lib/work-theater";
import { formatTime } from "./transport/format";
import SeekBar from "./transport/SeekBar";
import TheaterIcon from "./transport/TheaterIcon";
import TransportButton from "./transport/TransportButton";
import VolumeControl from "./transport/VolumeControl";

/** Playback speeds, slowest first. 1 is the identity and must stay in the list. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export interface QualityLevel {
	/** hls.js level index. */
	index: number;
	height: number;
	bitrate: number;
}

export default function VideoControls({
	playing,
	position,
	duration,
	buffered,
	rate,
	levels,
	currentLevel,
	autoLevel,
	originalActive,
	originalAvailable,
	activeLevelHeight,
	captionTracks,
	activeCaptionId,
	fullscreen,
	visible,
	onTogglePlay,
	onSeek,
	onRate,
	onLevel,
	onOriginal,
	onCaption,
	onToggleFullscreen,
	chapters,
	/**
	 * The Podcast-This hand-off, present only on a video whose audio rendition exists —
	 * the `audioManifestUrl` gate lives in VideoPlayer, which owns the unload.
	 */
	onPodcastThis,
}: {
	playing: boolean;
	position: number;
	duration: number;
	buffered: number;
	rate: number;
	/** Empty for a progressive file — the quality row then hides rather than showing one option. */
	levels: QualityLevel[];
	/** The pinned level index, or -1 for automatic. */
	currentLevel: number;
	autoLevel: boolean;
	/**
	 * The Original Media option: present when the Work offers it, active while the
	 * original itself is playing. One row that keeps the rungs listed on both sides of
	 * the choice, so leaving Original Media is clicking a rung, not an escape hatch.
	 */
	originalActive: boolean;
	originalAvailable: boolean;
	/** What automatic actually chose, so "Auto" can say what it is doing. */
	activeLevelHeight: number | null;
	/** The Work's caption tracks. Empty hides the whole captions section rather than rendering it disabled. */
	captionTracks: Array<{ id: number; language: string; label: string; kind: string }>;
	/** The track showing now, or null for none. The player owns what that means for the element. */
	activeCaptionId: number | null;
	fullscreen: boolean;
	/** Whether the bar is on screen. Hidden means faded out, never unmounted. */
	visible: boolean;
	onTogglePlay: () => void;
	onSeek: (seconds: number) => void;
	onRate: (rate: number) => void;
	onLevel: (index: number) => void;
	onOriginal: () => void;
	/** Which track to show, or null to turn captions off. The player writes the preference. */
	onCaption: (trackId: number | null) => void;
	onToggleFullscreen: () => void;
	/** The Work's chapters, for the segmented rail and the now-playing name. */
	chapters: WorkChapter[];
	onPodcastThis?: () => void;
}) {
	const theater = useWorkTheater();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settingsRef = useRef<HTMLDivElement>(null);
	/** The chapter the playhead is inside, for the name beside the clock. */
	const currentChapter =
		chapters.length > 0 ? chapters[chapterIndexFor(chapters, position)] : undefined;

	// Close on an outside click. Bound only while open, so the page carries no listener
	// for a menu nobody has opened.
	useEffect(() => {
		if (!settingsOpen) return;
		const onDown = (e: PointerEvent) => {
			if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [settingsOpen]);

	// A hidden bar takes its menu with it — otherwise the panel floats over the picture
	// attached to nothing.
	useEffect(() => {
		if (!visible) setSettingsOpen(false);
	}, [visible]);

	return (
		<div
			className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-2 pb-1 pt-8 transition-opacity duration-200 sm:px-3 ${
				visible ? "opacity-100" : "pointer-events-none opacity-0"
			}`}
			// The controls sit on video, not on a themed surface, so this is one of the few
			// places a fixed light-on-dark palette is right: the backdrop is the picture.
			data-testid="video-controls"
		>
			<SeekBar
				position={position}
				duration={duration}
				buffered={buffered}
				chapters={chapters}
				onSeek={onSeek}
				label="Seek video"
				className="text-white"
			/>

			<div className="flex items-center gap-1 text-white">
				<TransportButton
					label={playing ? "Pause" : "Play"}
					icon={playing ? PauseIcon : PlayIcon}
					onClick={onTogglePlay}
					tone="primary"
					size="sm"
				/>

				<span className="ml-1 shrink-0 text-xs tabular-nums text-white/80">
					{formatTime(position)} <span className="text-white/40">/</span> {formatTime(duration)}
				</span>

				{/* The chapter playing now — YouTube's bottom-left name. Clamped to a strip
				    of the bar so a long title truncates without pushing the menu out. */}
				{currentChapter?.title != null && (
					<span className="min-w-0 max-w-48 truncate text-xs text-white/80">
						{currentChapter.title}
					</span>
				)}

				<div className="flex-1" />

				<VolumeControl collapsible />

				<div className="relative" ref={settingsRef}>
					<TransportButton
						label="Playback settings"
						icon={Cog6ToothIcon}
						onClick={() => setSettingsOpen((v) => !v)}
						active={settingsOpen}
						size="sm"
					/>
					{settingsOpen && (
						/* 🚨 Scroll, because the sections it can carry (speed, quality, captions,
						    listen) already exceed a short clip's height on a small player, where
						    a plain panel would overflow and its top rows would be unclickable.
						    The overflow is INSIDE the panel — it itself stays anchored at the
						    player's bottom edge. */
						<div className="absolute bottom-full right-0 z-10 mb-2 max-h-full w-52 overflow-y-auto rounded-box bg-base-100 p-2 text-base-content shadow-xl">
							<p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
								Speed
							</p>
							<ul className="menu menu-sm w-full">
								{PLAYBACK_RATES.map((r) => (
									<li key={r}>
										<button
											type="button"
											className={r === rate ? "menu-active" : ""}
											onClick={() => onRate(r)}
										>
											{r === 1 ? "Normal" : `${r}×`}
										</button>
									</li>
								))}
							</ul>
							{(levels.length > 1 || originalAvailable) && (
								<>
									<p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
										Quality
									</p>{" "}
									<ul className="menu menu-sm w-full">
										{/* A rung row hides while the original plays: the mode's own
									    entry carries the active mark, and "Auto" re-enters the
									    ladder at automatic (the pending-level path), so every row
									    of this menu is a move, on both sides. */}
										{!originalActive && (
											<li>
												<button
													type="button"
													className={autoLevel ? "menu-active" : ""}
													onClick={() => onLevel(-1)}
												>
													Auto
													{activeLevelHeight != null && (
														<span className="text-xs opacity-60">{activeLevelHeight}p</span>
													)}
												</button>
											</li>
										)}
										{levels.map((level) => (
											<li key={level.index}>
												<button
													type="button"
													data-testid={`quality-${level.height}`}
													className={
														!originalActive && !autoLevel && level.index === currentLevel
															? "menu-active"
															: ""
													}
													onClick={() => onLevel(level.index)}
												>
													{level.height}p
												</button>
											</li>
										))}
										{originalAvailable && (
											<li>
												<button
													type="button"
													data-testid="quality-original"
													className={originalActive ? "menu-active" : ""}
													onClick={() => {
														setSettingsOpen(false);
														onOriginal();
													}}
												>
													Original Media
													<span className="block text-[10px] opacity-60">as uploaded</span>
												</button>
											</li>
										)}
									</ul>
								</>
							)}
							{captionTracks.length > 0 && (
								<div data-testid="captions-menu">
									<p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
										Captions
									</p>
									{/* A caption row stays open after the choice, the way the
									    quality rows do: a viewer switching between two languages
									    is choosing, not dismissing, and the panel closes on the
									    outside click like any other menu here. */}
									<ul className="menu menu-sm w-full">
										<li>
											<button
												type="button"
												data-testid="captions-off"
												className={activeCaptionId == null ? "menu-active" : ""}
												onClick={() => onCaption(null)}
											>
												Off
											</button>
										</li>
										{captionTracks.map((t) => (
											<li key={t.id}>
												<button
													type="button"
													data-testid={`captions-track-${t.id}`}
													className={t.id === activeCaptionId ? "menu-active" : ""}
													onClick={() => onCaption(t.id)}
												>
													{t.label}
													<span className="block text-[10px] opacity-60">
														{t.kind === "subtitles" ? "subtitles" : "captions"}
													</span>
												</button>
											</li>
										))}
									</ul>
								</div>
							)}
							{onPodcastThis && (
								<>
									<p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
										Listen
									</p>
									<ul className="menu menu-sm w-full">
										<li>
											<button
												type="button"
												data-testid="podcast-this"
												onClick={() => {
													setSettingsOpen(false);
													onPodcastThis();
												}}
											>
												<SpeakerWaveIcon className="size-4" />
												Listen as podcast
											</button>
										</li>
									</ul>
								</>
							)}
						</div>
					)}
				</div>

				{theater && (
					<TransportButton
						label={theater.theater ? "Exit theater mode" : "Theater mode"}
						icon={TheaterIcon}
						onClick={theater.toggle}
						active={theater.theater}
						size="sm"
					/>
				)}
				<TransportButton
					label={fullscreen ? "Exit full screen" : "Full screen"}
					icon={fullscreen ? ArrowsPointingInIcon : ArrowsPointingOutIcon}
					onClick={onToggleFullscreen}
					size="sm"
				/>
			</div>
		</div>
	);
}
