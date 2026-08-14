// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A record, rendered as a record: cover, title, Play and Shuffle, and the tracks in order.
 *
 * Adapted from Garnet's `AlbumDetailView` — including the blurred cover behind the header,
 * which is the cheapest thing in that plugin and does the most to make a page feel like it
 * belongs to the music rather than to the site.
 *
 * **The album is not a new entity.** It is a Project of ordered audio Works: `project_items`
 * already carries `sortOrder`, which is the whole artifact of an EP. So this component
 * takes tracks and a title, and the same shelf that renders here renders in the library
 * lens — which is the point of building the two together rather than in sequence.
 *
 * ⚠️ Playing the album starts the queue from the **first playable** track, not from index
 * 0. Pressing Play on a record whose first single is gated and having nothing happen is
 * the stall this whole area exists to avoid.
 */
import { ArrowsRightLeftIcon, PlayIcon } from "@heroicons/react/24/solid";
import { useMediaPlayer } from "../../lib/media-player";
import { isPlayable, type QueueTrack } from "../../lib/music-queue";
import TrackRow, { TRACK_GRID } from "./TrackRow";
import { formatTime } from "./transport/format";

export default function AlbumView({
	title,
	creator,
	cover,
	tracks,
}: {
	title: string;
	creator?: React.ReactNode;
	cover?: string | null;
	tracks: QueueTrack[];
}) {
	const player = useMediaPlayer();

	const playable = tracks.filter(isPlayable);
	const totalSeconds = tracks.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0);
	const firstPlayable = tracks.findIndex(isPlayable);

	const start = (shuffle: boolean) => {
		if (firstPlayable < 0) return;
		player.playTracks(tracks, firstPlayable, { shuffle });
	};

	return (
		<section className="overflow-hidden rounded-box border border-base-300 bg-base-100">
			{/* Header, over a blurred blow-up of its own cover. */}
			<div className="relative overflow-hidden border-b border-base-300">
				{cover && (
					<div className="pointer-events-none absolute inset-0" aria-hidden="true">
						<img
							src={cover}
							alt=""
							className="size-full scale-125 object-cover opacity-25 blur-3xl saturate-150"
						/>
						<div className="absolute inset-0 bg-gradient-to-t from-base-100 via-base-100/85 to-base-100/40" />
					</div>
				)}

				<header className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-end">
					{cover ? (
						<img
							src={cover}
							alt=""
							className="size-36 shrink-0 rounded-lg object-cover shadow-2xl ring-1 ring-base-content/10 sm:size-44"
						/>
					) : (
						<div className="flex size-36 shrink-0 items-center justify-center rounded-lg bg-base-300 shadow-2xl sm:size-44">
							<PlayIcon className="size-10 text-base-content/20" />
						</div>
					)}

					<div className="min-w-0 flex-1 pb-1">
						<h2 className="truncate text-2xl font-bold leading-tight sm:text-3xl">{title}</h2>
						{creator && <div className="truncate text-lg text-base-content/80">{creator}</div>}
						<p className="mt-1 text-xs text-base-content/55">
							{tracks.length} {tracks.length === 1 ? "track" : "tracks"}
							{totalSeconds > 0 && ` · ${formatTime(totalSeconds)}`}
							{/* Said out loud rather than left to be discovered one padlock at a
							    time — a listener deciding whether to press Play deserves to know
							    how much of the record they can actually hear. */}
							{playable.length < tracks.length &&
								` · ${playable.length} playable, ${tracks.length - playable.length} gated`}
						</p>

						<div className="mt-3 flex items-center gap-2">
							<button
								type="button"
								onClick={() => start(false)}
								disabled={playable.length === 0}
								className="btn btn-primary btn-sm gap-1 rounded-full px-5"
							>
								<PlayIcon className="size-4" />
								Play
							</button>
							<button
								type="button"
								onClick={() => start(true)}
								disabled={playable.length < 2}
								className="btn btn-ghost btn-sm gap-1 rounded-full"
							>
								<ArrowsRightLeftIcon className="size-4" />
								Shuffle
							</button>
						</div>
					</div>
				</header>
			</div>

			{/* Track table */}
			<div className="p-2">
				<div
					className={`${TRACK_GRID} px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/40`}
				>
					<span className="text-center">#</span>
					<span>Title</span>
					<span />
					<span className="text-right">Time</span>
				</div>
				<div className="h-px bg-base-300" />
				<ul className="mt-1">
					{tracks.map((track, i) => {
						const isCurrent = player.currentTrack?.workId === track.workId;
						return (
							<li key={track.workId}>
								<TrackRow
									track={track}
									index={i}
									isCurrent={isCurrent}
									isPlaying={isCurrent && player.isPlaying}
									// The whole album becomes the queue, positioned on the track
									// that was clicked — so pressing play on track 4 still plays
									// 5 and 6 afterwards.
									onPlay={() => player.playTracks(tracks, i)}
								/>
							</li>
						);
					})}
				</ul>
			</div>
		</section>
	);
}
