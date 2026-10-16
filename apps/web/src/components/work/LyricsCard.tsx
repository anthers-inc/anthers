// SPDX-License-Identifier: Apache-2.0
/**
 * A music Work's lyrics, as a disclosure card under the player.
 *
 * **Starts collapsed, by design** (Parker, 2026-10-16): the words are one click away but
 * never pushed on the listener, who may have them open in the persistent bar already.
 * The toggle is the header row — the ARIA disclosure pattern, a heading wrapping a
 * button, so a screen reader announces a heading that operates.
 *
 * Plain text in a `whitespace-pre-wrap` block: lyrics are line-broken words, and the API
 * sends them as text with no HTML anywhere in the path — so there is nothing to
 * sanitize here, because nothing is ever interpreted as markup.
 *
 * ⚠️ If a Work's lyrics are missing from a card you can see, that is the gate working,
 * not a rendering bug: `serializeWorkForUser` blanks them for a user without access,
 * exactly as it blanks the audio itself — and the card is not rendered at all then,
 * because `WorkDeliverable` only mounts one when the words arrived.
 */
import { ChevronDownIcon } from "@heroicons/react/24/solid";
import { useState } from "react";

/** The card, and its heading style — shared with the Studio's, which imports these. */
export const WORK_LYRICS_CLASS = "mt-4 rounded-lg bg-base-200/60 p-4";
export const WORK_LYRICS_HEADING_CLASS =
	"text-xs font-semibold uppercase tracking-wider text-base-content/50";

export default function LyricsCard({ lyrics }: { lyrics: string }) {
	const [open, setOpen] = useState(false);

	return (
		<section className={WORK_LYRICS_CLASS}>
			<h2 className={WORK_LYRICS_HEADING_CLASS}>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					className="flex w-full items-center justify-between gap-2"
					title={open ? "Hide lyrics" : "Show lyrics"}
				>
					<span>Lyrics</span>
					<ChevronDownIcon
						aria-hidden
						className={`size-4 shrink-0 transition-transform duration-200 ${
							open ? "rotate-180" : ""
						}`}
					/>
				</button>
			</h2>
			{/* Unmounted rather than display-none: the collapsed card really does not carry
			    its words on the page — the gate test just below proves exactly that shape. */}
			{open && (
				<p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">
					{lyrics}
				</p>
			)}
		</section>
	);
}
