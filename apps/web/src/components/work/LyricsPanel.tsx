// SPDX-License-Identifier: Apache-2.0
/**
 * A music Work's lyrics, the words panel of the listened Work's stage.
 *
 * **Collapsed until asked for, by design** (Parker, 2026-10-16, and the stage keeps
 * it): the words are one click away but never pushed on the listener, who may have
 * them open in the persistent bar already. What the stage changes is *where opening
 * puts them* — not a card unfolding under a floating strip, but a scrollable panel
 * that slides in as the stage's right column and reshapes the waveform to meet it.
 * The toggle lives in the transport row (`AudioPlayer`, when it is handed an
 * `aside`); the panel here is only what that toggle reveals — no toggle of its own,
 * the words and their line breaks and nothing else.
 *
 * Plain text in a `whitespace-pre-wrap` block: lyrics are line-broken words, and the API
 * sends them as text with no HTML anywhere in the path — so there is nothing to
 * sanitize here, because nothing is ever interpreted as markup.
 *
 * ⚠️ If a Work's lyrics are missing from a card you can see, that is the gate working,
 * not a rendering bug: `serializeWorkForUser` blanks them for a user without access,
 * exactly as it blanks the audio itself — and no toggle or panel is rendered at all
 * then, because `WorkDeliverable` only hands the player an `aside` when the words
 * arrived.
 */
import type { ReactNode } from "react";

/** The stage's panel chrome, and its heading style — shared with the Studio's, which imports these. */
export const WORK_LYRICS_CLASS = "rounded-lg bg-base-200/60 p-4";
export const WORK_LYRICS_HEADING_CLASS =
	"text-xs font-semibold uppercase tracking-wider text-base-content/50";

/**
 * The words, filling the column they are given: scroll when they are longer than the
 * stage is tall, centered as a whole when they are shorter. Never interactive — the
 * toggle that opens and closes them is the transport's.
 */
export function LyricsBody({ lyrics }: { lyrics: string }) {
	return (
		<p className="flex h-full w-full flex-col justify-center overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">
			{lyrics}
		</p>
	);
}

/**
 * The stage column's shell — border, heading and scroll, around whatever the stage
 * hands it (the words on a user's read; the creator's editable field there). The
 * heading names the room, so the toggle in the transport stays just a chevron.
 */
export function LyricsShelf({
	label = "Lyrics",
	children,
}: {
	label?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={label}
			className="flex min-h-0 w-full flex-col gap-2 rounded-lg border border-base-300/70 bg-base-100/40 p-4"
		>
			<h2 className={WORK_LYRICS_HEADING_CLASS}>{label}</h2>
			<div className="min-h-0 flex-1">{children}</div>
		</section>
	);
}
