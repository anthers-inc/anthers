// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The video transport — everything the browser used to draw, drawn by us.
 *
 * Built from the same pieces as the music bar (`transport/`), so the two read as one
 * product: same play button, same scrub interaction, same volume control, same time
 * formatting. What differs is only what a video needs and audio does not — speed,
 * quality, fullscreen — and those sit together in one settings panel rather than
 * sprawling across the bar.
 *
 * ⚠️ **The settings panel is a plain positioned element, not a daisyUI `dropdown`.**
 * The canonical dropdown uses the popover API with CSS anchor positioning, which is not
 * yet everywhere — and this control has to work *inside the fullscreen element*, where a
 * mispositioned popover is not a cosmetic problem but a menu the viewer cannot reach.
 */
import {
	ArrowsPointingInIcon,
	ArrowsPointingOutIcon,
	Cog6ToothIcon,
	PauseIcon,
	PlayIcon,
} from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";
import { formatTime } from "./transport/format";
import SeekBar from "./transport/SeekBar";
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
	activeLevelHeight,
	fullscreen,
	visible,
	onTogglePlay,
	onSeek,
	onRate,
	onLevel,
	onToggleFullscreen,
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
	/** What automatic actually chose, so "Auto" can say what it is doing. */
	activeLevelHeight: number | null;
	fullscreen: boolean;
	/** Whether the bar is on screen. Hidden means faded out, never unmounted. */
	visible: boolean;
	onTogglePlay: () => void;
	onSeek: (seconds: number) => void;
	onRate: (rate: number) => void;
	onLevel: (index: number) => void;
	onToggleFullscreen: () => void;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settingsRef = useRef<HTMLDivElement>(null);

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
						<div className="absolute bottom-full right-0 z-10 mb-2 w-52 rounded-box bg-base-100 p-2 text-base-content shadow-xl">
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
							{levels.length > 1 && (
								<>
									<p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
										Quality
									</p>
									<ul className="menu menu-sm w-full">
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
										{levels.map((level) => (
											<li key={level.index}>
												<button
													type="button"
													className={
														!autoLevel && level.index === currentLevel ? "menu-active" : ""
													}
													onClick={() => onLevel(level.index)}
												>
													{level.height}p
												</button>
											</li>
										))}
									</ul>
								</>
							)}
						</div>
					)}
				</div>

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
