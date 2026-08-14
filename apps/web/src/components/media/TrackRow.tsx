// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One row of a track list.
 *
 * Adapted from Garnet's `TrackRow`: the leading cell shows the track number, swapping to a
 * play triangle on hover and to the animated equalizer for whatever is playing. The
 * columns line up with the header via the shared `TRACK_GRID`, so a list and its header
 * cannot drift.
 *
 * The Anthers addition is the **gated** row. A gated track keeps its number and its title
 * and gains a padlock and a "Gated" label — it is not hidden and not greyed into
 * illegibility, because it is a real part of the record and the point is that the listener
 * can see what they would get.
 */
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { PauseIcon, PlayIcon } from "@heroicons/react/24/solid";
import type { QueueTrack } from "../../lib/music-queue";
import { formatTime } from "./transport/format";
import PlayingBars from "./transport/PlayingBars";

/** Shared column template for the header + rows: # · title · state · time. */
export const TRACK_GRID = "grid grid-cols-[1.75rem_1fr_auto_3.25rem] items-center gap-x-4";

export default function TrackRow({
	track,
	index,
	isCurrent,
	isPlaying,
	onPlay,
}: {
	track: QueueTrack;
	index: number;
	isCurrent: boolean;
	isPlaying: boolean;
	onPlay: () => void;
}) {
	const gated = !track.src;

	const inner = (
		<>
			<span
				className={`flex justify-center text-xs tabular-nums ${
					isCurrent ? "text-primary" : "text-base-content/45"
				}`}
			>
				{isCurrent ? (
					isPlaying ? (
						<PlayingBars className="text-primary" />
					) : (
						<PauseIcon className="size-3.5" />
					)
				) : gated ? (
					<LockClosedIcon className="size-3.5" />
				) : (
					<>
						<span className="group-hover:hidden">{index + 1}</span>
						<PlayIcon className="hidden size-3.5 group-hover:block" />
					</>
				)}
			</span>
			<span className={`min-w-0 truncate text-sm ${isCurrent ? "font-medium text-primary" : ""}`}>
				{track.title}
			</span>
			{/* A word, not only a padlock — colour and iconography alone are not a status. */}
			<span className="text-[10px] font-medium uppercase tracking-wide text-base-content/40">
				{gated ? "Gated" : ""}
			</span>
			<span className="text-right text-xs tabular-nums text-base-content/45">
				{track.durationSeconds ? formatTime(track.durationSeconds) : ""}
			</span>
		</>
	);

	const shared = `${TRACK_GRID} group w-full rounded-md px-3 py-1.5 text-left transition-colors hover:bg-base-content/5 ${
		isCurrent ? "bg-base-content/5" : ""
	}`;

	// A gated row leads to the Work page, which is where the unlock actually is. Making it
	// a dead button would be the obvious implementation and leaves the listener with a
	// control that does nothing and no route onward.
	if (gated) {
		return (
			<Link
				to={workUrl({ slug: track.slug, publicId: track.publicId })}
				className={shared}
				title={`${track.title} — gated`}
				data-testid="track-row"
			>
				{inner}
			</Link>
		);
	}

	return (
		<button type="button" onClick={onPlay} className={shared} data-testid="track-row">
			{inner}
		</button>
	);
}
