// SPDX-License-Identifier: Apache-2.0
/**
 * Theater mode's glyph: a screen with a filled strip along its foot.
 *
 * Heroicons has a full-screen glyph (the four corners) and nothing that reads as
 * "theater" — the mode's whole idea is a screen that keeps its page around it — so this
 * one is drawn to the same 24×24 box as the rest of the transport, in `currentColor`, and
 * takes the same class the transport hands every icon.
 */
export default function TheaterIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.7}
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="M3 14.5h18v3a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="currentColor" />
		</svg>
	);
}
