// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A creator's Badge — Anthers' frame, a background the creator chose, and a foreground that
 * is either the library's or their own.
 *
 * ⭐ **Three layers, and the middle one is what makes this flexible without being
 * inconsistent** (Parker, 2026-08-29). Anthers' own Root/Sprout/Petal/Blossom already
 * render one round botanical frame with an emblem inside it; a creator's rung wears the
 * same frame, over a **shape and color they picked from the standard library**, under a
 * foreground that is either another piece of that library or art they uploaded. A creator
 * who does not draw still gets a badge that is recognizably theirs, because shape, color
 * and emblem are three choices rather than one upload they cannot make — and a creator who
 * does draw puts their art on a consistent ground instead of inventing the whole object.
 *
 * ⚠️ **The library is `@anthers/shared/badge-art` and this component only renders it.** The
 * API validates a creator's choices against the same lists, so a shape the server would
 * refuse cannot be offered here and an id the browser cannot draw cannot be stored.
 *
 * ⚠️ **The default is drawn rather than served.** A default served as bytes would be a
 * raster of something the brand package renders as recolor-ready SVG, and it would go stale
 * the moment the palette moved. The art route 404s for a rung with no upload, and this
 * falls back — so a creator who has uploaded nothing still gets a mark that belongs beside
 * Anthers' own rather than an empty circle.
 */

import type { BrandIconName } from "@anthers/brand";
import { badgeColor, badgeShape, defaultBadgeEmblem } from "@anthers/shared/badge-art";
import { useState } from "react";
import { apiBaseUrl } from "../../lib/rpc";
import { BrandGlyph } from "../decor/BrandGlyph";

export interface BadgeArtChoice {
	/** A shape id from the library; null draws the default. */
	artShape?: string | null;
	/** A color id from the library; null draws the default. */
	artColor?: string | null;
	/** A library emblem for the foreground; ignored when the creator uploaded art. */
	artEmblem?: string | null;
	/** Whether the creator has their own art. False draws the emblem without a request. */
	hasArt?: boolean;
}

export function CreatorBadgeMark({
	gateId,
	index,
	label,
	art,
	lit = true,
	size = "h-12 w-12",
}: {
	gateId: number;
	/** The rung's position on this creator's ladder, for the default emblem. */
	index: number;
	/** Named for a screen reader; the layers themselves are decorative. */
	label: string;
	art: BadgeArtChoice;
	lit?: boolean;
	size?: string;
}) {
	// A row can name art that storage no longer has, and the route 404s for it. Falling
	// back on error rather than trusting the flag means a badge is never a broken image.
	const [failed, setFailed] = useState(false);
	const shape = badgeShape(art.artShape);
	const color = badgeColor(art.artColor);
	const emblem = (art.artEmblem ?? defaultBadgeEmblem(index)) as BrandIconName;
	const showUpload = Boolean(art.hasArt) && !failed;

	return (
		<span
			className={`relative flex ${size} shrink-0 items-center justify-center`}
			role="img"
			aria-label={label}
		>
			{/* The background: the creator's shape, in the creator's color. Clipped so an
			    uploaded photograph takes the shape rather than sitting square inside it. */}
			<svg
				viewBox="0 0 100 100"
				aria-hidden="true"
				className="absolute inset-[14%] h-[72%] w-[72%]"
			>
				<title>{label}</title>
				<defs>
					<clipPath id={`badge-clip-${gateId}`} clipPathUnits="objectBoundingBox">
						{/* Normalized so the same path can clip an <img> of any size. */}
						<path d={shape.path} transform="scale(0.01)" />
					</clipPath>
				</defs>
				<path d={shape.path} fill={color.fill} />
			</svg>

			{showUpload ? (
				// 🚨 Rooted on `apiBaseUrl()` rather than written as `/api/...`. The web app and
				// the API are not always the same origin — the Studio subdomain, the desktop
				// shell, and the e2e preview all separate them — and a root-relative src asks
				// the page's own host, gets HTML or a 404, and silently falls back to the
				// emblem. Found in the browser; nothing else could have.
				<img
					src={`${apiBaseUrl()}/api/subscriptions/gates/${gateId}/art`}
					alt=""
					aria-hidden="true"
					onError={() => setFailed(true)}
					className="absolute inset-[14%] h-[72%] w-[72%] object-cover"
					style={{ clipPath: `url(#badge-clip-${gateId})` }}
				/>
			) : (
				<BrandGlyph
					name={emblem}
					className="relative h-[38%] w-[38%]"
					style={{ color: color.on }}
				/>
			)}

			{/* Anthers' frame, over everything, so both ladders read as one collection. */}
			<BrandGlyph
				name="frame-round"
				className={`absolute inset-0 h-full w-full ${lit ? "text-primary/70" : "text-primary/30"}`}
			/>
		</span>
	);
}
