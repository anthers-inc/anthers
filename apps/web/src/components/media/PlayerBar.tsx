// SPDX-License-Identifier: Apache-2.0
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
 *   - **Allowance spent.** The track is free and stays free; the user's monthly Public
 *     Access hours ran out. 🚨 The copy has to put it that way round — "you've used your
 *     hours", never "this is locked" — or the commons reads as stratified again, which is
 *     the thing the binary model exists to prevent.
 *
 * The bar owns its own arrival. `close()` clears `currentTrack` on the same frame the
 * layout would shrink the page's bottom padding, so the exit is drawn from a snapshot of
 * the last track: without it the bar would spend its exit showing an empty bar and a
 * thumb snapped to zero. The artwork and the title carry the track change, and the two
 * side panels ride `<Appear>` rather than appearing and vanishing with the conditional.
 */
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { EASE_SETTLE, MOTION, useReducedMotion } from "@anthers/web-shared/motion";
import { workUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import Appear from "@anthers/web-shared/ui/Appear";
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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type QueueTrack, type RepeatMode, useMediaPlayer } from "../../lib/media-player";
import { useSpokenRate } from "../../lib/spoken-rate";
import LyricsPanel from "./LyricsPanel";
import QueuePanel from "./QueuePanel";
import { formatTime } from "./transport/format";
import SeekBar from "./transport/SeekBar";
import SpeedMenu from "./transport/SpeedMenu";
import TransportButton from "./transport/TransportButton";
import VolumeControl from "./transport/VolumeControl";
import WaveformDisplay from "./WaveformDisplay";

/** Which side panel is open. One at a time — they share the same corner. */
type Panel = "none" | "queue" | "lyrics";

/**
 * What the bar draws. The live track normally; the last track while the bar animates
 * away, because the provider has already forgotten it.
 */
interface BarView {
	track: QueueTrack;
	progress: number;
	duration: number;
	isPlaying: boolean;
	locked: boolean;
	allowanceSpent: boolean;
	shuffle: boolean;
	repeat: RepeatMode;
	hasNext: boolean;
	hasPrevious: boolean;
}

export default function PlayerBar() {
	const player = useMediaPlayer();
	const [panel, setPanel] = useState<Panel>("none");
	const [spokenRate, setSpokenRate] = useSpokenRate();

	const track = player.currentTrack;
	// Kept current on every render while there is a track. `close()` clears the track,
	// the progress, the duration and the playing flag together, so reading the provider
	// during the exit would draw a bar that had already forgotten what it was playing.
	const lastView = useRef<BarView | null>(null);
	if (track) {
		lastView.current = {
			track,
			progress: player.progress,
			duration: player.duration,
			isPlaying: player.isPlaying,
			locked: player.locked,
			allowanceSpent: player.allowanceSpent,
			shuffle: player.shuffle,
			repeat: player.repeat,
			hasNext: player.hasNext,
			hasPrevious: player.hasPrevious,
		};
	}
	const view = lastView.current;

	const toggle = (which: Exclude<Panel, "none">) => setPanel((p) => (p === which ? "none" : which));

	const hasLyrics = !!view?.track.lyrics?.trim();

	// Listening to talk is a different posture from listening to music: one episode has
	// nothing to shuffle, "repeat one" on a queue of one is indistinguishable from off,
	// and the speed a listener set on the Work page is the thing the bar has to honor.
	const spoken = view?.track.kind === "audio";

	return (
		<Appear
			show={track !== null}
			className="fixed inset-x-0 bottom-0 z-50 border-t border-base-300 bg-base-200/95 shadow-lg backdrop-blur"
			distance={24}
			duration={MOTION.base}
			exitDuration={MOTION.base}
		>
			{view && (
				<div
					className="relative mx-auto flex min-w-0 max-w-screen-xl items-center gap-3 px-3 py-2"
					data-testid="player-bar"
				>
					<Appear
						show={panel === "queue"}
						className="absolute bottom-full right-2 z-30 mb-2"
						distance={8}
						duration={MOTION.fast}
						exitDuration={MOTION.fast}
					>
						<QueuePanel onClose={() => setPanel("none")} />
					</Appear>
					<Appear
						show={panel === "lyrics" && hasLyrics}
						className="absolute bottom-full right-2 z-30 mb-2"
						distance={8}
						duration={MOTION.fast}
						exitDuration={MOTION.fast}
					>
						<LyricsPanel
							title={view.track.title}
							lyrics={view.track.lyrics ?? ""}
							onClose={() => setPanel("none")}
						/>
					</Appear>

					{/* ── Now playing ── */}
					<div className="flex w-44 min-w-0 shrink-0 items-center gap-2 sm:w-56">
						<TrackArtwork src={view.track.thumbnail ?? null} />
						<TrackMeta key={view.track.workId} track={view.track} />
					</div>

					{/* ── Transport ── */}
					<div className="flex shrink-0 items-center gap-0.5">
						{!spoken && (
							<TransportButton
								label={view.shuffle ? "Shuffle: on" : "Shuffle: off"}
								icon={ArrowsRightLeftIcon}
								onClick={player.toggleShuffle}
								active={view.shuffle}
								size="xs"
								className="hidden sm:inline-flex"
							/>
						)}
						<TransportButton
							label="Previous"
							icon={BackwardIcon}
							onClick={player.previous}
							disabled={!view.hasPrevious}
						/>
						<TransportButton
							label={view.isPlaying ? "Pause" : "Play"}
							icon={view.isPlaying ? PauseIcon : PlayIcon}
							onClick={view.isPlaying ? player.pause : player.resume}
							tone="primary"
							disabled={view.locked || view.allowanceSpent}
						/>
						<TransportButton
							label="Next"
							icon={ForwardIcon}
							onClick={player.next}
							disabled={!view.hasNext}
						/>
						{!spoken && (
							<TransportButton
								label={`Repeat: ${view.repeat}`}
								icon={ArrowPathIcon}
								onClick={player.cycleRepeat}
								active={view.repeat !== "off"}
								size="xs"
								className="hidden sm:inline-flex"
								badge={
									view.repeat === "one" ? (
										<span className="absolute right-1 top-0.5 text-[8px] font-bold leading-none">
											1
										</span>
									) : undefined
								}
							/>
						)}
					</div>

					{/* ── The middle: a scrubber, or the reason there isn't one ── */}
					{view.allowanceSpent ? (
						<Notice>
							That's your {FREE_PUBLIC_ACCESS_HOURS} hours of Public Access this month — the music
							stays free, the hours reset.{" "}
							<Link to="/signup" className="link link-primary">
								Support Anthers
							</Link>
						</Notice>
					) : view.locked ? (
						<Notice>
							Gated by {view.track.creator}.{" "}
							<Link
								to={workUrl({ slug: view.track.slug, publicId: view.track.publicId })}
								className="link link-primary"
							>
								See how to unlock it
							</Link>
						</Notice>
					) : (
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-base-content/50">
								{formatTime(view.progress)}
							</span>
							<SeekBar
								position={view.progress}
								duration={view.duration}
								onSeek={player.seek}
								label="Seek track"
								className="flex-1"
								track={
									view.track.waveform && view.track.waveform.length > 0 ? (
										<WaveformDisplay
											peaks={view.track.waveform}
											progress={view.duration > 0 ? view.progress / view.duration : 0}
											height={28}
										/>
									) : undefined
								}
							/>
							<span className="w-9 shrink-0 text-[11px] tabular-nums text-base-content/50">
								{formatTime(view.duration)}
							</span>
							{/* The same menu the Work page's spoken player opens, so the rate
							    reads identically in both places — see transport/SpeedMenu.tsx. */}
							{spoken && <SpeedMenu rate={spokenRate} onRate={setSpokenRate} size="xs" />}
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
			)}
		</Appear>
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

/**
 * The cover, cross-faded on a track change: the outgoing cover stays mounted on top and
 * fades out over the incoming one, so the bar never dips through its own background. The
 * first cover has nothing underneath, so it fades in on its own.
 */
function TrackArtwork({ src }: { src: string | null }) {
	const reduce = useReducedMotion();
	const [shown, setShown] = useState(src);
	const [previous, setPrevious] = useState<string | null>(null);
	const incoming = useRef<HTMLImageElement>(null);
	const outgoing = useRef<HTMLImageElement>(null);
	/** The cover the entrance has already been played for, so a later re-render cannot replay it. */
	const animatedFor = useRef<string | null | undefined>(undefined);

	useEffect(() => {
		if (src === shown) return;
		setPrevious(shown);
		setShown(src);
	}, [src, shown]);

	useLayoutEffect(() => {
		if (reduce || animatedFor.current === shown) return;
		animatedFor.current = shown;
		// A change has a cover underneath to fade out instead, so only a first paint fades in.
		if (previous !== null) return;
		incoming.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
			duration: MOTION.base,
			easing: EASE_SETTLE,
		});
	}, [shown, previous, reduce]);

	useLayoutEffect(() => {
		if (!previous) return;
		if (reduce) {
			setPrevious(null);
			return;
		}
		const element = outgoing.current;
		if (!element) return;
		const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], {
			duration: MOTION.base,
			easing: EASE_SETTLE,
			fill: "forwards",
		});
		const timer = window.setTimeout(() => setPrevious(null), MOTION.base + 20);
		return () => {
			window.clearTimeout(timer);
			animation.cancel();
		};
	}, [previous, reduce]);

	return (
		<span className="relative size-10 shrink-0 overflow-hidden rounded bg-base-300">
			{shown ? (
				<img ref={incoming} src={shown} alt="" className="size-full object-cover" />
			) : (
				<span className="flex size-full items-center justify-center">
					<MusicalNoteIcon className="size-5 text-base-content/30" />
				</span>
			)}
			{previous && (
				<img
					ref={outgoing}
					src={previous}
					alt=""
					aria-hidden="true"
					className="absolute inset-0 size-full object-cover"
				/>
			)}
		</span>
	);
}

/** Title and creator, rising a few pixels as they replace the previous track's. */
function TrackMeta({ track }: { track: QueueTrack }) {
	const ref = useRef<HTMLDivElement>(null);
	const reduce = useReducedMotion();

	useLayoutEffect(() => {
		if (reduce || !ref.current) return;
		ref.current.animate(
			[
				{ opacity: 0, transform: "translateY(4px)" },
				{ opacity: 1, transform: "none" },
			],
			{ duration: MOTION.base, easing: EASE_SETTLE },
		);
	}, [reduce]);

	return (
		<div ref={ref} className="min-w-0">
			<Link
				to={workUrl({ slug: track.slug, publicId: track.publicId })}
				className="block truncate text-sm font-medium leading-tight link-hover"
				data-testid="now-playing-title"
			>
				{track.title}
			</Link>
			{track.creatorHandle ? (
				<Link
					to={profileUrl(track.creatorHandle)}
					className="block truncate text-xs text-base-content/55 hover:text-primary hover:underline"
				>
					{track.creator}
				</Link>
			) : (
				<span className="block truncate text-xs text-base-content/55">{track.creator}</span>
			)}
		</div>
	);
}
