// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's chapter list, mounted inside the player it navigates — the rail for a
 * video, the transport list for the two audio players. Rows are the creator's own
 * titles off the description (a cue with nothing on its line reads as its time), and
 * the row playing now is marked so a long episode reads where it is.
 *
 * Cues beyond the media's known end drop out — a description written for a longer cut
 * of the same file must not list places the player cannot reach. With no known
 * duration (metadata not arrived, a live stream) nothing filters and every cue shows.
 */
import type { WorkChapter } from "@anthers/shared/chapters";
import { chapterIndexFor } from "@anthers/shared/chapters";
import { formatTime } from "./transport/format";

export default function ChapterList({
	chapters,
	position,
	duration,
	onSeek,
	/** Fixed light-on-dark palette, for a list mounted inside the video picture. */
	dark = false,
}: {
	chapters: WorkChapter[];
	position: number;
	duration: number;
	onSeek: (seconds: number) => void;
	dark?: boolean;
}) {
	const playable = chapters.filter((c) => duration <= 0 || c.seconds < duration);
	if (chapters.length > 0 && playable.length === 0) return null;
	const active = chapterIndexFor(playable, position);
	return (
		<div
			data-testid="chapter-list"
			className={`border-t px-4 py-3 ${dark ? "border-white/10" : "border-base-300"}`}
		>
			<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Chapters
			</h3>
			{/* The scroll is inside the list: the container must not grow with it, or a
			    40-cue episode would page the player off screen. */}
			<ul className="max-h-56 overflow-y-auto pt-2">
				{playable.map((chapter, index) => {
					const playing = index === active;
					return (
						<li key={`${chapter.seconds}-${chapter.title ?? ""}`}>
							<button
								type="button"
								aria-current={playing ? "true" : undefined}
								data-testid={`chapter-${chapter.seconds}`}
								onClick={() => onSeek(chapter.seconds)}
								className={`flex w-full items-baseline gap-2.5 rounded px-2 py-1 text-left text-sm ${
									dark
										? "text-white/80 hover:bg-white/10"
										: "text-base-content/80 hover:bg-base-content/10"
								} ${playing ? "bg-base-content/5 font-medium text-base-content" : ""}`}
							>
								<span className="shrink-0 tabular-nums text-xs opacity-70">
									{formatTime(chapter.seconds)}
								</span>
								<span className="truncate">{chapter.title ?? formatTime(chapter.seconds)}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
