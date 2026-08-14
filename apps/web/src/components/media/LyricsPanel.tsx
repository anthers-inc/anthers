// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A track's words, shown while it plays.
 *
 * **Untimestamped, deliberately** — no karaoke, no per-line highlight, no scroll that
 * follows the song. Parker's framing was "they won't be timestamped, but it'd be cool to
 * have lyrics attached to songs", and a sync feature would need a per-line editor in the
 * Studio that nothing asks for.
 *
 * Plain text in a `whitespace-pre-wrap` block rather than rich text: lyrics are
 * line-broken words, and the API sends them as text with no HTML anywhere in the path —
 * so there is nothing to sanitize here, because nothing is ever interpreted as markup.
 *
 * ⚠️ If this renders nothing for a track you know has lyrics, the likely reason is the
 * gate rather than a bug: `serializeWorkForViewer` blanks them for a viewer without
 * access, exactly as it blanks the audio itself.
 */
import { XMarkIcon } from "@heroicons/react/24/solid";

export default function LyricsPanel({
	title,
	lyrics,
	onClose,
}: {
	title: string;
	lyrics: string;
	onClose: () => void;
}) {
	return (
		<div className="absolute bottom-full right-2 z-30 mb-2 flex max-h-[55vh] w-80 flex-col rounded-box border border-base-300 bg-base-100 shadow-2xl">
			<div className="flex items-center justify-between border-b border-base-300 px-3 py-2">
				<span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-base-content/60">
					{title}
				</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs btn-circle"
					onClick={onClose}
					aria-label="Close lyrics"
				>
					<XMarkIcon className="size-4" />
				</button>
			</div>
			<div className="overflow-y-auto px-4 py-3">
				<p className="whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">{lyrics}</p>
			</div>
		</div>
	);
}
