// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The three-bar "this is the one playing" indicator, in `currentColor`.
 *
 * Adapted from Garnet's `PlayingBars`. Anthers uses it anywhere a list has to mark one
 * row as live — a track row, the queue, a chapter list — so the mark means the same
 * thing in all of them.
 */

/**
 * @param playing Whether the bars should animate. Paused renders them static and short,
 *   which is a different picture from "no indicator at all" — the row is still the
 *   current one, it just isn't moving.
 */
export default function PlayingBars({
	className = "",
	playing = true,
}: {
	className?: string;
	playing?: boolean;
}) {
	return (
		<span
			className={`inline-flex h-3.5 items-end gap-[2px] ${className}`}
			role="img"
			aria-label={playing ? "Playing" : "Paused"}
		>
			{[0, 180, 360].map((delay) => (
				<span
					key={delay}
					// `motion-safe:` rather than a media query in CSS: with reduced motion the
					// bars simply stand still at full height, which still marks the row.
					className={`w-[2px] origin-bottom bg-current ${
						playing ? "h-full motion-safe:animate-eq-bar" : "h-1/2"
					}`}
					style={playing ? { animationDelay: `${delay}ms` } : undefined}
				/>
			))}
		</span>
	);
}
