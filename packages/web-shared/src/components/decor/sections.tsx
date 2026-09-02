// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Meadow editorial section primitives — the shared building blocks the
// marketing pages compose (For Users, For Creators, …): alternating tinted
// section bands, the eyebrow/heading/lede rhythm, the rounded card, and the
// two-tone signpost card that presents the support model's two directions.
// Fraunces display serif over the airy layout. Page-specific pieces (gate rows,
// media cards, …) stay in their pages; these six are the common ones.

import { FONTS } from "../../styles/fonts";

const serif = { fontFamily: FONTS.fraunces };

/**
 * A full-width band: `tint` paints the alternating bg-base-200/70 surface.
 *
 * **The rhythm is the point, and it is a whole-page property rather than a per-section
 * one.** A marketing page is a vertical stack of these alternating tinted/plain, with the
 * hero and the closing band each tinted so the page reads as bookended. The canonical For
 * Users order is hero (tint) → how it works → free use (tint) → support → purchases (tint)
 * → Badges → closing (tint) → footer. Add a section in the middle and the alternation has
 * to be re-checked from there down; two tinted bands touching is the tell.
 *
 * The footer is deliberately transparent and compact so it sits directly on the grassy
 * floor decor, contrasting with the tinted closing band above it.
 */
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
		<p className="text-justify [text-align-last:center] mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/65">
			{children}
		</p>
	);
}

/** A signpost card for the support model's two directions. `tone` tints the card in
 *  the same color language as the two Subscribe cards — amber for backing the Anthers
 *  commons, green for backing a creator — via a colored border, a soft wash, the
 *  numbered chip, and the list bullets. `step` is optional (omit for an unnumbered pair). */
export function SignpostCard({
	step,
	title,
	tone,
	children,
}: {
	step?: string;
	title: React.ReactNode;
	tone: "anthers" | "creator";
	children: React.ReactNode;
}) {
	const t =
		tone === "anthers"
			? {
					card: "border-accent/30 bg-accent/10",
					chip: "bg-accent/15 text-accent",
					marker: "marker:text-accent/70",
				}
			: {
					card: "border-primary/25 bg-primary/5",
					chip: "bg-primary/10 text-primary",
					marker: "marker:text-primary/70",
				};
	return (
		<div className={`card-lift flex h-full flex-col rounded-3xl border-2 p-7 shadow-sm ${t.card}`}>
			{step && (
				<div
					style={serif}
					className={`mb-4 flex h-11 w-11 items-center justify-center rounded-full text-xl font-semibold ${t.chip}`}
				>
					{step}
				</div>
			)}
			<h3 style={serif} className="mb-2 text-xl font-medium">
				{title}
			</h3>
			<div
				className={`text-sm leading-relaxed text-base-content/70 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 ${t.marker}`}
			>
				{children}
			</div>
		</div>
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
