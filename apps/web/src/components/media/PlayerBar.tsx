// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The persistent listening bar — now-playing, transport, queue and lyrics.
 *
 * Replaces `MiniPlayer`, which was a thumbnail, a title, a play button and a seek bar over
 * a player that could hold exactly one track. Built from the same `transport/` pieces the
 * video controls use, so the two are the same controls rather than two that resemble each
 * other.
 *
 * Two states here are Anthers-specific and both exist so that playback never simply stops
 * with nothing said:
 *
 *   - **Gated.** The listener explicitly chose a track they cannot reach. The bar keeps
 *     the track selected and offers the way in, rather than skipping to something they did
 *     not ask for.
 *   - **Allowance spent.** The track is free and stays free; the viewer's monthly Public
 *     Access hours ran out. 🚨 The copy has to put it that way round — "you've used your
 *     hours", never "this is locked" — or the commons reads as stratified again, which is
 *     the thing the binary model exists to prevent.
 */
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { workUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import {
	ArrowPathIcon,
	ArrowsRightLeftIcon,
	BackwardIcon,
	ForwardIcon,
	MusicalNoteIcon,
	PauseIcon,
	PlayIcon,
	QueueListIcon,
	XMarkIcon,
} from "@heroicons/react/24/solid";
import { useState } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import LyricsPanel from "./LyricsPanel";
import QueuePanel from "./QueuePanel";
import { formatTime } from "./transport/format";
import SeekBar from "./transport/SeekBar";
import TransportButton from "./transport/TransportButton";
import VolumeControl from "./transport/VolumeControl";
import WaveformDisplay from "./WaveformDisplay";

/** Which side panel is open. One at a time — they share the same corner. */
type Panel = "none" | "queue" | "lyrics";

export default function PlayerBar() {
	const player = useMediaPlayer();
	const [panel, setPanel] = useState<Panel>("none");

	const track = player.currentTrack;
	if (!track) return null;

	const toggle = (which: Exclude<Panel, "none">) => setPanel((p) => (p === which ? "none" : which));

	const hasLyrics = !!track.lyrics?.trim();

	return (
		<div
			className="fixed inset-x-0 bottom-0 z-50 border-t border-base-300 bg-base-200/95 shadow-lg backdrop-blur"
			data-testid="player-bar"
		>
			<div className="relative mx-auto flex min-w-0 max-w-screen-xl items-center gap-3 px-3 py-2">
				{panel === "queue" && <QueuePanel onClose={() => setPanel("none")} />}
				{panel === "lyrics" && hasLyrics && (
					<LyricsPanel
						title={track.title}
						lyrics={track.lyrics ?? ""}
						onClose={() => setPanel("none")}
					/>
				)}

				{/* ── Now playing ── */}
				<div className="flex w-44 min-w-0 shrink-0 items-center gap-2 sm:w-56">
					{track.thumbnail ? (
						<img src={track.thumbnail} alt="" className="size-10 shrink-0 rounded object-cover" />
					) : (
						<div className="flex size-10 shrink-0 items-center justify-center rounded bg-base-300">
							<MusicalNoteIcon className="size-5 text-base-content/30" />
						</div>
					)}
					<div className="min-w-0">
						<Link
							to={workUrl({ slug: track.slug, publicId: track.publicId })}
							className="block truncate text-sm font-medium leading-tight link-hover"
							data-testid="now-playing-title"
						>
							{track.title}
						</Link>
						{track.creatorUsername ? (
							<Link
								to={profileUrl(track.creatorUsername)}
								className="block truncate text-xs text-base-content/55 hover:text-primary hover:underline"
							>
								{track.creator}
							</Link>
						) : (
							<span className="block truncate text-xs text-base-content/55">{track.creator}</span>
						)}
					</div>
				</div>

				{/* ── Transport ── */}
				<div className="flex shrink-0 items-center gap-0.5">
					<TransportButton
						label={player.shuffle ? "Shuffle: on" : "Shuffle: off"}
						icon={ArrowsRightLeftIcon}
						onClick={player.toggleShuffle}
						active={player.shuffle}
						size="xs"
						className="hidden sm:inline-flex"
					/>
					<TransportButton
						label="Previous"
						icon={BackwardIcon}
						onClick={player.previous}
						disabled={!player.hasPrevious}
					/>
					<TransportButton
						label={player.isPlaying ? "Pause" : "Play"}
						icon={player.isPlaying ? PauseIcon : PlayIcon}
						onClick={player.isPlaying ? player.pause : player.resume}
						tone="primary"
						disabled={player.locked || player.allowanceSpent}
					/>
					<TransportButton
						label="Next"
						icon={ForwardIcon}
						onClick={player.next}
						disabled={!player.hasNext}
					/>
					<TransportButton
						label={`Repeat: ${player.repeat}`}
						icon={ArrowPathIcon}
						onClick={player.cycleRepeat}
						active={player.repeat !== "off"}
						size="xs"
						className="hidden sm:inline-flex"
						badge={
							player.repeat === "one" ? (
								<span className="absolute right-1 top-0.5 text-[8px] font-bold leading-none">
									1
								</span>
							) : undefined
						}
					/>
				</div>

				{/* ── The middle: a scrubber, or the reason there isn't one ── */}
				{player.allowanceSpent ? (
					<Notice>
						That's your {FREE_PUBLIC_ACCESS_HOURS} hours of Public Access this month — the music
						stays free, the hours reset.{" "}
						<Link to="/subscribe" className="link link-primary">
							Support Anthers
						</Link>
					</Notice>
				) : player.locked ? (
					<Notice>
						Gated by {track.creator}.{" "}
						<Link
							to={workUrl({ slug: track.slug, publicId: track.publicId })}
							className="link link-primary"
						>
							See how to unlock it
						</Link>
					</Notice>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-base-content/50">
							{formatTime(player.progress)}
						</span>
						<SeekBar
							position={player.progress}
							duration={player.duration}
							onSeek={player.seek}
							label="Seek track"
							className="flex-1"
							track={
								track.waveform && track.waveform.length > 0 ? (
									<WaveformDisplay
										peaks={track.waveform}
										progress={player.duration > 0 ? player.progress / player.duration : 0}
										height={28}
									/>
								) : undefined
							}
						/>
						<span className="w-9 shrink-0 text-[11px] tabular-nums text-base-content/50">
							{formatTime(player.duration)}
						</span>
					</div>
				)}

				{/* ── Panels + volume ── */}
				{hasLyrics && (
					<TransportButton
						label="Lyrics"
						icon={MusicalNoteIcon}
						onClick={() => toggle("lyrics")}
						active={panel === "lyrics"}
						className="hidden md:inline-flex"
					/>
				)}
				<TransportButton
					label="Queue"
					icon={QueueListIcon}
					onClick={() => toggle("queue")}
					active={panel === "queue"}
				/>
				<div className="hidden sm:block">
					<VolumeControl collapsible />
				</div>
				<TransportButton label="Close player" icon={XMarkIcon} onClick={player.close} size="xs" />
			</div>
		</div>
	);
}

/** The middle slot when there is something to say instead of a scrubber. */
function Notice({ children }: { children: React.ReactNode }) {
	return (
		<p className="min-w-0 flex-1 truncate text-xs text-base-content/70 sm:whitespace-normal">
			{children}
		</p>
	);
}
