// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A Badge — Anthers' own and every creator's, drawn by one component.
 *
 * ⭐ **Two layers, like a patch with artwork sewn onto it** (Parker, 2026-08-29). The
 * **background** is the badge: a shape and a color, and its silhouette is the badge's
 * silhouette. The **foreground** sits on it and is cropped by it. There is no third layer
 * and no separate frame — an outer frame with an inner shape gives one object two competing
 * outlines, which is what the first cut of this did.
 *
 * ⚠️ **`frame-round` and the `wreath-*` set are still in `@anthers/brand` and belong to
 * nothing here.** They are decorative assets other surfaces may use; a Badge does not wear
 * one, and reaching for them to "frame" a badge is how this grows a second outline again.
 *
 * ⭐ **Anthers' Root/Sprout/Petal/Blossom render through here too, and that is the point.**
 * The symmetry between the two ladders is most of why the support model reads cleanly, and
 * the strongest way to keep two things looking like one kind of object is for them to be one
 * component. Anthers' foreground is an emoji; a creator's is a library emblem or their own
 * art. Nothing else differs.
 */

import type { BrandIconName } from "@anthers/brand";
import { BADGE_EDGE, BADGE_EDGE_WIDTH, badgeColor, badgeShape } from "@anthers/shared/badge-art";
import type { ReactNode } from "react";
import { BrandGlyph } from "../decor/BrandGlyph";

export function BadgeMark({
	shape,
	color,
	label,
	emoji,
	emblem,
	imageSrc,
	onImageError,
	clipId,
	dim = false,
	size = "h-12 w-12",
}: {
	/** A shape id from `@anthers/shared/badge-art`; anything unknown falls back. */
	shape?: string | null;
	/** A color id from the same library. */
	color?: string | null;
	/** Named for a screen reader; the layers themselves are decorative. */
	label: string;
	/** Anthers' badges put an emoji on the patch. */
	emoji?: string;
	/** A creator without their own art puts a library emblem on it. */
	emblem?: string | null;
	/** A creator with their own art puts that on it, cropped to the shape. */
	imageSrc?: string | null;
	onImageError?: () => void;
	/** Must be unique on the page — an SVG clip path is referenced by id. */
	clipId: string;
	/** Rendered unselected, for a ladder showing what has not been reached. */
	dim?: boolean;
	size?: string;
}): ReactNode {
	const s = badgeShape(shape);
	const c = badgeColor(color);

	return (
		<span
			className={`relative flex ${size} shrink-0 items-center justify-center ${dim ? "opacity-45" : ""}`}
			role="img"
			aria-label={label}
		>
			<svg viewBox="0 0 100 100" aria-hidden="true" className="absolute inset-0 h-full w-full">
				<title>{label}</title>
				<defs>
					{/* Normalized, so the same path crops a foreground of any size — which is
					    what makes the background's shape the mask rather than a decoration
					    that happens to sit behind one. */}
					<clipPath id={clipId} clipPathUnits="objectBoundingBox">
						<path d={s.path} transform="scale(0.01)" />
					</clipPath>
					<clipPath id={`${clipId}-edge`}>
						<path d={s.path} />
					</clipPath>
				</defs>
				{/* ⭐ The edging is a CONSTANT and the field is the creator's, which is the
				    scout-badge property: a set reads as a set because every patch is bound in
				    the same stitching, not because the fields agree. Clipping the stroke to
				    its own path paints it inward, so the badge's silhouette stays exactly the
				    shape rather than growing by half a stroke. */}
				<g clipPath={`url(#${clipId}-edge)`}>
					<path
						d={s.path}
						fill={c.fill}
						stroke={BADGE_EDGE}
						strokeWidth={BADGE_EDGE_WIDTH * 2}
						strokeLinejoin="round"
					/>
				</g>
			</svg>

			{imageSrc ? (
				// Sits ON the field with the edging showing all round it, the way artwork is
				// sewn onto a patch rather than printed to its edge — and cropped by the same
				// shape, so a rectangular upload takes the badge's outline.
				<img
					src={imageSrc}
					alt=""
					aria-hidden="true"
					onError={onImageError}
					className="absolute inset-[17%] h-[66%] w-[66%] object-cover"
					style={{ clipPath: `url(#${clipId})` }}
				/>
			) : emoji ? (
				<span aria-hidden="true" className="relative text-[46%] leading-none">
					{emoji}
				</span>
			) : emblem ? (
				<BrandGlyph
					name={emblem as BrandIconName}
					className="relative h-[48%] w-[48%]"
					style={{ color: c.on }}
				/>
			) : null}
		</span>
	);
}
