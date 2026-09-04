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
 * ⭐ **The foreground is placed by the shape's own boxes rather than by a fixed fraction of
 * the badge.** `emblemBox` is the largest square that clears the edging and `artBox` is the
 * roomier one an upload gets for being cropped to the silhouette, both stated in the same
 * 0-100 viewBox units as the paths — so a triangle's emblem lands low and small while a
 * circle's fills the field, and every foreground scales with the badge from a chip to a
 * patch. Adding a shape means measuring it once in `@anthers/shared/badge-art`; nothing
 * here needs to know which shape it is drawing.
 *
 * ⭐ **Anthers' Root/Sprout/Petal/Blossom render through here too, and that is the point.**
 * The symmetry between the two ladders is most of why the support model reads cleanly, and
 * the strongest way to keep two things looking like one kind of object is for them to be one
 * component. Anthers' foreground is an emoji; a creator's is a library emblem or their own
 * art. Nothing else differs.
 */

import type { BrandIconName } from "@anthers/brand";
import {
	BADGE_EDGE,
	BADGE_EDGE_WIDTH,
	badgeBoxStyle,
	badgeColor,
	badgeShape,
} from "@anthers/shared/badge-art";
import type { ReactNode } from "react";
import { BrandGlyph } from "../decor/BrandGlyph";

/**
 * What to multiply `emblemBox.size` by to get an emoji's font-size.
 *
 * ⚠️ **An emoji draws WIDER than its font-size, so the box size cannot be used directly.**
 * Measured in Chromium: every emoji in the ladder renders 1.25× its font-size across and
 * 1.18× down, so 0.8 is the factor that lands the glyph exactly on the box's width — the
 * binding dimension. Without it the glyph runs a quarter of its width into the stitching.
 *
 * The exact ratio is a property of whichever emoji font the viewer has, and the ones in
 * circulation sit between about 1.16 and 1.25 — so this errs a little small on macOS rather
 * than colliding with the edging anywhere.
 */
const EMOJI_FONT_SIZE = 0.8;

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

	// One foreground, and an upload wins because it is the creator's own art. The emblem is
	// the fallback the ladder editor always supplies, so testing it last is what keeps a
	// creator's upload from being drawn under their default.
	const showImage = Boolean(imageSrc);
	const showEmoji = !showImage && Boolean(emoji);
	const showEmblem = !showImage && !showEmoji && Boolean(emblem);

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
				{/* ⭐ Anthers' emoji is drawn INSIDE the SVG, in the same viewBox units as the
				    shape and its box. That is the only way a glyph scales with the badge: a
				    `font-size` given as a percentage is a share of the inherited font, so an
				    emoji laid over the badge as HTML text drew at one fixed size forever. In
				    viewBox units the number means what it says.
				    ⚠️ `fill` matters only when the emoji font is missing, which is the state a
				    bare Linux CI container is in — it keeps the fallback glyph readable rather
				    than black on a dark field. */}
				{showEmoji ? (
					<text
						x={s.emblemBox.x + s.emblemBox.size / 2}
						y={s.emblemBox.y + s.emblemBox.size / 2}
						textAnchor="middle"
						dominantBaseline="central"
						fontSize={s.emblemBox.size * EMOJI_FONT_SIZE}
						fill={c.on}
					>
						{emoji}
					</text>
				) : null}
			</svg>

			{showImage ? (
				// Sits ON the field with the edging showing all round it, the way artwork is
				// sewn onto a patch rather than printed to its edge — and cropped by the same
				// shape, so a rectangular upload takes the badge's outline. `artBox` is the
				// roomier of the two boxes precisely because of that cropping.
				<img
					src={imageSrc ?? undefined}
					alt=""
					aria-hidden="true"
					onError={onImageError}
					className="absolute object-cover"
					style={{ ...badgeBoxStyle(s.artBox), clipPath: `url(#${clipId})` }}
				/>
			) : showEmblem ? (
				// `.brand-glyph` masks at `mask-size: contain`, so the emblem fits itself into
				// the box on its own longest side and keeps its proportions. That is what lets
				// an emblem of any aspect — ours or one a creator picks later — drop into this
				// without a per-emblem correction.
				<BrandGlyph
					name={emblem as BrandIconName}
					className="absolute"
					style={{ ...badgeBoxStyle(s.emblemBox), color: c.on }}
				/>
			) : null}
		</span>
	);
}
