// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What's playing and what follows, floating above the player bar.
 *
 * Adapted from Garnet's `QueuePanel`, with one addition Garnet has no need of: a queued
 * track the listener **cannot play** is shown as such rather than hidden. Hiding it would
 * be the tidier list and the dishonest one — the album really does have five tracks, two
 * of them are gated, and a queue that silently shows three is a queue that lies about the
 * record you put on.
 */

import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { LockClosedIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { useMediaPlayer } from "../../lib/media-player";
import type { QueueTrack } from "../../lib/music-queue";
import { formatTime } from "./transport/format";
import PlayingBars from "./transport/PlayingBars";

export default function QueuePanel({ onClose }: { onClose: () => void }) {
	const { currentTrack, isPlaying, upcoming, jumpTo } = useMediaPlayer();

	return (
		<div className="absolute bottom-full right-2 z-30 mb-2 flex max-h-[55vh] w-80 flex-col rounded-box border border-base-300 bg-base-100 shadow-2xl">
			<div className="flex items-center justify-between border-b border-base-300 px-3 py-2">
				<span className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
					Queue
				</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs btn-circle"
					onClick={onClose}
					aria-label="Close queue"
				>
					<XMarkIcon className="size-4" />
				</button>
			</div>

			<div className="overflow-y-auto p-1.5">
				{currentTrack && (
					<>
						<SectionLabel>Now playing</SectionLabel>
						<QueueRow track={currentTrack} playing={isPlaying} current />
					</>
				)}
				{upcoming.length > 0 ? (
					<>
						<SectionLabel>Up next</SectionLabel>
						{upcoming.map(({ track, pos }) => (
							<QueueRow key={`${track.workId}-${pos}`} track={track} onClick={() => jumpTo(pos)} />
						))}
					</>
				) : (
					<p className="px-2 py-4 text-center text-xs text-base-content/40">Nothing up next</p>
				)}
			</div>
		</div>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
			{children}
		</div>
	);
}

function QueueRow({
	track,
	playing = false,
	current = false,
	onClick,
}: {
	track: QueueTrack;
	playing?: boolean;
	current?: boolean;
	onClick?: () => void;
}) {
	const gated = !track.src;
	const body = (
		<>
			<span className="flex w-4 shrink-0 justify-center">
				{current ? (
					<PlayingBars className="text-primary" playing={playing} />
				) : gated ? (
					// A padlock rather than a missing row: the track is in the queue, it is
					// just not yours yet. Paired with the word "Gated" below so the meaning
					// does not rest on the icon alone.
					<LockClosedIcon className="size-3.5 text-base-content/40" />
				) : null}
			</span>
			<span className="min-w-0 flex-1">
				<span className={`block truncate text-sm leading-tight ${current ? "text-primary" : ""}`}>
					{track.title}
				</span>
				<span className="block truncate text-xs text-base-content/55">
					{gated ? `Gated · ${track.creator}` : track.creator}
				</span>
			</span>
			<span className="shrink-0 text-[11px] tabular-nums text-base-content/45">
				{track.durationSeconds ? formatTime(track.durationSeconds) : ""}
			</span>
		</>
	);

	// A gated row links to the Work rather than trying to play it — that page is where the
	// unlock actually is, so the row leads somewhere useful instead of doing nothing.
	if (gated && !current) {
		return (
			<Link
				to={workUrl({ slug: track.slug, publicId: track.publicId })}
				className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-base-content/5"
			>
				{body}
			</Link>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={current}
			className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
				current ? "text-primary" : "hover:bg-base-content/5"
			}`}
		>
			{body}
		</button>
	);
}
