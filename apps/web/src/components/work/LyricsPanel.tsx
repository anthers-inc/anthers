// SPDX-License-Identifier: Apache-2.0
/**
 * A music Work's lyrics, the words panel of the listened Work's stage.
 *
 * **Collapsed until asked for, by design** (Parker, 2026-10-16, and the stage keeps
 * it): the words are one click away but never pushed on the listener, who may have
 * them open in the persistent bar already. What the stage changes is *where opening
 * puts them* — not a card unfolding under a floating strip, but a drawer that slides
 * in over the waveform's right side (`ListenStage`'s `AsideDrawer`) and scrolls when
 * the words outrun it. The toggle and the drawer's chrome live there; this module is
 * only the words.
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

/** The Studio's lyrics editor surface — the textarea's own box, not the reader's. */
export const WORK_LYRICS_CLASS = "rounded-lg bg-base-200/60 p-4";
export const WORK_LYRICS_HEADING_CLASS =
	"text-xs font-semibold uppercase tracking-wider text-base-content/50";

/**
 * The words, filling whatever the drawer gives them. The drawer owns the height and
 * the scroll, so this is the text and its line breaks and nothing else — a shorter
 * song simply leaves the space below it empty.
 */
export function LyricsBody({ lyrics }: { lyrics: string }) {
	return (
		<p className="whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">{lyrics}</p>
	);
}
