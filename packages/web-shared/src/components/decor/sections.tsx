// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Meadow editorial section primitives — the shared building blocks the
// marketing pages compose (For Users, For Creators, …): alternating tinted
// section bands, the eyebrow/heading/lede rhythm, and the rounded card. Fraunces
// display serif over the airy layout. Page-specific pieces (signpost cards, gate
// rows, media cards, …) stay in their pages; these five are the common ones.

import { FONTS } from "../../styles/fonts";

const serif = { fontFamily: FONTS.fraunces };

/** A full-width band: `tint` paints the alternating bg-base-200/70 surface. */
export function Section({ children, tint }: { children: React.ReactNode; tint?: boolean }) {
	return (
		<section className={tint ? "bg-base-200/70" : ""}>
			<div className="mx-auto max-w-6xl px-6 py-24 text-center">{children}</div>
		</section>
	);
}

/** Small uppercase primary label above a heading. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
	return (
		<p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-primary/80">
			{children}
		</p>
	);
}

/** The section heading — light-weight Fraunces display serif. */
export function H2({ children }: { children: React.ReactNode }) {
	return (
		<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
			{children}
		</h2>
	);
}

/** The intro paragraph under a heading. */
export function Lede({ children }: { children: React.ReactNode }) {
	return (
		<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/65">
			{children}
		</p>
	);
}

/** A rounded surface card. `className` appends (e.g. widths, overflow, `!p-0`). */
export function Card({
	children,
	className = "",
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={`rounded-3xl border border-base-content/10 bg-base-100 p-7 shadow-sm ${className}`}
		>
			{children}
		</div>
	);
}
